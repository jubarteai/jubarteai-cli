import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireWatchLock, DEFAULT_LOCK_DEPS } from "./lock.js";
import type { LockDeps } from "./lock.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const isWindows = process.platform === "win32";

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jba-lock-"));
  dir = join(root, "watch");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Lock dependencies for a pretend process `pid`, with a fixed set of live pids. */
function deps(pid: number, alive: Set<number>): LockDeps {
  return {
    dir: () => dir,
    pid,
    isAlive: (candidate) => alive.has(candidate),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    onExit: () => () => undefined,
  };
}

const lockFile = (agentId: string): string => join(dir, `${agentId}.lock`);

describe("acquireWatchLock", () => {
  it("creates the lock with the holder's pid, mode and start time, and nothing secret", async () => {
    const result = await acquireWatchLock(AGENT_A, "session", deps(111, new Set([111])));
    expect(result.kind).toBe("acquired");
    const body = JSON.parse(readFileSync(lockFile(AGENT_A), "utf8")) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["mode", "pid", "started_at"]);
    expect(body["pid"]).toBe(111);
    expect(body["mode"]).toBe("session");
    expect(Number.isNaN(Date.parse(body["started_at"] as string))).toBe(false);
    expect(readFileSync(lockFile(AGENT_A), "utf8")).not.toContain("jbw_");
    if (!isWindows) {
      expect(statSync(lockFile(AGENT_A)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a second acquire for the same agent while the holder is alive", async () => {
    const alive = new Set([111, 222]);
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, alive))).kind).toBe("acquired");
    expect(await acquireWatchLock(AGENT_A, "session", deps(222, alive))).toEqual({ kind: "held", pid: 111, mode: "watch" });
    // The holder's file is untouched.
    expect(JSON.parse(readFileSync(lockFile(AGENT_A), "utf8"))).toMatchObject({ pid: 111, mode: "watch" });
  });

  it("treats a different agent id as independent", async () => {
    const alive = new Set([111, 222]);
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, alive))).kind).toBe("acquired");
    expect((await acquireWatchLock(AGENT_B, "watch", deps(222, alive))).kind).toBe("acquired");
    expect(readdirSync(dir).sort()).toEqual([`${AGENT_A}.lock`, `${AGENT_B}.lock`]);
  });

  it("reclaims a lock whose holder is dead", async () => {
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("acquired");
    const taken = await acquireWatchLock(AGENT_A, "session", deps(222, new Set([222])));
    expect(taken.kind).toBe("acquired");
    expect(JSON.parse(readFileSync(lockFile(AGENT_A), "utf8"))).toMatchObject({ pid: 222, mode: "session" });
    expect(readdirSync(dir)).toEqual([`${AGENT_A}.lock`]);
  });

  it("reclaims a stale lock exactly once when several processes race for it", async () => {
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("acquired");
    // 111 is dead for everybody now; 201..208 all find the stale file at the same moment.
    const racers = [201, 202, 203, 204, 205, 206, 207, 208];
    const alive = new Set(racers);
    const results = await Promise.all(racers.map((pid) => acquireWatchLock(AGENT_A, "watch", deps(pid, alive))));
    const winners = results.flatMap((r, i) => (r.kind === "acquired" ? [racers[i]!] : []));
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.kind === "held")).toHaveLength(racers.length - 1);
    expect(JSON.parse(readFileSync(lockFile(AGENT_A), "utf8"))).toMatchObject({ pid: winners[0] });
    expect(readdirSync(dir)).toEqual([`${AGENT_A}.lock`]);
  });

  it("treats a malformed lock as stale once it is old, and as held while it is fresh", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(AGENT_A), "not json", { mode: 0o600 });
    // Fresh: a holder may be mid-write.
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("held");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(AGENT_A), old, old);
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("acquired");
    expect(JSON.parse(readFileSync(lockFile(AGENT_A), "utf8"))).toMatchObject({ pid: 111 });
  });

  it.each([
    ["an empty file", ""],
    ["a JSON array", "[1]"],
    ["a pid that isn't a positive integer", JSON.stringify({ pid: -4, mode: "watch" })],
    ["a string pid", JSON.stringify({ pid: "12", mode: "watch" })],
    ["an oversized file", "x".repeat(4_000)],
  ])("reads %s as malformed (stale when old)", async (_label, content) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(AGENT_A), content, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(AGENT_A), old, old);
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("acquired");
  });

  it("clears a leftover reclaim marker once it is old", async () => {
    expect((await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).kind).toBe("acquired");
    const marker = `${lockFile(AGENT_A)}.reclaim`;
    writeFileSync(marker, "", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(marker, old, old);
    expect((await acquireWatchLock(AGENT_A, "watch", deps(222, new Set([222])))).kind).toBe("acquired");
    expect(existsSync(marker)).toBe(false);
  });

  it("release removes only its own file", async () => {
    const alive = new Set([111, 222]);
    const first = await acquireWatchLock(AGENT_A, "watch", deps(111, alive));
    if (first.kind !== "acquired") throw new Error("expected the lock");
    // The first holder died and 222 took over; the first's late release must not remove 222's lock.
    alive.delete(111);
    const second = await acquireWatchLock(AGENT_A, "session", deps(222, alive));
    expect(second.kind).toBe("acquired");
    first.lock.release();
    expect(existsSync(lockFile(AGENT_A))).toBe(true);
    if (second.kind === "acquired") second.lock.release();
    expect(existsSync(lockFile(AGENT_A))).toBe(false);
  });

  it("release is idempotent and lets the next watcher in", async () => {
    const alive = new Set([111, 222]);
    const first = await acquireWatchLock(AGENT_A, "watch", deps(111, alive));
    if (first.kind !== "acquired") throw new Error("expected the lock");
    first.lock.release();
    first.lock.release();
    expect((await acquireWatchLock(AGENT_A, "watch", deps(222, alive))).kind).toBe("acquired");
  });

  it("registers its release for process exit and unregisters it on release", async () => {
    let registered: (() => void) | null = null;
    let unregistered = false;
    const d: LockDeps = {
      ...deps(111, new Set([111])),
      onExit: (release) => {
        registered = release;
        return () => {
          unregistered = true;
        };
      },
    };
    const result = await acquireWatchLock(AGENT_A, "watch", d);
    if (result.kind !== "acquired") throw new Error("expected the lock");
    expect(registered).not.toBeNull();
    // The exit handler removes the file, as a process.exit() would.
    (registered as unknown as () => void)();
    expect(existsSync(lockFile(AGENT_A))).toBe(false);
    expect(unregistered).toBe(true);
  });

  it("hashes an id that isn't a uuid into a safe file name", async () => {
    const result = await acquireWatchLock("../../etc/passwd", "watch", deps(111, new Set([111])));
    expect(result.kind).toBe("acquired");
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.lock$/);
  });

  it.skipIf(isWindows)("is unavailable (not an error) when the directory is a symbolic link or open to others", async () => {
    const target = join(root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, dir);
    expect(await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).toEqual({ kind: "unavailable" });
    expect(readdirSync(target)).toEqual([]);
    rmSync(dir);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o777);
    expect(await acquireWatchLock(AGENT_A, "watch", deps(111, new Set([111])))).toEqual({ kind: "unavailable" });
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });
});

describe.skipIf(isWindows)("acquireWatchLock with real processes", () => {
  it("reclaims the lock of a holder that was killed with SIGKILL", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const pid = child.pid as number;
      const real: LockDeps = { ...DEFAULT_LOCK_DEPS, dir: () => dir, pid, onExit: () => () => undefined };
      expect((await acquireWatchLock(AGENT_A, "session", real)).kind).toBe("acquired");
      // Alive: the next watcher is refused.
      const ours: LockDeps = { ...DEFAULT_LOCK_DEPS, dir: () => dir, onExit: () => () => undefined };
      expect(await acquireWatchLock(AGENT_A, "watch", ours)).toEqual({ kind: "held", pid, mode: "session" });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      const taken = await acquireWatchLock(AGENT_A, "watch", ours);
      expect(taken.kind).toBe("acquired");
      if (taken.kind === "acquired") taken.lock.release();
      expect(existsSync(lockFile(AGENT_A))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
