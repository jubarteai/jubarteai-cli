// The renewal call of a session watch: POST <watch url>/extend moves the live watch's expiry without
// rotating its token (server contract: docs/cli.md "Inbox watch renewal" in the app repo). The token is
// sent to the seat's own origin and never returned, printed or put in an error.
import { INBOX_EXTEND_SUFFIX, INBOX_EXTEND_TIMEOUT_MS, INBOX_POLL_BODY_MAX_BYTES } from "../constants.js";
import { readCapped } from "../mcp/client.js";

export type ExtendResult =
  /** The watch now ends at `expiresAtMs`; the same token keeps working. */
  | { kind: "extended"; expiresAtMs: number }
  /** The server has no such endpoint (an older one answers 404): keep watching to the original expiry. */
  | { kind: "unsupported" }
  | { kind: "stopped"; reason: "invalid_or_expired_watch" | "agent_disconnected" }
  /** A 5xx, an unexpected status, or a body that isn't the contract's: retry, never wake the agent. */
  | { kind: "server" }
  /** The request never completed (network down, DNS, timeout) or `stop` aborted it. */
  | { kind: "network" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The extend address for a watch address: the same URL with `/extend` appended to its path. */
export function extendUrlFor(watchUrl: URL): URL {
  const url = new URL(watchUrl.href);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${INBOX_EXTEND_SUFFIX}`;
  return url;
}

export async function extendWatch(
  watchUrl: URL,
  token: string,
  minutes: number,
  stop: AbortSignal,
  timeoutMs: number = INBOX_EXTEND_TIMEOUT_MS,
): Promise<ExtendResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]);
  try {
    const response = await fetch(extendUrlFor(watchUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
      redirect: "error",
      signal,
    });
    // An older server's 404 is a platform or framework page of any shape: the status alone says "no such route".
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "unsupported" };
    }
    const text = await readCapped(response, INBOX_POLL_BODY_MAX_BYTES);
    let body: unknown;
    try {
      body = text === null ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    const field = (name: string): unknown => (isRecord(body) ? body[name] : undefined);
    // Only an exact answer ends the watch, so a platform error page or a 5xx never costs the agent a turn.
    if (response.status === 401 && field("error") === "invalid_or_expired_watch") return { kind: "stopped", reason: "invalid_or_expired_watch" };
    if (response.status === 410 && field("error") === "agent_disconnected") return { kind: "stopped", reason: "agent_disconnected" };
    const expiresAt = field("expires_at");
    if (response.status === 200 && typeof expiresAt === "string") {
      const ms = Date.parse(expiresAt);
      if (!Number.isNaN(ms)) return { kind: "extended", expiresAtMs: ms };
    }
    return { kind: "server" };
  } catch {
    return { kind: "network" };
  }
}
