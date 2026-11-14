// The internal `hook` command through the built binary, the way a harness runs it: JSON on stdin, text on
// stdout, always exit 0. Two simulated sessions share one account and one key and get one agent each.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { FAKE_KEY, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const AGENT_LINE = /Your JubarteAI agent_id is ([0-9a-f-]{36})/;

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
  expect((await box.signInWithKey(fake)).code).toBe(0);
  // Bind the repo to the workspace of the saved login; hooks stay silent in a repo with no binding.
  expect((await box.run(["link"])).code).toBe(0);
});

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

function hook(event: string, session: string, extra: Record<string, unknown> = {}, opts: { cwd?: string; harness?: string } = {}) {
  const input = JSON.stringify({ session_id: session, cwd: opts.cwd ?? box.repo, ...extra });
  return box.run(["hook", event, "--harness", opts.harness ?? "claude-code"], { stdin: input });
}

describe("hook", () => {
  test("session-start connects an agent, injects its identity and caches it for this session only", async () => {
    const started = await hook("session-start", "sess-1", { source: "startup" });
    expect(started.code).toBe(0);
    expect(started.stderr).toBe("");
    const agentId = AGENT_LINE.exec(started.stdout)?.[1];
    expect(agentId).toBeDefined();
    expect(started.stdout).toContain(`--agent ${agentId}`);
    expect(fake.agents.map((a) => a.id)).toEqual([agentId]);
    expect(fake.agents[0]?.description).toBe("claude-code on acme-app");

    // The cache the hook wrote is the one the tool commands read: same session, same agent.
    const listed = await box.run(["list-agents"], { env: { CLAUDE_CODE_SESSION_ID: "sess-1" } });
    expect(listed.code).toBe(0);
    expect(fake.toolCalls().at(-1)?.arguments["agent_id"]).toBe(agentId);
    // Another session does not inherit it.
    expect((await box.run(["list-agents"], { env: { CLAUDE_CODE_SESSION_ID: "sess-2" } })).code).toBe(2);
  });

  test("under an environment key (harness env, no saved seat) the hook's agent is the one later commands use without --agent", async () => {
    const envKey = { JUBARTEAI_TOKEN: FAKE_KEY, JUBARTEAI_URL: fake.origin };
    const input = JSON.stringify({ session_id: "sess-env", cwd: box.repo, source: "startup" });
    const started = await box.run(["hook", "session-start", "--harness", "claude-code"], { stdin: input, env: envKey });
    const agentId = AGENT_LINE.exec(started.stdout)?.[1];
    expect(agentId).toBeDefined();

    const listed = await box.run(["list-agents"], { env: { ...envKey, CLAUDE_CODE_SESSION_ID: "sess-env" } });
    expect(listed.code).toBe(0);
    expect(fake.toolCalls().at(-1)?.arguments["agent_id"]).toBe(agentId);
  });

  test("two sessions get two agents and share one key", async () => {
    const one = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1];
    const two = AGENT_LINE.exec((await hook("session-start", "sess-2", { source: "startup" })).stdout)?.[1];
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one).not.toBe(two);
    expect(fake.agents).toHaveLength(2);
    expect(new Set(fake.agents.map((a) => a.seat_id)).size).toBe(1);

    const connects = fake.toolCalls().filter((c) => c.name === "connect");
    expect(connects).toHaveLength(2);
    expect(new Set(connects.map((c) => c.authorization))).toEqual(new Set([`Bearer ${FAKE_KEY}`]));
    expect(box.readJson(box.credentialsFile)["seats"]).toHaveProperty(fake.identity.seat_id);
    expect(Object.keys(box.readJson(box.credentialsFile)["seats"] as object)).toHaveLength(1);
  });

  test("a resumed session keeps its agent instead of connecting a new one", async () => {
    const first = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1];
    const resumed = await hook("session-start", "sess-1", { source: "resume" });
    expect(AGENT_LINE.exec(resumed.stdout)?.[1]).toBe(first);
    expect(fake.agents).toHaveLength(1);
  });

  test("user-prompt-submit is silent with an empty inbox and injects the messages when there are some", async () => {
    const one = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1] as string;
    const two = AGENT_LINE.exec((await hook("session-start", "sess-2", { source: "startup" })).stdout)?.[1] as string;

    const quiet = await hook("user-prompt-submit", "sess-1", { prompt: "hi" });
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");

    fake.enqueueMessage(one, "please review the migration");
    const delivered = await hook("user-prompt-submit", "sess-1", { prompt: "hi" });
    expect(delivered.code).toBe(0);
    expect(delivered.stdout).toContain("please review the migration");
    expect(delivered.stdout).toContain(one);

    // The message was drained for agent one only: the other session still hears nothing, and so does a repeat.
    expect((await hook("user-prompt-submit", "sess-2", { prompt: "hi" })).stdout).toBe("");
    expect((await hook("user-prompt-submit", "sess-1", { prompt: "hi" })).stdout).toBe("");
    const checks = fake.toolCalls().filter((c) => c.name === "check_inbox");
    expect(checks.map((c) => c.arguments["agent_id"])).toEqual([one, one, two, one]);
  });

  test("session-end disconnects the session's agent and prints nothing", async () => {
    const agentId = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1];
    const ended = await hook("session-end", "sess-1");
    expect(ended.code).toBe(0);
    expect(ended.stdout).toBe("");
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "disconnect", arguments: { agent_id: agentId } });
  });

  test("outside a bound repo a hook is inert: no output, no request, exit 0, even for a session that has an agent", async () => {
    // A session that already has an agent and a waiting message, so a hook that did run would have something to do.
    const agentId = AGENT_LINE.exec((await hook("session-start", "sess-9", { source: "startup" })).stdout)?.[1] as string;
    fake.enqueueMessage(agentId, "must not be delivered here");
    const before = fake.requests.length;
    for (const event of ["session-start", "user-prompt-submit", "session-end"]) {
      const result = await hook(event, "sess-9", { source: "startup" }, { cwd: box.outside });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
    expect(fake.requests.length).toBe(before);
    expect(fake.agents).toHaveLength(1);
    // Back in the repo the message is still waiting.
    expect((await hook("user-prompt-submit", "sess-9", { prompt: "hi" })).stdout).toContain("must not be delivered here");
  });

  test("nothing a hook gets wrong fails the harness: garbage input, an unknown event, a dead server", async () => {
    const garbage = await box.run(["hook", "session-start", "--harness", "claude-code"], { stdin: "{not json" });
    expect(garbage.code).toBe(0);
    const unknown = await box.run(["hook", "no-such-event"], { stdin: "{}" });
    expect(unknown.code).toBe(0);
    expect(unknown.stdout).toBe("");

    await fake.close();
    const dead = await hook("session-start", "sess-1", { source: "startup" });
    expect(dead.code).toBe(0);
    expect(dead.stdout).toContain("unreachable");
    fake = await startFakeServer();
  });

  test("a revoked key is reported in the injected line, not as a failure", async () => {
    fake.revoke(FAKE_KEY);
    const result = await hook("session-start", "sess-1", { source: "startup" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("jubarteai login");
    expect(box.findLeaks([FAKE_KEY])).toEqual([]);
  });

  test("with nobody signed in, session-start says so and the others stay quiet", async () => {
    await box.run(["logout"]);
    const start = await hook("session-start", "sess-1", { source: "startup" });
    expect(start.code).toBe(0);
    expect(start.stdout).toContain("not signed in");
    expect((await hook("user-prompt-submit", "sess-1", { prompt: "hi" })).stdout).toBe("");
  });

  test("a hook in a harness with its own injection format prints that format", async () => {
    const gemini = await hook("session-start", "g-1", { source: "startup" }, { harness: "gemini-cli" });
    expect(gemini.code).toBe(0);
    const parsed = JSON.parse(gemini.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(AGENT_LINE);
  });

  describe("stop (Claude Code: arm the inbox watcher before going idle)", () => {
    const watcher = (agentId: string) => ({ type: "shell", status: "running", command: `jubarteai inbox --agent ${agentId} --watch --session` });

    test("asks an agent that is about to go idle to arm a watcher: one block, no network call, exit 0", async () => {
      const agentId = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1] as string;
      const before = fake.requests.length;
      const result = await hook("stop", "sess-1", { stop_hook_active: false, background_tasks: [] });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      const body = JSON.parse(result.stdout) as { decision: string; reason: string };
      expect(body.decision).toBe("block");
      expect(body.reason).toContain(`jubarteai inbox --agent ${agentId} --watch --session`);
      expect(fake.requests.length).toBe(before);
      expect(box.findLeaks([FAKE_KEY])).toEqual([]);
    });

    test("is silent once a watcher is running, on the re-entry after its own block, and outside a bound repo", async () => {
      const agentId = AGENT_LINE.exec((await hook("session-start", "sess-1", { source: "startup" })).stdout)?.[1] as string;
      const running = await hook("stop", "sess-1", { stop_hook_active: true, background_tasks: [watcher(agentId)] });
      expect(running.code).toBe(0);
      expect(running.stdout).toBe("");
      expect((await hook("stop", "sess-1", { stop_hook_active: true, background_tasks: [] })).stdout).toBe("");
      expect((await hook("stop", "sess-1", { background_tasks: [watcher(agentId)] })).stdout).toBe("");
      const outside = await hook("stop", "sess-1", { background_tasks: [] }, { cwd: box.outside });
      expect(outside.code).toBe(0);
      expect(outside.stdout).toBe("");
      // A session with no agent has nothing to watch for.
      expect((await hook("stop", "sess-none", { background_tasks: [] })).stdout).toBe("");
    });

    test("is silent in an unattended run and in a harness that imported the hook", async () => {
      await hook("session-start", "sess-1", { source: "startup" });
      const input = JSON.stringify({ session_id: "sess-1", cwd: box.repo, background_tasks: [] });
      const sdk = await box.run(["hook", "stop", "--harness", "claude-code"], { stdin: input, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
      expect(sdk.code).toBe(0);
      expect(sdk.stdout).toBe("");
      // The explicit opt-out silences a session that reports itself interactive (an automated runner driving a full `claude`).
      const interactive = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" };
      expect(JSON.parse((await box.run(["hook", "stop", "--harness", "claude-code"], { stdin: input, env: interactive })).stdout)).toMatchObject({ decision: "block" });
      const optedOut = await box.run(["hook", "stop", "--harness", "claude-code"], { stdin: input, env: { ...interactive, JUBARTEAI_UNATTENDED: "1" } });
      expect(optedOut.code).toBe(0);
      expect(optedOut.stdout).toBe("");
      const cursorInput = JSON.stringify({ session_id: "sess-1", cwd: box.repo, cursor_version: "1.0", conversation_id: "c-1", background_tasks: [] });
      const imported = await box.run(["hook", "stop", "--harness", "claude-code"], { stdin: cursorInput });
      expect(imported.code).toBe(0);
      expect(imported.stdout).toBe("");
    });

    test("garbage on stdin never fails the harness", async () => {
      for (const stdin of ["", "{not json", "[]", "null"]) {
        const result = await box.run(["hook", "stop", "--harness", "claude-code"], { stdin });
        expect(result.code, stdin).toBe(0);
        expect(result.stdout).toBe("");
      }
    });
  });
});
