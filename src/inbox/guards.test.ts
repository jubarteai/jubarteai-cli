import { describe, expect, it } from "vitest";

import { INBOX_PARENT_CHECK_MS, INBOX_SESSION_MAX_MS } from "../constants.js";
import { SESSION_MAX_MS, unattendedReason, watchParent } from "./guards.js";
import type { ParentWatchDeps } from "./guards.js";

describe("unattendedReason", () => {
  it.each([
    ["neither variable set", {}],
    ["interactive Claude Code", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" }],
    ["entrypoint cli alone", { CLAUDE_CODE_ENTRYPOINT: "cli" }],
    ["an empty entrypoint", { CLAUDE_CODE_ENTRYPOINT: "" }],
    ["attended alone", { CLAUDE_CODE_SESSION_ATTENDED: "1" }],
    ["a garbage ATTENDED value", { CLAUDE_CODE_SESSION_ATTENDED: "yes" }],
    ["an empty ATTENDED value", { CLAUDE_CODE_SESSION_ATTENDED: "" }],
    ["JUBARTEAI_UNATTENDED empty", { JUBARTEAI_UNATTENDED: "" }],
    ["JUBARTEAI_UNATTENDED=0", { JUBARTEAI_UNATTENDED: "0", CLAUDE_CODE_ENTRYPOINT: "cli" }],
    ["JUBARTEAI_UNATTENDED=false", { JUBARTEAI_UNATTENDED: "false" }],
    ["JUBARTEAI_UNATTENDED=maybe", { JUBARTEAI_UNATTENDED: "maybe" }],
  ])("is null for %s (fails open)", (_label, env) => {
    expect(unattendedReason(env as NodeJS.ProcessEnv)).toBeNull();
  });

  it.each([
    ["the SDK entrypoint", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
    ["any other entrypoint", { CLAUDE_CODE_ENTRYPOINT: "github-action" }],
    ["ATTENDED=0", { CLAUDE_CODE_SESSION_ATTENDED: "0" }],
    ["ATTENDED=0 with entrypoint cli", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }],
    ["the explicit opt-out on an interactive-looking session", { JUBARTEAI_UNATTENDED: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" }],
    ["the opt-out spelled true", { JUBARTEAI_UNATTENDED: "true" }],
    ["the opt-out spelled YES with spaces", { JUBARTEAI_UNATTENDED: " YES " }],
    ["the opt-out spelled on", { JUBARTEAI_UNATTENDED: "on" }],
  ])("is unattended for %s", (_label, env) => {
    expect(unattendedReason(env as NodeJS.ProcessEnv)).toBe("unattended");
  });
});

describe("session limit", () => {
  it("is 12 hours", () => {
    expect(SESSION_MAX_MS).toBe(12 * 60 * 60 * 1000);
    expect(INBOX_SESSION_MAX_MS).toBe(SESSION_MAX_MS);
  });
});

/** Parent-watch dependencies driven by hand: `tick()` runs the check once. */
function harness(options: { ppid?: number; alive?: Set<number> } = {}) {
  let ppid = options.ppid ?? 100;
  const alive = options.alive ?? new Set<number>();
  let callback: (() => void) | null = null;
  let intervalMs = 0;
  let cleared = false;
  const deps: ParentWatchDeps = {
    isAlive: (pid) => alive.has(pid),
    ppid: () => ppid,
    setInterval: (fn, ms) => {
      callback = fn;
      intervalMs = ms;
      return {};
    },
    clearInterval: () => {
      cleared = true;
    },
    checkEveryMs: 15_000,
  };
  return {
    deps,
    alive,
    setPpid: (value: number) => (ppid = value),
    tick: () => callback?.(),
    intervalMs: () => intervalMs,
    cleared: () => cleared,
  };
}

describe("watchParent", () => {
  it("checks every 15 s by default period constant", () => {
    expect(INBOX_PARENT_CHECK_MS).toBe(15_000);
  });

  it("never aborts while CLAUDE_PID is alive and the parent is unchanged", () => {
    const h = harness({ alive: new Set([4242]) });
    const parent = watchParent({ CLAUDE_PID: "4242" }, h.deps);
    h.tick();
    h.tick();
    expect(parent.signal.aborted).toBe(false);
    expect(h.intervalMs()).toBe(15_000);
  });

  it("aborts when the CLAUDE_PID process is gone", () => {
    const h = harness({ alive: new Set([4242]) });
    const parent = watchParent({ CLAUDE_PID: "4242" }, h.deps);
    h.tick();
    expect(parent.signal.aborted).toBe(false);
    h.alive.delete(4242);
    h.tick();
    expect(parent.signal.aborted).toBe(true);
  });

  it("aborts when the parent pid changed since the start, with or without CLAUDE_PID", () => {
    const h = harness({ ppid: 100, alive: new Set([4242]) });
    const withPid = watchParent({ CLAUDE_PID: "4242" }, h.deps);
    h.setPpid(1);
    h.tick();
    expect(withPid.signal.aborted).toBe(true);

    const h2 = harness({ ppid: 100 });
    const without = watchParent({}, h2.deps);
    h2.tick();
    expect(without.signal.aborted).toBe(false);
    h2.setPpid(1);
    h2.tick();
    expect(without.signal.aborted).toBe(true);
  });

  it.each([["abc"], ["12.5"], ["0"], ["-5"], [""], ["99999999999"]])("ignores CLAUDE_PID=%j and falls back to the parent pid", (raw) => {
    const h = harness({ ppid: 100, alive: new Set() });
    const parent = watchParent({ CLAUDE_PID: raw }, h.deps);
    h.tick();
    // Nothing is alive in this harness: had a pid been read from the value, the watch would have aborted.
    expect(parent.signal.aborted).toBe(false);
  });

  it("stop() ends the checks", () => {
    const h = harness();
    const parent = watchParent({}, h.deps);
    parent.stop();
    expect(h.cleared()).toBe(true);
  });
});
