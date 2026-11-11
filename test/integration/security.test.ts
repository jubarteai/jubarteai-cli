// The promises about where a key goes (spec section 8, I1 and I2) checked on the built binary: it is sent only
// to the origin it was minted for, never follows a redirect, never prints what a server echoes back, and
// never prints the inbox watch token.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { FAKE_KEY, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SESSION = { CLAUDE_CODE_SESSION_ID: "session-one" };

let fake: FakeServer;
let evil: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  evil = await startFakeServer();
  box = createSandbox();
  expect((await box.signInWithKey(fake)).code).toBe(0);
  expect((await box.run(["link"])).code).toBe(0);
});

afterEach(async () => {
  await fake.close();
  await evil.close();
  box.cleanup();
});

describe("origin pinning", () => {
  test("a stored login is used at the origin it was minted for, whatever JUBARTEAI_URL says", async () => {
    // A second server that records everything it is sent; the environment tries to steer the CLI to it,
    // and to a hostile name that is not even a valid origin for a plain-http address.
    for (const url of [evil.origin, "http://evil.example", "https://evil.example"]) {
      const env = { ...SESSION, JUBARTEAI_URL: url };
      const connect = await box.run(["connect", "--description", "pinned"], { env });
      expect(connect.code, `${url}: ${connect.stderr}`).toBe(0);
      expect((await box.run(["list-agents"], { env })).code).toBe(0);
      expect((await box.run(["inbox"], { env })).code).toBe(0);
      const started = await box.run(["hook", "session-start", "--harness", "claude-code"], {
        env,
        stdin: JSON.stringify({ session_id: `hook-${url}`, cwd: box.repo, source: "startup" }),
      });
      expect(started.code).toBe(0);
      expect(started.stdout).toContain("agent_id");
    }
    expect(evil.requests).toEqual([]);
    expect(fake.toolCalls().map((c) => c.authorization)).toSatisfy((all: Array<string | null>) => all.length > 0 && all.every((a) => a === `Bearer ${FAKE_KEY}`));
  });

  test("a server that redirects the call elsewhere does not get the key forwarded", async () => {
    fake.mcpMode = "redirect";
    fake.redirectTo = evil.origin;
    const result = await box.run(["connect", "--description", "redirected"], { env: SESSION });
    expect(result.code).toBe(4);
    expect(evil.requests).toEqual([]);
  });

  test("a call to a login whose saved address was edited into something unusable refuses without sending", async () => {
    const seats = box.readJson(box.credentialsFile) as { seats: Record<string, { origin: string }> };
    const seat = Object.values(seats.seats)[0];
    expect(seat).toBeDefined();
    const { writeFileSync } = await import("node:fs");
    // http:// on a non-loopback host is not an origin the CLI will ever send a key to.
    (seat as { origin: string }).origin = "http://evil.example";
    writeFileSync(box.credentialsFile, JSON.stringify(seats));
    const result = await box.run(["list-agents", "--agent", "aaaaaaaa-0000-4000-8000-00000000000a"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(FAKE_KEY);
    expect(evil.requests).toEqual([]);
  });

  test("JUBARTEAI_URL decides where a new login goes, and only a plain-http loopback or https address is accepted", async () => {
    const rejected = await box.run(["login", "--with-token"], { stdin: "jba_ANOTHERFAKEKEY000000000000000009\n", env: { JUBARTEAI_URL: "http://evil.example" } });
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).not.toContain("evil.example");
  });
});

describe("what a server can make the CLI print", () => {
  test("a key echoed back in an error is redacted in the envelope", async () => {
    await box.run(["connect"], { env: SESSION });
    fake.failTool("get_knowledge", `lookup failed for ${FAKE_KEY}`);
    const result = await box.run(["get-knowledge", "--id", "x"], { env: SESSION });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(FAKE_KEY);
    expect(result.stdout).toContain("[redacted]");
    expect(box.findLeaks([FAKE_KEY])).toEqual([]);
  });

  test("the inbox watch token is never printed, and the watch wakes on a message", async () => {
    const connected = await box.run(["connect"], { env: SESSION });
    const agentId = (JSON.parse(connected.stdout) as { result: { agent_id: string } }).result.agent_id;

    const watching = box.start(["inbox", "--watch", "--minutes", "1"], { env: SESSION });
    // First line: the envelope with whatever was already waiting; the watch details are not in it.
    await watching.waitFor("stdout", /\n/);
    expect(watching.stdout()).not.toMatch(/jbw_/);
    expect(JSON.parse(watching.stdout().split("\n")[0] as string)).toMatchObject({ messages: [] });

    fake.enqueueMessage(agentId, "wake up");
    await watching.waitFor("stdout", /"pending":1/);
    const result = await watching.exit;
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/jb[acw]_[A-Za-z0-9_-]{16,}/);
    // The watch used its own token, not the key.
    const polls = fake.requests.filter((r) => r.path === "/api/mcp/inbox-watch");
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((r) => r.authorization?.startsWith("Bearer jbw_") === true)).toBe(true);
  });
});
