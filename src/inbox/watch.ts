// The inbox watch loop (spec §5.4): long-poll the server's inbox-watch endpoint until a message is pending, the
// server says to stop, or the watch expires. `runWatchSession` is the same loop for a watcher that lives for a
// whole interactive session: it renews its watch through the extend endpoint shortly before it expires, so the
// agent isn't woken by every expiry, and it stops for good on a disconnect, a vanished parent or a 12 h limit.
// The watch token (`jbw_`) lives only in memory here: it is sent to the seat's own origin and never printed.
import {
  INBOX_EXPIRY_SLACK_MS,
  INBOX_MIN_POLL_MS,
  INBOX_MS_PER_MINUTE,
  INBOX_POLL_BODY_MAX_BYTES,
  INBOX_POLL_TIMEOUT_MS,
  INBOX_RENEW_AHEAD_MS,
  INBOX_RETRY_AFTER_NETWORK_MS,
  INBOX_RETRY_AFTER_SERVER_MS,
  INBOX_RETRY_JITTER,
} from "../constants.js";
import { readCapped } from "../mcp/client.js";
import { extendWatch } from "./extend.js";
import type { ExtendResult } from "./extend.js";
import { DEFAULT_PARENT_WATCH_DEPS, SESSION_MAX_MS } from "./guards.js";
import type { ParentWatchDeps } from "./guards.js";
import { DEFAULT_LOCK_DEPS } from "./lock.js";
import type { LockDeps } from "./lock.js";

export type WatchDeps = {
  now: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** After a 5xx, a non-JSON or empty body, or any answer that is not a wake-up or an empty poll. */
  retryAfterServerMs: number;
  /** After a request that never completed (network down, DNS, timeout). */
  retryAfterNetworkMs: number;
  /** An empty poll that came back sooner than this waits out the rest of it, so a misbehaving server can't make a spin loop. */
  minPollMs: number;
  /** Retry delays get up to this fraction added, so many watchers don't retry in step. */
  jitter: number;
  signals: Pick<NodeJS.Process, "on" | "off">;
  /** The environment the unattended-run guard and the parent watch read. */
  env: NodeJS.ProcessEnv;
  /** The per-agent watcher lock's file system, clock and process id. */
  lock: LockDeps;
  /** How a session watch notices that the process that started it is gone. */
  parent: ParentWatchDeps;
  /** A session watch's overall limit. */
  sessionMaxMs: number;
  /** A session watch renews this long before its expiry (or half its window, if shorter). */
  renewAheadMs: number;
  /** The renewal request (replaceable in tests). */
  extend: typeof extendWatch;
};

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export const DEFAULT_WATCH_DEPS: WatchDeps = {
  now: () => Date.now(),
  sleep: sleepUnlessAborted,
  retryAfterServerMs: INBOX_RETRY_AFTER_SERVER_MS,
  retryAfterNetworkMs: INBOX_RETRY_AFTER_NETWORK_MS,
  minPollMs: INBOX_MIN_POLL_MS,
  jitter: INBOX_RETRY_JITTER,
  signals: process,
  env: process.env,
  lock: DEFAULT_LOCK_DEPS,
  parent: DEFAULT_PARENT_WATCH_DEPS,
  sessionMaxMs: SESSION_MAX_MS,
  renewAheadMs: INBOX_RENEW_AHEAD_MS,
  extend: extendWatch,
};

/** What a watch ends with, as the `{"stopped":…}` line says it. */
export type StopReason =
  | "invalid_or_expired_watch"
  | "agent_disconnected"
  | "expired"
  | "session_limit"
  | "parent_gone"
  | "already_watching"
  | "unattended";

export type WatchResult = { kind: "pending"; pending: number } | { kind: "stopped"; reason: StopReason };

type Poll =
  | { kind: "pending"; pending: number }
  | { kind: "empty" }
  | { kind: "stopped"; reason: "invalid_or_expired_watch" | "agent_disconnected" }
  | { kind: "server" }
  | { kind: "network" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function pollOnce(url: URL, token: string, timeoutMs: number, stop: AbortSignal): Promise<Poll> {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    const text = await readCapped(response, INBOX_POLL_BODY_MAX_BYTES);
    let body: unknown;
    try {
      body = text === null ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    const field = (name: string): unknown => (isRecord(body) ? body[name] : undefined);
    // Only an exact answer wakes the agent, so a platform error page or a 5xx never costs it a turn.
    if (response.status === 401 && field("error") === "invalid_or_expired_watch") return { kind: "stopped", reason: "invalid_or_expired_watch" };
    if (response.status === 410 && field("error") === "agent_disconnected") return { kind: "stopped", reason: "agent_disconnected" };
    const pending = field("pending");
    if (response.status === 200 && typeof pending === "number" && Number.isInteger(pending) && pending >= 0) {
      return pending > 0 ? { kind: "pending", pending } : { kind: "empty" };
    }
    return { kind: "server" };
  } catch {
    return { kind: "network" };
  }
}

/**
 * Long-polls `url` until a message is pending, the server says to stop, `expiresAtMs` passes, or
 * `stop` aborts (which returns null). Sequential and bounded by the expiry: one request at a time,
 * the next only after the previous finished and its delay passed.
 */
export async function watchUntilDone(
  url: URL,
  token: string,
  expiresAtMs: number,
  deps: WatchDeps,
  stop: AbortSignal,
): Promise<WatchResult | null> {
  const wait = (ms: number): Promise<void> => deps.sleep(Math.min(ms, Math.max(0, expiresAtMs - deps.now())), stop);
  const jittered = (ms: number): number => ms * (1 + Math.random() * deps.jitter);
  for (;;) {
    if (stop.aborted) return null;
    const remaining = expiresAtMs - deps.now();
    if (remaining <= 0) return { kind: "stopped", reason: "expired" };
    const startedAt = deps.now();
    const poll = await pollOnce(url, token, Math.min(INBOX_POLL_TIMEOUT_MS, remaining), stop);
    if (stop.aborted) return null;
    switch (poll.kind) {
      case "pending":
      case "stopped":
        return poll;
      case "empty":
        await wait(deps.minPollMs - (deps.now() - startedAt));
        break;
      case "server":
        await wait(jittered(deps.retryAfterServerMs));
        break;
      case "network":
        // A request cut off by the expiry itself ends the watch at the top of the loop.
        if (deps.now() < expiresAtMs) await wait(jittered(deps.retryAfterNetworkMs));
        break;
    }
  }
}

/**
 * The same loop for a watch that outlives one expiry. The watch's own window (`minutes`) renews through
 * the extend endpoint `min(renewAheadMs, window / 2)` before it ends, as often as it takes; the renewal
 * keeps the token, so the poll in flight is never disturbed. A server without the endpoint (`unsupported`)
 * just means the watch runs to its original expiry and ends `expired`, exactly like a plain watch. Stops
 * with `session_limit` once `sessionMaxMs` has passed since `startedAtMs`; `stop` aborting returns null
 * (the caller says whether that was a signal or the parent going away).
 */
export async function runWatchSession(
  url: URL,
  token: string,
  initial: { expiresAtMs: number; minutes: number; startedAtMs: number },
  deps: WatchDeps,
  stop: AbortSignal,
): Promise<WatchResult | null> {
  const windowMs = initial.minutes * INBOX_MS_PER_MINUTE;
  const renewAheadMs = Math.min(deps.renewAheadMs, windowMs / 2);
  const sessionEndsAt = initial.startedAtMs + deps.sessionMaxMs;
  const jittered = (ms: number): number => ms * (1 + Math.random() * deps.jitter);
  let endsAt = initial.expiresAtMs;
  let renewable = true;
  // A server that answers an expiry nearer than the renewal lead would otherwise be asked again at once, in a
  // loop that never polls: after a renewal the next one waits at least one poll interval.
  let renewNotBefore = 0;

  for (;;) {
    if (stop.aborted) return null;
    const now = deps.now();
    if (now >= sessionEndsAt) return { kind: "stopped", reason: "session_limit" };
    if (now >= endsAt) return { kind: "stopped", reason: "expired" };

    const renewAt = Math.max(endsAt - renewAheadMs, renewNotBefore);
    if (renewable && now >= renewAt) {
      const renewed: ExtendResult = await deps.extend(url, token, initial.minutes, stop);
      if (stop.aborted) return null;
      switch (renewed.kind) {
        case "extended":
          // Trust the server's date, but never further out than the window we asked for.
          endsAt = Math.min(renewed.expiresAtMs, deps.now() + windowMs + INBOX_EXPIRY_SLACK_MS);
          renewNotBefore = deps.now() + deps.minPollMs;
          break;
        case "unsupported":
          renewable = false;
          break;
        case "stopped":
          return renewed;
        case "server":
        case "network":
          // Retried on the next turn of the loop, until the watch itself runs out.
          await deps.sleep(
            Math.min(jittered(renewed.kind === "server" ? deps.retryAfterServerMs : deps.retryAfterNetworkMs), Math.max(0, endsAt - deps.now())),
            stop,
          );
          break;
      }
      continue;
    }

    // Poll up to the next point that needs attention: the renewal, the expiry or the session limit.
    const boundary = Math.min(renewable ? Math.min(renewAt, endsAt) : endsAt, sessionEndsAt);
    const startedAt = deps.now();
    const poll = await pollOnce(url, token, Math.min(INBOX_POLL_TIMEOUT_MS, Math.max(1, boundary - startedAt)), stop);
    if (stop.aborted) return null;
    const wait = (ms: number): Promise<void> => deps.sleep(Math.min(ms, Math.max(0, boundary - deps.now())), stop);
    switch (poll.kind) {
      case "pending":
      case "stopped":
        return poll;
      case "empty":
        await wait(deps.minPollMs - (deps.now() - startedAt));
        break;
      case "server":
        await wait(jittered(deps.retryAfterServerMs));
        break;
      case "network":
        // A request cut short by the boundary itself is handled at the top of the loop.
        if (deps.now() < boundary) await wait(jittered(deps.retryAfterNetworkMs));
        break;
    }
  }
}
