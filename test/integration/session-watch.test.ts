// `jubarteai inbox --watch --session` through the built binary against a fake server: it renews its watch through
// the extend endpoint before the watch expires, falls back to the original expiry on an older server, stops on a
// disconnect, a vanished parent or an unattended run, and never runs twice for one agent. Real time: a watch is at
// least one minute long, so the scenarios run side by side.
import { describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { BIN, IS_WINDOWS, createSandbox } from "./harness.js";
import type { Running, Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

type Scene = { fake: FakeServer; box: Sandbox; agentId: string; session: Record<string, string> };

let counter = 0;

/** A fake server, a sandbox and a connected agent for one scenario, cleaned up when `run` finishes (scenarios run side by side). */
async function withScene(run: (s: Scene) => Promise<void>): Promise<void> {
  const fake = await startFakeServer();
  const box = createSandbox();
  try {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    expect((await box.run(["link"])).code).toBe(0);
    counter += 1;
    const session = { CLAUDE_CODE_SESSION_ID: `session-watch-${process.pid}-${counter}` };
    const connected = await box.run(["connect"], { env: session });
    const agentId = (JSON.parse(connected.stdout) as { result: { agent_id: string } }).result.agent_id;
    await run({ fake, box, agentId, session });
  } finally {
    await fake.close();
    box.cleanup();
  }
}

const extendRequests = (fake: FakeServer) => fake.requests.filter((r) => r.path === "/api/mcp/inbox-watch/extend");
const lines = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

async function untilTrue(condition: () => boolean, timeoutMs: number, label: string): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return Date.now() - started;
}

function watcher(s: Scene, extraArgs: string[] = [], env: Record<string, string | undefined> = {}): Running {
  return s.box.start(["inbox", "--watch", "--session", "--minutes", "1", "--agent", s.agentId, ...extraArgs], { env: { ...s.session, ...env }, timeoutMs: 140_000 });
}

describe.concurrent("inbox --watch --session (built binary)", () => {
  test("renews a 1-minute watch at about 30 s, is still running at 70 s, then wakes on a message", async () => withScene(async (s) => {
    const watching = watcher(s);
    const started = Date.now();
    let exited = false;
    void watching.exit.then(() => (exited = true));
    await watching.waitFor("stdout", /\n/);
    expect(watching.stdout()).not.toMatch(/jbw_/);

    const firstRenewal = await untilTrue(() => extendRequests(s.fake).length > 0, 50_000, "the first renewal");
    expect(firstRenewal).toBeGreaterThanOrEqual(25_000);
    expect(firstRenewal).toBeLessThan(40_000);

    // Past the original one-minute expiry, still watching.
    await new Promise((r) => setTimeout(r, Math.max(0, 70_000 - (Date.now() - started))));
    expect(exited).toBe(false);
    expect(extendRequests(s.fake).length).toBeGreaterThanOrEqual(2);
    expect(extendRequests(s.fake).every((r) => r.authorization?.startsWith("Bearer jbw_") === true)).toBe(true);
    expect(extendRequests(s.fake).every((r) => JSON.stringify(r.body) === JSON.stringify({ minutes: 1 }))).toBe(true);

    s.fake.enqueueMessage(s.agentId, "wake up");
    await watching.waitFor("stdout", /"pending":1/);
    const result = await watching.exit;
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/jb[acw]_[A-Za-z0-9_-]{16,}/);
    // One check_inbox for the whole session (after the connect); the renewals never went through /api/mcp.
    expect(s.fake.toolCalls().filter((c) => c.name === "check_inbox")).toHaveLength(1);
  }));

  test("an older server (extend answers 404) ends {stopped:expired} at the original expiry", async () => withScene(async (s) => {
    s.fake.extendMode = "not_found";
    const started = Date.now();
    const result = await watcher(s).exit;
    const elapsed = Date.now() - started;
    expect(result.code).toBe(0);
    expect(lines(result.stdout).at(-1)).toEqual({ stopped: "expired" });
    expect(elapsed).toBeGreaterThan(55_000);
    expect(elapsed).toBeLessThan(80_000);
    expect(extendRequests(s.fake)).toHaveLength(1);
  }));

  test("a disconnected agent (extend answers 410) ends {stopped:agent_disconnected}", async () => withScene(async (s) => {
    s.fake.extendMode = "gone";
    const started = Date.now();
    const result = await watcher(s).exit;
    expect(result.code).toBe(0);
    expect(lines(result.stdout).at(-1)).toEqual({ stopped: "agent_disconnected" });
    expect(Date.now() - started).toBeLessThan(50_000);
  }));

  test("a second watcher for the same agent answers {stopped:already_watching} and the first keeps running", async () => withScene(async (s) => {
    const first = watcher(s);
    await first.waitFor("stdout", /\n/);
    const checksBefore = s.fake.toolCalls().filter((c) => c.name === "check_inbox").length;

    for (const flags of [["--session"], []]) {
      const second = s.box.start(["inbox", "--watch", "--minutes", "1", "--agent", s.agentId, ...flags], { env: s.session });
      const result = await second.exit;
      expect(result.code).toBe(0);
      expect(lines(result.stdout)).toEqual([{ stopped: "already_watching" }]);
    }
    // The refused watchers never asked for a new watch, so the first one's token was never rotated.
    expect(s.fake.toolCalls().filter((c) => c.name === "check_inbox")).toHaveLength(checksBefore);

    s.fake.enqueueMessage(s.agentId, "still alive?");
    await first.waitFor("stdout", /"pending":1/);
    expect((await first.exit).code).toBe(0);
  }));

  test("an unattended run (SDK entrypoint) answers {stopped:unattended} and sends nothing", async () => withScene(async (s) => {
    const before = s.fake.requests.length;
    const result = await s.box.run(["inbox", "--watch", "--session", "--agent", s.agentId], { env: { ...s.session, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
    expect(result.code).toBe(0);
    expect(lines(result.stdout)).toEqual([{ stopped: "unattended" }]);
    expect(s.fake.requests.length).toBe(before);
  }));

  test.skipIf(IS_WINDOWS)("stops {stopped:parent_gone} within about 20 s when the process that started it is killed", async () => withScene(async (s) => {
    // A shell starts the watcher in the background and names both pids; killing the shell re-parents the watcher.
    const script = `"${s.box.node}" "${BIN}" inbox --watch --session --minutes 1 --agent ${s.agentId} & echo "PIDS $$ $!"; wait`;
    const running = s.box.startCommand("/bin/sh", ["-c", script], { env: s.session, timeoutMs: 100_000 });
    const [, shellPid] = await running.waitFor("stdout", /PIDS (\d+) (\d+)/);
    await running.waitFor("stdout", /"messages":/);
    process.kill(Number(shellPid), "SIGKILL");
    const killedAt = Date.now();
    await running.waitFor("stdout", /"stopped":"parent_gone"/, 30_000);
    expect(Date.now() - killedAt).toBeLessThan(25_000);
  }));
});
