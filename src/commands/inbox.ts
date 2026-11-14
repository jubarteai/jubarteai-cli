// `jubarteai inbox` (spec §5.4): check_inbox in its friendly form, and `--watch`, which replaces the shell
// loop `check_inbox` hands out. The watch token (`jbw_`) lives only in memory here: it is sent to the
// seat's own origin and never printed.
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import {
  INBOX_EXPIRY_SLACK_MS,
  INBOX_MS_PER_MINUTE,
  INBOX_WAIT_MAX_SECONDS,
  INBOX_WATCH_DEFAULT_MINUTES,
  INBOX_WATCH_MAX_MINUTES,
  INBOX_WATCH_PATH,
} from "../constants.js";
import { UsageError } from "../errors.js";
import { writeJson } from "../output.js";
import { unattendedReason, watchParent } from "../inbox/guards.js";
import { acquireWatchLock } from "../inbox/lock.js";
import { DEFAULT_WATCH_DEPS, runWatchSession, watchUntilDone } from "../inbox/watch.js";
import type { WatchDeps, WatchResult } from "../inbox/watch.js";
import { callTool } from "../mcp/client.js";
import type { Envelope } from "../mcp/client.js";
import { normalizeOrigin } from "../process-env.js";
import { agentFor, emit, printableEnvelope, rejectPositionals, seatFor } from "./tool.js";

const WATCH_TOKEN_RE = /^jbw_[A-Za-z0-9_-]+$/;

export { DEFAULT_WATCH_DEPS };
export type { WatchDeps };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function runWatch(
  ctx: CommandContext,
  seat: ResolvedSeat,
  agentId: string,
  minutes: number,
  deps: WatchDeps,
  session: boolean,
): Promise<number> {
  // One watcher per agent per machine: a second `check_inbox` with watch_minutes would rotate the first
  // watcher's token, killing it and waking its agent for nothing. Taken before anything is sent.
  const held = await acquireWatchLock(agentId, session ? "session" : "watch", deps.lock);
  if (held.kind === "held") {
    line(ctx, { stopped: "already_watching" });
    return 0;
  }
  // `unavailable` (no safe place for the lock file) proceeds unlocked: the lock only prevents waste.
  try {
    return await watchWithSignals(ctx, seat, agentId, minutes, deps, session);
  } finally {
    if (held.kind === "acquired") held.lock.release();
  }
}

async function watchWithSignals(
  ctx: CommandContext,
  seat: ResolvedSeat,
  agentId: string,
  minutes: number,
  deps: WatchDeps,
  session: boolean,
): Promise<number> {
  const stop = new AbortController();
  // A session watch also ends when the session that started it is gone (a crashed harness must not leave a
  // watcher keeping a dead agent alive).
  const parent = session ? watchParent(deps.env, deps.parent) : null;
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
    // A signal wins over the parent check: the user asked for it.
    if (signalled === null && parent?.signal.aborted === true) {
      line(ctx, { stopped: "parent_gone" });
      return 0;
    }
    line(ctx, { stopped: "interrupted" });
    return signalled === "SIGTERM" ? 143 : 130;
  };
  const stopSignal = parent === null ? stop.signal : AbortSignal.any([stop.signal, parent.signal]);

  try {
    const startedAt = deps.now();
    const outcome = await callTool(seat, "check_inbox", { agent_id: agentId, watch_minutes: minutes }, { signal: stopSignal });
    // A signal that cut the request short is a clean stop; one that lands after the answer must not
    // swallow the messages it drained (they are already marked delivered), so those are printed below.
    if (outcome.exitCode !== 0) return stopSignal.aborted ? interrupted() : emit(ctx, outcome, [seat.token]);

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
    const done: WatchResult | null = session
      ? await runWatchSession(url, token, { expiresAtMs: endsAt, minutes, startedAtMs: startedAt }, deps, stopSignal)
      : await watchUntilDone(url, token, endsAt, deps, stopSignal);
    if (done === null) return interrupted();
    line(ctx, done.kind === "pending" ? { pending: done.pending } : { stopped: done.reason });
    return 0;
  } finally {
    for (const { name, listener } of listeners) deps.signals.off(name, listener);
    parent?.stop();
  }
}

/** The inbox command's body, with the watch's clock, delays and signal source injectable for tests. */
export async function runInbox(ctx: CommandContext, args: ParsedArgs, deps: WatchDeps = DEFAULT_WATCH_DEPS): Promise<number> {
  rejectPositionals(args);
  const watching = args.flags["watch"] === true;
  const wait = intFlag(args.flags, "wait", 0, Number.MAX_SAFE_INTEGER);
  const minutes = intFlag(args.flags, "minutes", 1, INBOX_WATCH_MAX_MINUTES);
  const session = args.flags["session"] === true;
  if (watching && wait !== undefined) throw new UsageError("--wait and --watch don't combine: --watch already waits.");
  if (!watching && minutes !== undefined) throw new UsageError("--minutes only applies with --watch.");
  if (session && !watching) throw new UsageError("--session only applies with --watch.");

  // A session watch keeps an agent's inbox watched for hours: not something an unattended run (`claude -p`,
  // the SDK, CI) should start. Refused before anything is read or sent.
  if (session) {
    const reason = unattendedReason(deps.env);
    if (reason !== null) {
      line(ctx, { stopped: reason });
      return 0;
    }
  }

  const seat = seatFor(ctx);
  const agentId = agentFor(ctx, seat, undefined, { required: true }) as string;
  if (watching) return runWatch(ctx, seat, agentId, minutes ?? INBOX_WATCH_DEFAULT_MINUTES, deps, session);

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
    { name: "minutes", type: "number", description: `With --watch: how long to watch (1-${INBOX_WATCH_MAX_MINUTES}, default ${INBOX_WATCH_DEFAULT_MINUTES}); with --session, how long each renewal lasts` },
    {
      name: "session",
      type: "boolean",
      description: "With --watch, for an interactive session: renew the watch shortly before it expires instead of ending, until the agent disconnects, the session is gone or 12 hours pass (not for unattended runs)",
    },
  ],
  usage: `inbox [--wait <seconds>] | inbox --watch [--session] [--minutes <1-${INBOX_WATCH_MAX_MINUTES}>]`,
  run: (ctx, args) => runInbox(ctx, args),
};
