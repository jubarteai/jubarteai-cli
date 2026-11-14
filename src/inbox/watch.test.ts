import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { INBOX_MS_PER_MINUTE } from "../constants.js";
import { DEFAULT_WATCH_DEPS, runWatchSession, watchUntilDone } from "./watch.js";
import type { WatchDeps } from "./watch.js";
import type { ExtendResult } from "./extend.js";

const TOKEN = "jbw_" + "b".repeat(32);

type Watch = { url: URL; polls: () => number; close: () => Promise<void> };

/** A watch endpoint: `answer(index)` is the JSON body (and status) of the index-th poll. */
async function startWatch(answer: (index: number) => { status?: number; body: unknown }): Promise<Watch> {
  let polls = 0;
  const server = http.createServer((_req, res) => {
    const { status = 200, body } = answer(polls++);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/api/mcp/inbox-watch`),
    polls: () => polls,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const open: Watch[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.close()));
});
async function watching(answer: Parameters<typeof startWatch>[0]): Promise<Watch> {
  const watch = await startWatch(answer);
  open.push(watch);
  return watch;
}

const T0 = 1_700_000_000_000;

/** A virtual clock: sleeping advances it, so hours of watching take milliseconds. */
function virtual(overrides: Partial<WatchDeps> = {}) {
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const deps: WatchDeps = {
    ...DEFAULT_WATCH_DEPS,
    // Never the ambient environment (JUBARTEAI_UNATTENDED, CLAUDE_PID, … from the runner).
    env: {},
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    // Each empty poll "takes" a minute of virtual time.
    minPollMs: 60_000,
    retryAfterServerMs: 5_000,
    retryAfterNetworkMs: 5_000,
    jitter: 0,
    renewAheadMs: 120_000,
    sessionMaxMs: 12 * 60 * 60 * 1000,
    ...overrides,
  };
  return { clock, deps, sleeps };
}

type ExtendCall = { at: number; minutes: number };
/** An `extend` that records when it was called and answers from `answers` (the last answer repeats). */
function extender(clock: { t: number }, answers: Array<(minutes: number) => ExtendResult>) {
  const calls: ExtendCall[] = [];
  const extend: WatchDeps["extend"] = async (_url, _token, minutes) => {
    calls.push({ at: clock.t, minutes });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer(minutes);
  };
  return { calls, extend };
}

const extended = (clock: { t: number }) => (minutes: number): ExtendResult => ({
  kind: "extended",
  expiresAtMs: clock.t + minutes * INBOX_MS_PER_MINUTE,
});

const never = new AbortController().signal;

describe("watchUntilDone (a plain watch)", () => {
  it("returns the first pending answer", async () => {
    const watch = await watching((i) => ({ body: { pending: i < 2 ? 0 : 3 } }));
    const { deps } = virtual();
    expect(await watchUntilDone(watch.url, TOKEN, T0 + 3_600_000, deps, never)).toEqual({ kind: "pending", pending: 3 });
    expect(watch.polls()).toBe(3);
  });

  it("ends expired at its expiry, with no renewal", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { deps } = virtual();
    expect(await watchUntilDone(watch.url, TOKEN, T0 + 300_000, deps, never)).toEqual({ kind: "stopped", reason: "expired" });
  });
});

describe("runWatchSession", () => {
  it("renews about two minutes before expiry, keeps polling past the original expiry and ends on a pending message", async () => {
    const watch = await watching((i) => ({ body: { pending: i >= 12 ? 1 : 0 } }));
    const { clock, deps } = virtual();
    const { calls, extend } = extender(clock, [extended(clock)]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "pending", pending: 1 });
    // 12 one-minute polls ran: far past the original 5 minutes.
    expect(clock.t - T0).toBeGreaterThanOrEqual(12 * 60_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The first renewal came at expiry − 120 s (the loop polls in whole minutes here, so allow one step) and each asks for the same window.
    expect(calls[0]!.at).toBeGreaterThanOrEqual(T0 + 3 * 60_000);
    expect(calls[0]!.at).toBeLessThanOrEqual(T0 + 3 * 60_000 + 60_000);
    expect(calls.every((c) => c.minutes === 5)).toBe(true);
    // The next renewal is due the lead before the new expiry (window − 120 s = 180 s later), not back to back.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(3 * 60_000);
    expect(calls[1]!.at - calls[0]!.at).toBeLessThan(5 * 60_000);
  });

  it("renews half a window before expiry when the window is shorter than twice the lead", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual({ minPollMs: 1_000 });
    const { calls, extend } = extender(clock, [extended(clock), () => ({ kind: "stopped", reason: "agent_disconnected" })]);
    await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 60_000, minutes: 1, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(calls[0]!.at).toBeGreaterThanOrEqual(T0 + 30_000);
    expect(calls[0]!.at).toBeLessThan(T0 + 32_000);
  });

  it("falls back to the original expiry when the server has no extend endpoint", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual();
    const { calls, extend } = extender(clock, [() => ({ kind: "unsupported" })]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "stopped", reason: "expired" });
    expect(calls).toHaveLength(1);
    expect(clock.t).toBeGreaterThanOrEqual(T0 + 5 * 60_000);
    expect(clock.t).toBeLessThan(T0 + 5 * 60_000 + 61_000);
  });

  it.each<[ExtendResult, string]>([
    [{ kind: "stopped", reason: "invalid_or_expired_watch" }, "invalid_or_expired_watch"],
    [{ kind: "stopped", reason: "agent_disconnected" }, "agent_disconnected"],
  ])("stops with the matching reason when the renewal is refused (%j)", async (refusal, reason) => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual();
    const { extend } = extender(clock, [() => refusal]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "stopped", reason });
  });

  it("retries a renewal that failed on the network and ends expired if it never succeeds", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual({ minPollMs: 10_000 });
    const { calls, extend } = extender(clock, [() => ({ kind: "network" })]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "stopped", reason: "expired" });
    expect(calls.length).toBeGreaterThan(1);
  });

  it("recovers after a failed renewal: a later one succeeds and the watch carries on", async () => {
    const watch = await watching((i) => ({ body: { pending: i >= 9 ? 2 : 0 } }));
    const { clock, deps } = virtual();
    const { calls, extend } = extender(clock, [() => ({ kind: "server" }), extended(clock)]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "pending", pending: 2 });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(clock.t - T0).toBeGreaterThan(5 * 60_000);
  });

  it("ends on a pending message at any stretch, including the very first poll", async () => {
    const watch = await watching(() => ({ body: { pending: 4 } }));
    const { clock, deps } = virtual();
    const { calls, extend } = extender(clock, [extended(clock)]);
    expect(await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never)).toEqual({
      kind: "pending",
      pending: 4,
    });
    expect(calls).toHaveLength(0);
  });

  it("stops with the watch's own refusal when a poll answers 410", async () => {
    const watch = await watching(() => ({ status: 410, body: { error: "agent_disconnected" } }));
    const { clock, deps } = virtual();
    const { extend } = extender(clock, [extended(clock)]);
    expect(await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never)).toEqual({
      kind: "stopped",
      reason: "agent_disconnected",
    });
  });

  it("stops with session_limit once the session limit has passed, however often it renewed", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual({ sessionMaxMs: 20 * 60_000 });
    const { calls, extend } = extender(clock, [extended(clock)]);
    const result = await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(result).toEqual({ kind: "stopped", reason: "session_limit" });
    expect(clock.t - T0).toBeGreaterThanOrEqual(20 * 60_000);
    expect(clock.t - T0).toBeLessThan(22 * 60_000);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns null when stopped, without another request", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual();
    const { extend } = extender(clock, [extended(clock)]);
    const stop = new AbortController();
    stop.abort();
    expect(await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, stop.signal)).toBeNull();
    expect(watch.polls()).toBe(0);
  });

  it("never lets a server push the expiry further than the window it asked for", async () => {
    const watch = await watching(() => ({ body: { pending: 0 } }));
    const { clock, deps } = virtual({ sessionMaxMs: 100 * 24 * 60 * 60 * 1000 });
    // A server that answers a year ahead: the next renewal must still come within about one window.
    const { calls, extend } = extender(clock, [() => ({ kind: "extended", expiresAtMs: clock.t + 365 * 24 * 60 * 60 * 1000 }), () => ({ kind: "stopped", reason: "agent_disconnected" })]);
    await runWatchSession(watch.url, TOKEN, { expiresAtMs: T0 + 5 * 60_000, minutes: 5, startedAtMs: T0 }, { ...deps, extend }, never);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeLessThan(7 * 60_000);
  });
});
