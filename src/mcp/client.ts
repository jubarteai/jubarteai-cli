// The only module that sends a key to /api/mcp (spec §8 I1, I2). The origin comes from the resolved
// seat and nothing else, a redirect is never followed (it would carry the key to another host), and
// nothing built from a response body or a header ever reaches an error message.
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import {
  MCP_AUTH_BODY_MAX_BYTES,
  MCP_MAX_RESPONSE_BYTES,
  MCP_PATH,
  MCP_SERVER_TEXT_MAX_CHARS,
  MCP_TIMEOUT_MS,
  cliVersion,
} from "../constants.js";
import { redactSecrets, transportErrorEnvelope } from "../output.js";
import { normalizeOrigin } from "../process-env.js";

export type Envelope = { messages: unknown[]; result?: unknown; error?: string; code?: string };
export type CallOutcome = { envelope: Envelope; exitCode: 0 | 1 | 3 | 4 | 5 };

// The size and length caps live in constants.ts; this re-export keeps client.test.ts's import working.
export { MCP_MAX_RESPONSE_BYTES };

const RPC_ID = 1;

const AUTH_MESSAGES: Readonly<Record<string, string>> = {
  invalid_api_key: "API key not recognized. Run: jubarteai login",
  revoked_api_key: "This API key has been revoked. Run: jubarteai login",
  seat_canceled:
    "Your workspace seat is no longer active. The workspace owner may have removed your access or downgraded the plan.",
  billing_inactive: "The workspace is past due or canceled. The owner can restore billing from Company → Billing in the dashboard.",
  unauthorized: "The server did not accept this key. Run: jubarteai login",
  forbidden: "The server refused this request.",
};

const NETWORK_MESSAGES = {
  network_error: "Could not reach the JubarteAI server. Check your connection and retry.",
  timeout: "The JubarteAI server took too long to answer. Retry in a moment.",
  server_error: "The JubarteAI server had a temporary error. Retry in a moment.",
  aborted: "The request was canceled.",
  invalid_origin: "The saved server address for this login is not usable. Run: jubarteai login",
  bad_response: "The server sent a response this version of jubarteai can't read. Retry, or update jubarteai.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(exitCode: 3 | 4 | 5, code: string, message: string): CallOutcome {
  return { envelope: transportErrorEnvelope(code, message), exitCode };
}

function networkFailure(code: keyof typeof NETWORK_MESSAGES): CallOutcome {
  return failure(4, code, NETWORK_MESSAGES[code]);
}

/** Text the server wrote, made safe to print: secrets redacted and cut to a sane length. */
function serverText(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MCP_SERVER_TEXT_MAX_CHARS ? `${redacted.slice(0, MCP_SERVER_TEXT_MAX_CHARS)}…` : redacted;
}

/** The body as text, or null when it is larger than `max` (the rest is not read). */
export async function readCapped(response: Response, max: number): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The first JSON-RPC message in a `text/event-stream` body that carries a result or an error. */
function firstSseMessage(text: string): unknown {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      const message = JSON.parse(data) as unknown;
      if (isRecord(message) && ("result" in message || "error" in message)) return message;
    } catch {
      // Not a JSON event (a comment or keep-alive): keep looking.
    }
  }
  return undefined;
}

function envelopeOutcome(parsed: Record<string, unknown>, isError: boolean): CallOutcome {
  const { messages, ...rest } = parsed;
  const envelope: Envelope = { messages: Array.isArray(messages) ? messages : [], ...rest };
  const error = rest["error"];
  if (error !== undefined && error !== null) {
    envelope.error = serverText(typeof error === "string" ? error : JSON.stringify(error));
    return { envelope, exitCode: 1 };
  }
  delete envelope.error;
  if (isError) {
    envelope.error = "The tool reported an error.";
    return { envelope, exitCode: 1 };
  }
  return { envelope, exitCode: 0 };
}

/** Turns one JSON-RPC message into the envelope the CLI prints. */
function outcomeFromRpc(message: unknown): CallOutcome {
  if (!isRecord(message)) return networkFailure("bad_response");
  const rpcError = message["error"];
  if (isRecord(rpcError)) {
    const text = typeof rpcError["message"] === "string" ? rpcError["message"] : "";
    return {
      envelope: { messages: [], error: text === "" ? "The server rejected the request." : serverText(text), code: "rpc_error" },
      exitCode: 1,
    };
  }
  const result = message["result"];
  if (!isRecord(result) || !Array.isArray(result["content"])) return networkFailure("bad_response");
  const block = result["content"].find(
    (candidate): candidate is { type: "text"; text: string } =>
      isRecord(candidate) && candidate["type"] === "text" && typeof candidate["text"] === "string",
  );
  if (block === undefined) return networkFailure("bad_response");
  const isError = result["isError"] === true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) return envelopeOutcome(parsed, isError);
  // The SDK's own validation errors are plain text with isError set.
  if (isError) return { envelope: { messages: [], error: serverText(block.text), code: "tool_error" }, exitCode: 1 };
  return networkFailure("bad_response");
}

/** A 401/402/403: one fixed message per code the server defines; the code itself is the server's. */
async function authOutcome(response: Response): Promise<CallOutcome> {
  let code: string | null = null;
  try {
    const text = await readCapped(response, MCP_AUTH_BODY_MAX_BYTES);
    const body = text === null ? undefined : (JSON.parse(text) as unknown);
    const candidate = isRecord(body) ? body["error"] : undefined;
    if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) code = candidate;
  } catch {
    // An unreadable body only means we fall back to the status.
  }
  const fallback = response.status === 401 ? "unauthorized" : response.status === 402 ? "billing_inactive" : "forbidden";
  const finalCode = code ?? fallback;
  const message = Object.hasOwn(AUTH_MESSAGES, finalCode) ? AUTH_MESSAGES[finalCode] : AUTH_MESSAGES[fallback];
  return failure(3, finalCode, message ?? "The server refused this request.");
}

/**
 * Calls one MCP tool (`tools/call`, stateless JSON-RPC, no initialize) and returns the envelope to
 * print plus the exit code: 0 a result, 1 the server's own `error`, 3 an auth refusal (401/402/403),
 * 4 network, timeout or a 5xx. Never throws for a server, network or parse problem, and never retries
 * (a write may already have landed; the caller decides).
 */
export async function callTool(
  seat: Pick<ResolvedSeat, "origin" | "token">,
  tool: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CallOutcome> {
  const origin = normalizeOrigin(seat.origin);
  // Not a network problem: the saved login is unusable, so the answer is "log in again" (exit 5).
  if (origin === null) return failure(5, "invalid_origin", NETWORK_MESSAGES.invalid_origin);

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? MCP_TIMEOUT_MS);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  const interrupted = (): CallOutcome => networkFailure(timeout.aborted ? "timeout" : opts.signal?.aborted === true ? "aborted" : "network_error");

  try {
    const response = await fetch(new URL(MCP_PATH, origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seat.token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": `jubarteai-cli/${cliVersion()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: RPC_ID, method: "tools/call", params: { name: tool, arguments: args } }),
      redirect: "error",
      signal,
    });

    if (response.status === 401 || response.status === 402 || response.status === 403) return await authOutcome(response);
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return networkFailure("server_error");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failure(4, "http_error", `The server answered with an unexpected status (HTTP ${response.status}).`);
    }

    const text = await readCapped(response, MCP_MAX_RESPONSE_BYTES);
    if (text === null) return networkFailure("bad_response");
    if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
      return outcomeFromRpc(firstSseMessage(text));
    }
    let message: unknown;
    try {
      message = JSON.parse(text) as unknown;
    } catch {
      return networkFailure("bad_response");
    }
    return outcomeFromRpc(message);
  } catch {
    // Whatever was thrown (a refused redirect, a reset, a bad header value) may quote the request; say nothing of it.
    return interrupted();
  }
}
