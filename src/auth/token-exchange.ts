import { CliError, ExitCode } from "../errors.js";
import { normalizeOrigin } from "../process-env.js";

// POST <origin>/api/cli/token: the only place a `jbc_` code is sent (spec section 7.2), and the shared
// HTTP helper for the two auth endpoints. Responses are untrusted: bodies are size-capped, parsed
// defensively and never echoed into a message.

/** A one-time login code: `jbc_` + 43 base64url characters. */
export const AUTH_CODE_RE = /^jbc_[A-Za-z0-9_-]{43}$/;

/** A JubarteAI key as the server accepts it for `replaces` and whoami. */
export const API_KEY_RE = /^jba_[A-Za-z0-9_-]{8,128}$/;

const RESPONSE_MAX_BYTES = 64 * 1024;
const EXCHANGE_TIMEOUT_MS = 20_000;
const FIELD_MAX = 512;

export type TokenResponse = {
  token: string;
  key: { id: string; prefix: string; name: string };
  seat_id: string;
  /** `email` is null when the server's post-mint lookups failed; the caller fills it from whoami. */
  user: { id: string; email: string | null };
  company: { id: string; slug: string | null; name: string | null };
  replaced: boolean;
};

export type HttpResult = { status: number; json: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string of at most FIELD_MAX characters, else null. */
export function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= FIELD_MAX ? value : null;
}

/** The server's `error` code when it has a plain snake_case shape, else null. Never free text. */
export function errorCodeOf(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const code = json["error"];
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : null;
}

async function readCapped(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function unreachable(origin: string, cause: "timeout" | "network"): CliError {
  return new CliError(
    `Couldn't reach JubarteAI at ${origin} (${cause === "timeout" ? "timed out" : "network error"}). Check your connection and try again.`,
    ExitCode.NETWORK,
    cause === "timeout" ? "timeout" : "network_error",
  );
}

/**
 * One JSON request to `<origin><path>`. A redirect is never followed (the request may carry a key),
 * a body over 64 KB or that isn't JSON comes back as `json: null`, and a failure to connect is a
 * fixed exit-4 error that names the origin only.
 */
export async function authRequest(
  origin: string,
  path: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<HttpResult> {
  const base = normalizeOrigin(origin);
  if (base === null) {
    throw new CliError("The JubarteAI origin is not valid.", ExitCode.USAGE, "invalid_origin");
  }
  let response: Response;
  let text: string | null;
  try {
    response = await fetch(new URL(path, base), {
      method: init.method,
      headers: { Accept: "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    text = await readCapped(response);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw unreachable(base, timedOut ? "timeout" : "network");
  }
  if (text === null || text === "") return { status: response.status, json: null };
  try {
    return { status: response.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, json: null };
  }
}

function unexpected(): CliError {
  return new CliError("JubarteAI sent an unexpected response. Run jubarteai login again.", ExitCode.SERVER_ERROR, "unexpected_response");
}

/** `null` stays null (a lookup that failed server-side); any other non-string is malformed (undefined). */
function nullableText(value: unknown, opts: { allowEmpty: boolean }): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > FIELD_MAX) return undefined;
  return value.length === 0 && !opts.allowEmpty ? undefined : value;
}

function parseTokenResponse(json: unknown): TokenResponse {
  if (!isRecord(json)) throw unexpected();
  const token = json["token"];
  const key = json["key"];
  const user = json["user"];
  const company = json["company"];
  const seatId = textField(json["seat_id"]);
  if (typeof token !== "string" || !API_KEY_RE.test(token)) throw unexpected();
  if (!isRecord(key) || !isRecord(user) || !isRecord(company) || seatId === null) throw unexpected();
  const keyId = textField(key["id"]);
  const prefix = textField(key["prefix"]);
  const keyName = typeof key["name"] === "string" && key["name"].length <= FIELD_MAX ? key["name"] : null;
  const userId = textField(user["id"]);
  const email = nullableText(user["email"], { allowEmpty: false });
  const companyId = textField(company["id"]);
  const slug = nullableText(company["slug"], { allowEmpty: false });
  const name = nullableText(company["name"], { allowEmpty: true });
  if (keyId === null || prefix === null || keyName === null || userId === null || companyId === null) throw unexpected();
  if (email === undefined || slug === undefined || name === undefined) throw unexpected();
  if (typeof json["replaced"] !== "boolean") throw unexpected();
  return {
    token,
    key: { id: keyId, prefix, name: keyName },
    seat_id: seatId,
    user: { id: userId, email },
    company: { id: companyId, slug, name },
    replaced: json["replaced"],
  };
}

function failureFor(status: number, code: string | null): CliError {
  if (status === 400 && code === "invalid_grant") {
    return new CliError("This sign-in code is invalid, expired or already used. Run jubarteai login again.", ExitCode.SERVER_ERROR, "invalid_grant");
  }
  if (status === 400) {
    return new CliError("JubarteAI didn't accept the sign-in request. Run jubarteai login again.", ExitCode.SERVER_ERROR, "invalid_request");
  }
  if (status === 402) {
    return new CliError("This workspace's billing is inactive, so a key can't be created for it.", ExitCode.AUTH, "billing_inactive");
  }
  if (status === 403) {
    return new CliError("Your seat in that workspace is no longer active.", ExitCode.AUTH, "seat_inactive");
  }
  if (status >= 500) {
    // The code is burned by any attempt; a key may exist even though the answer never arrived.
    return new CliError(
      "JubarteAI had a problem finishing the sign-in. Run jubarteai login again; if a key named \"CLI · …\" appears in Dashboard → API keys, you can revoke it.",
      ExitCode.NETWORK,
      "server_error",
    );
  }
  return unexpected();
}

/**
 * Trades a login code (and the PKCE verifier) for a key. `replaces` is a previously CLI-minted key for
 * the same seat, which the server revokes; null otherwise. A single attempt: the server burns the code
 * on any try, so a retry could only fail.
 */
export async function exchangeCode(
  origin: string,
  body: { code: string; code_verifier: string; replaces: string | null },
): Promise<TokenResponse> {
  const result = await authRequest(origin, "/api/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: body.code, code_verifier: body.code_verifier, replaces: body.replaces }),
    timeoutMs: EXCHANGE_TIMEOUT_MS,
  });
  if (result.status === 200) return parseTokenResponse(result.json);
  throw failureFor(result.status, errorCodeOf(result.json));
}
