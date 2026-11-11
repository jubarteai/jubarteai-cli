import { CliError, ExitCode } from "../errors.js";
import { authRequest, errorCodeOf, isRecord, textField } from "./token-exchange.js";

// GET <origin>/api/cli/whoami: the only place a key is sent by the auth flow (spec section 7.3).
// Never prints or logs the key; every failure is fixed copy.

const WHOAMI_TIMEOUT_MS = 10_000;

export type WhoamiResponse = {
  seat_id: string;
  /** `email` can be null when the server could not look it up. */
  user: { id: string; email: string | null };
  company: { id: string; slug: string; name: string };
  key: { id: string; prefix: string; name: string; minted_by: string };
};

function unexpected(): CliError {
  return new CliError("JubarteAI sent an unexpected response.", ExitCode.SERVER_ERROR, "unexpected_response");
}

function parseWhoami(json: unknown): WhoamiResponse {
  if (!isRecord(json)) throw unexpected();
  const user = json["user"];
  const company = json["company"];
  const key = json["key"];
  const seatId = textField(json["seat_id"]);
  if (seatId === null || !isRecord(user) || !isRecord(company) || !isRecord(key)) throw unexpected();
  const userId = textField(user["id"]);
  const email = user["email"] === null ? null : textField(user["email"]);
  const companyId = textField(company["id"]);
  const slug = textField(company["slug"]);
  const name = typeof company["name"] === "string" && company["name"].length <= 512 ? company["name"] : null;
  const keyId = textField(key["id"]);
  const prefix = textField(key["prefix"]);
  const keyName = typeof key["name"] === "string" && key["name"].length <= 512 ? key["name"] : null;
  const mintedBy = textField(key["minted_by"]);
  if (userId === null || companyId === null || slug === null || name === null) throw unexpected();
  if (keyId === null || prefix === null || keyName === null || mintedBy === null) throw unexpected();
  if (user["email"] !== null && email === null) throw unexpected();
  return {
    seat_id: seatId,
    user: { id: userId, email },
    company: { id: companyId, slug, name },
    key: { id: keyId, prefix, name: keyName, minted_by: mintedBy },
  };
}

function failureFor(status: number, code: string | null): CliError {
  if (status === 401) {
    return new CliError("That key was not accepted: it is invalid or has been revoked.", ExitCode.AUTH, code ?? "invalid_api_key");
  }
  if (status === 402) {
    return new CliError("This workspace's billing is inactive.", ExitCode.AUTH, "billing_inactive");
  }
  if (status === 403) {
    return new CliError("The seat this key belongs to is no longer active.", ExitCode.AUTH, "seat_canceled");
  }
  if (status >= 500) {
    return new CliError("JubarteAI had a temporary problem. Try again in a moment.", ExitCode.NETWORK, "server_error");
  }
  return unexpected();
}

/** Who a key belongs to: its seat, user, workspace and key record. Throws a CliError (3 auth, 4 network, 1 other). */
export async function whoami(origin: string, token: string, opts: { timeoutMs?: number } = {}): Promise<WhoamiResponse> {
  const result = await authRequest(origin, "/api/cli/whoami", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: opts.timeoutMs ?? WHOAMI_TIMEOUT_MS,
  });
  if (result.status === 200) return parseWhoami(result.json);
  throw failureFor(result.status, errorCodeOf(result.json));
}
