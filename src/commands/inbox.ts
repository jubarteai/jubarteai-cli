// `jubarteai inbox` (spec §5.4): check_inbox in its friendly form, and `--watch`, which replaces the shell
// loop `check_inbox` hands out. The watch token (`jbw_`) lives only in memory here: it is sent to the
// seat's own origin and never printed.
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import {
  INBOX_EXPIRY_SLACK_MS,
  INBOX_MIN_POLL_MS,
  INBOX_MS_PER_MINUTE,
  INBOX_POLL_BODY_MAX_BYTES,
  INBOX_POLL_TIMEOUT_MS,
  INBOX_RETRY_AFTER_NETWORK_MS,
  INBOX_RETRY_AFTER_SERVER_MS,
  INBOX_RETRY_JITTER,
  INBOX_WAIT_MAX_SECONDS,
  INBOX_WATCH_DEFAULT_MINUTES,
  INBOX_WATCH_MAX_MINUTES,
  INBOX_WATCH_PATH,
} from "../constants.js";
import { UsageError } from "../errors.js";
import { writeJson } from "../output.js";
import { callTool, readCapped } from "../mcp/client.js";
import type { Envelope } from "../mcp/client.js";
import { normalizeOrigin } from "../process-env.js";
import { agentFor, emit, printableEnvelope, rejectPositionals, seatFor } from "./tool.js";

const WATCH_TOKEN_RE = /^jbw_[A-Za-z0-9_-]+$/;

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
};

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
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
};

type WatchResult =
  | { kind: "pending"; pending: number }
  | { kind: "stopped"; reason: "invalid_or_expired_watch" | "agent_disconnected" | "expired" };

type Poll =
  | { kind: "pending"; pending: number }
  | { kind: "empty" }
  | { kind: "stopped"; reason: "invalid_or_expired_watch" | "agent_disconnected" }
  | { kind: "server" }
  | { kind: "network" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pollOnce(url: URL, token: string, timeoutMs: number, stop: AbortSignal): Promise<Poll> {
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
async function watchUntilDone(
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

/** The watch address, only if it is the seat's own origin and the inbox-watch path, with no credentials, query or fragment. */
function watchUrlFor(seat: ResolvedSeat, raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const origin = normalizeOrigin(seat.origin);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (origin === null || url.origin !== origin || url.pathname !== INBOX_WATCH_PATH) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return url;
}

function intFlag(flags: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}.`);
  }
  if (value > max) throw new UsageError(`--${name} must be at most ${max}.`);
  return value;
}

function line(ctx: CommandContext, value: unknown): void {
  writeJson(ctx.stdout, value, { pretty: ctx.globals.pretty });
}

async function runWatch(ctx: CommandContext, seat: ResolvedSeat, agentId: string, minutes: number, deps: WatchDeps): Promise<number> {
  const stop = new AbortController();
  let signalled: NodeJS.Signals | null = null;
  const listeners = (["SIGINT", "SIGTERM"] as const).map((name) => {
    const listener = (): void => {
      signalled ??= name;
      stop.abort();
    };
    deps.signals.on(name, listener);
    return { name, listener };
  });
  const interrupted = (): number => {
    line(ctx, { stopped: "interrupted" });
    return signalled === "SIGTERM" ? 143 : 130;
  };

  try {
    const startedAt = deps.now();
    const outcome = await callTool(seat, "check_inbox", { agent_id: agentId, watch_minutes: minutes }, { signal: stop.signal });
    // A signal that cut the request short is a clean stop; one that lands after the answer must not
    // swallow the messages it drained (they are already marked delivered), so those are printed below.
    if (outcome.exitCode !== 0) return stop.signal.aborted ? interrupted() : emit(ctx, outcome, [seat.token]);

    const printed = printableEnvelope(outcome.envelope, [seat.token]);
    const result = isRecord(outcome.envelope.result) ? outcome.envelope.result : {};
    const watch = isRecord(result["watch"]) ? result["watch"] : null;
    const token = watch !== null && typeof watch["token"] === "string" && WATCH_TOKEN_RE.test(watch["token"]) ? watch["token"] : null;
    const url = watch === null ? null : watchUrlFor(seat, watch["url"]);
    const expires = watch !== null && typeof watch["expires_at"] === "string" ? Date.parse(watch["expires_at"]) : Number.NaN;

    // The drained messages are printed whatever else happens: they are already marked delivered.
    const refuse = (code: "watch_unavailable" | "watch_invalid", message: string): number => {
      const refusal: Envelope = { messages: printed.messages, error: message, code };
      line(ctx, refusal);
      ctx.stderr.write(`${message}\n`);
      return 1;
    };
    // An older server issues the shell command only: no url or token to poll with.
    if (watch === null || watch["url"] === undefined || watch["token"] === undefined) {
      return refuse("watch_unavailable", "inbox watch unavailable on this server");
    }
    if (token === null || url === null || Number.isNaN(expires)) {
      return refuse("watch_invalid", "inbox watch refused: the server's watch details were not usable");
    }

    // Line 1: the messages drained by the initial call, in the usual envelope, minus anything secret.
    // Line 2: {"pending":n} at once when there were any, else the watch's own final line.
    const safeResult = isRecord(printed.result) ? { ...printed.result } : {};
    safeResult["watch"] = { expires_at: watch["expires_at"] };
    line(ctx, { ...printed, result: safeResult });

    // check_inbox drains before it issues the watch, so these messages are already delivered: tell the
    // caller now (a normal broadcast among them too) instead of waiting for the next one.
    if (printed.messages.length > 0) {
      line(ctx, { pending: printed.messages.length });
      return 0;
    }

    const endsAt = Math.min(expires, startedAt + minutes * INBOX_MS_PER_MINUTE + INBOX_EXPIRY_SLACK_MS);
    const done = await watchUntilDone(url, token, endsAt, deps, stop.signal);
    if (done === null) return interrupted();
    line(ctx, done.kind === "pending" ? { pending: done.pending } : { stopped: done.reason });
    return 0;
  } finally {
    for (const { name, listener } of listeners) deps.signals.off(name, listener);
  }
}

/** The inbox command's body, with the watch's clock, delays and signal source injectable for tests. */
export async function runInbox(ctx: CommandContext, args: ParsedArgs, deps: WatchDeps = DEFAULT_WATCH_DEPS): Promise<number> {
  rejectPositionals(args);
  const watching = args.flags["watch"] === true;
  const wait = intFlag(args.flags, "wait", 0, Number.MAX_SAFE_INTEGER);
  const minutes = intFlag(args.flags, "minutes", 1, INBOX_WATCH_MAX_MINUTES);
  if (watching && wait !== undefined) throw new UsageError("--wait and --watch don't combine: --watch already waits.");
  if (!watching && minutes !== undefined) throw new UsageError("--minutes only applies with --watch.");

  const seat = seatFor(ctx);
  const agentId = agentFor(ctx, seat, undefined, { required: true }) as string;
  if (watching) return runWatch(ctx, seat, agentId, minutes ?? INBOX_WATCH_DEFAULT_MINUTES, deps);

  const toolArgs: Record<string, unknown> = { agent_id: agentId };
  if (wait !== undefined) toolArgs["wait_seconds"] = Math.min(wait, INBOX_WAIT_MAX_SECONDS);
  return emit(ctx, await callTool(seat, "check_inbox", toolArgs), [seat.token]);
}

export const inboxCommand: CommandDef = {
  name: "inbox",
  summary: "Read this agent's unread messages; --watch waits in the background for the next one",
  group: "tools",
  flags: [
    { name: "wait", type: "number", description: `Hold the call open up to this many seconds (at most ${INBOX_WAIT_MAX_SECONDS}) for a message` },
    { name: "watch", type: "boolean", description: "Wait in the background: prints the drained messages as an envelope, then one line, {\"pending\":n} or {\"stopped\":\"…\"}" },
    { name: "minutes", type: "number", description: `With --watch: how long to watch (1-${INBOX_WATCH_MAX_MINUTES}, default ${INBOX_WATCH_DEFAULT_MINUTES})` },
  ],
  usage: `inbox [--wait <seconds>] | inbox --watch [--minutes <1-${INBOX_WATCH_MAX_MINUTES}>]`,
  run: (ctx, args) => runInbox(ctx, args),
};
