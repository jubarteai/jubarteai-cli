import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_A, AGENT_B, SEAT_ID, createSandbox, deadOrigin, expectNoSecrets, sendJson, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { callTool } from "../mcp/client.js";
import { homeDir, sessionsDir } from "../paths.js";
import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { resolveAgent } from "../session/agent.js";
import { keyFingerprint, readSession, sessionKey, writeSession } from "../session/cache.js";
import type { HarnessId } from "../session/harness-env.js";
import { SESSION_END_NETWORK_TIMEOUT_MS, ownHookFile, ownHookRegistered, parseHookEvent, runHookEvent } from "./events.js";
import type { HookEvent, HookRuntime } from "./events.js";
import { identityLine } from "./inject.js";
import type { HookInput } from "./input.js";

let sandbox: Sandbox;
const servers: FakeServer[] = [];

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  sandbox.cleanup();
});

const COMPANY_ID = "33333333-0000-4000-8000-0000000000c1";

function bind(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".jubarteai"), { recursive: true });
  writeFileSync(
    join(root, ".jubarteai", "config.json"),
    JSON.stringify({ version: 1, workspace: { id: COMPANY_ID, slug: "acme" }, user: { email: "alice@example.com" } }),
  );
}

async function server(opts: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> {
  const s = await startFakeServer(opts);
  servers.push(s);
  return s;
}

function runtime(over: Partial<HookRuntime> = {}): HookRuntime {
  return { call: callTool, networkTimeoutMs: 5000, endTimeoutMs: 1000, signal: new AbortController().signal, ...over };
}

function input(event: HookEvent, over: Partial<HookInput> = {}): HookInput {
  const harness = over.harness === undefined ? "claude-code" : over.harness;
  return { harness, hint: harness, event, sessionId: "sess-1", source: "startup", cwd: sandbox.repo, ...over };
}

const MESSAGES = [{ id: "m1", from_name: "Peer", content: "<untrusted_content>hello</untrusted_content>", priority: "normal" }];

function connectingServer(messages: unknown[] = []): Promise<FakeServer> {
  return server({
    tool: (name, args) => {
      if (name === "connect") return { messages, result: { agent_id: AGENT_A, name: "Swift Otter", args } };
      if (name === "check_inbox") return { messages, result: { count: messages.length } };
      return { messages: [], result: { disconnected: true } };
    },
  });
}

describe("session-start", () => {
  it("prints nothing and makes no request outside a bound repo (D28, I7)", async () => {
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);
  });

  it("prints nothing outside a bound repo even when signed out", async () => {
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");
  });

  it("prints nothing for a binding that is not valid", async () => {
    mkdirSync(join(sandbox.repo, ".jubarteai"), { recursive: true });
    writeFileSync(join(sandbox.repo, ".jubarteai", "config.json"), "{ nope");
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");
  });

  it("injects the not-signed-in line when bound but signed out", async () => {
    bind(sandbox.repo);
    expect(await runHookEvent(input("session-start"), runtime())).toBe(
      "JubarteAI: not signed in here, run jubarteai login (use the MCP tools if they're available).\n",
    );
  });

  it("startup: connects with '<harness> on <repo slug>', caches the agent, injects identity plus drained messages", async () => {
    const root = join(sandbox.repo, "My Repo.git");
    bind(root);
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    const out = await runHookEvent(input("session-start", { cwd: join(root, "src") }), runtime());
    expect(s.toolCalls()).toEqual([{ name: "connect", arguments: { description: "claude-code on my-repo.git" } }]);
    const [first, second] = out.trimEnd().split("\n");
    expect(first).toBe(identityLine(AGENT_A, "Swift Otter"));
    expect(JSON.parse(second?.slice("JubarteAI messages: ".length) ?? "")).toEqual({ messages: MESSAGES });
    expect(readSession("claude-code", "sess-1")).toMatchObject({ agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin, name: "Swift Otter" });
    expectNoSecrets(out);
  });

  it("an empty inbox gives the identity line alone", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe(`${identityLine(AGENT_A, "Swift Otter")}\n`);
  });

  describe("under an environment key (no seat id)", () => {
    const ENV_KEY = "jba_ENVKEYONEENVKEYONEENVKEYONE01";
    const OTHER_ENV_KEY = "jba_ENVKEYTWOENVKEYTWOENVKEYTWO02";

    async function startUnderEnvKey(key: string): Promise<FakeServer> {
      bind(sandbox.repo);
      const s = await connectingServer(MESSAGES);
      process.env["JUBARTEAI_URL"] = s.origin;
      process.env["JUBARTEAI_TOKEN"] = key;
      resetEnvTokenForTests();
      return s;
    }

    it("stores the key fingerprint (never the key), so a later command without --agent accepts the entry", async () => {
      const s = await startUnderEnvKey(ENV_KEY);
      await runHookEvent(input("session-start"), runtime());
      const entry = readSession("claude-code", "sess-1");
      expect(entry).toMatchObject({ agent_id: AGENT_A, seat_id: null, key_fp: keyFingerprint(ENV_KEY) });
      expect(JSON.stringify(entry)).not.toContain("ENVKEYONE");
      expect(s.toolCalls()).toHaveLength(1);

      // The command side: the same environment key, the same session, no --agent.
      process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
      const seat = resolveSeat({ cwd: sandbox.repo });
      if (isResolveError(seat)) throw new Error("the environment key should resolve");
      expect(resolveAgent({ seat })).toEqual({ agentId: AGENT_A });
    });

    it("the hooks and the commands agree: a user-prompt-submit and a session-end use the entry for the same key only", async () => {
      const s = await startUnderEnvKey(ENV_KEY);
      await runHookEvent(input("session-start"), runtime());
      await runHookEvent(input("user-prompt-submit"), runtime());
      await runHookEvent(input("session-end"), runtime());
      expect(s.toolCalls().map((c) => c.name)).toEqual(["connect", "check_inbox", "disconnect"]);

      // An entry written for another environment key (or with no fingerprint) is not this key's agent.
      writeSession("claude-code", "sess-2", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: s.origin, key_fp: keyFingerprint(OTHER_ENV_KEY) }, { overwrite: true });
      writeSession("claude-code", "sess-3", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: s.origin }, { overwrite: true });
      const before = s.toolCalls().length;
      expect(await runHookEvent(input("user-prompt-submit", { sessionId: "sess-2" }), runtime())).toBe("");
      expect(await runHookEvent(input("session-end", { sessionId: "sess-3" }), runtime())).toBe("");
      expect(s.toolCalls()).toHaveLength(before);
    });

    it("a resume reuses the entry written for this key, and connects anew for another key's", async () => {
      const s = await startUnderEnvKey(ENV_KEY);
      writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: s.origin, key_fp: keyFingerprint(ENV_KEY), name: "Old" }, { overwrite: true });
      expect(await runHookEvent(input("session-start", { source: "resume" }), runtime())).toBe(`${identityLine(AGENT_B, "Old")}\n`);
      expect(s.requests).toHaveLength(0);

      writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: s.origin, key_fp: keyFingerprint(OTHER_ENV_KEY) }, { overwrite: true });
      expect(await runHookEvent(input("session-start", { source: "resume" }), runtime())).toContain(AGENT_A);
      expect(s.toolCalls()).toHaveLength(1);
    });
  });

  it.each(["resume", "compact"])("%s with a cache hit: identity line only and no network call", async (source) => {
    bind(sandbox.repo);
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin, name: "Old Name" }, { overwrite: true });
    const out = await runHookEvent(input("session-start", { source }), runtime());
    expect(out).toBe(`${identityLine(AGENT_B, "Old Name")}\n`);
    expect(s.requests).toHaveLength(0);
  });

  it("resume with a cache miss connects, and a cache entry for another seat or origin is a miss", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start", { source: "resume" }), runtime())).toContain(AGENT_A);
    expect(s.toolCalls()).toHaveLength(1);

    writeSession("claude-code", "sess-2", { harness: "claude-code", agent_id: AGENT_B, seat_id: "other-seat", origin: s.origin }, { overwrite: true });
    expect(await runHookEvent(input("session-start", { source: "resume", sessionId: "sess-2" }), runtime())).toContain(AGENT_A);
    expect(s.toolCalls()).toHaveLength(2);
  });

  it.each([["startup"], ["clear"], [null]])("source %s connects even with a cached agent, and overwrites the cache", async (source) => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin, name: "Old" }, { overwrite: true });
    const out = await runHookEvent(input("session-start", { source }), runtime());
    expect(out).toContain(AGENT_A);
    expect(s.toolCalls()).toHaveLength(1);
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_A);
  });

  it("fork connects a new agent and the output says it replaces the parent's identity", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    writeSession("claude-code", "parent", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    const out = await runHookEvent(input("session-start", { source: "fork", sessionId: "fork-1" }), runtime());
    expect(out).toContain(AGENT_A);
    expect(out).toContain("This is the only agent_id for this session: it replaces any earlier JubarteAI agent_id in this conversation.");
    expect(readSession("claude-code", "parent")?.agent_id).toBe(AGENT_B);
    expect(readSession("claude-code", "fork-1")?.agent_id).toBe(AGENT_A);
  });

  it("without a session id it still connects and injects, but remembers nothing", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start", { sessionId: null }), runtime())).toContain(AGENT_A);
  });

  it("network down: the unreachable line", async () => {
    bind(sandbox.repo);
    sandbox.signIn(await deadOrigin());
    expect(await runHookEvent(input("session-start"), runtime())).toBe("JubarteAI is unreachable right now; retry with jubarteai connect later.\n");
  });

  it("a 5xx is unreachable too, and a stalled server is cut at the network timeout", async () => {
    bind(sandbox.repo);
    const down = await server({ mcp: (_req, res) => (sendJson(res, 503, { error: "x" }), true) });
    sandbox.signIn(down.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toContain("unreachable");

    const stalled = await server({ mcp: () => true });
    sandbox.signIn(stalled.origin);
    expect(await runHookEvent(input("session-start"), runtime({ networkTimeoutMs: 100 }))).toContain("unreachable");
  });

  it("a revoked key hints at login; a billing or seat refusal says nothing", async () => {
    bind(sandbox.repo);
    const revoked = await server({ mcp: (_req, res) => (sendJson(res, 401, { error: "revoked_api_key" }), true) });
    sandbox.signIn(revoked.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toContain("not signed in here");

    const billing = await server({ mcp: (_req, res) => (sendJson(res, 402, { error: "billing_inactive" }), true) });
    sandbox.signIn(billing.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");
  });

  it("says nothing when the server answers with an error or no agent", async () => {
    bind(sandbox.repo);
    const failing = await server({ tool: () => ({ messages: [], error: "agent limit reached" }) });
    sandbox.signIn(failing.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");

    const odd = await server({ tool: () => ({ messages: [], result: { agent_id: "not-a-uuid" } }) });
    sandbox.signIn(odd.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe("");
  });

  it("still injects when the cache can't be written", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    // A file where the sessions folder should be makes every write fail.
    writeFileSync(join(sandbox.dir, "tmp"), "not a directory");
    expect(await runHookEvent(input("session-start"), runtime())).toContain(AGENT_A);
  });

  it("is a no-op, with no request, for a harness that can't take the injection or none at all", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    for (const harness of ["windsurf", "zed", "opencode", null] as Array<HarnessId | null>) {
      expect(await runHookEvent(input("session-start", { harness }), runtime())).toBe("");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("formats per harness: Gemini JSON, Cursor additional_context, VS Code additionalContext", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    const gemini = JSON.parse(await runHookEvent(input("session-start", { harness: "gemini-cli" }), runtime())) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(gemini.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(gemini.hookSpecificOutput.additionalContext).toContain(AGENT_A);
    expect(JSON.parse(await runHookEvent(input("session-start", { harness: "cursor" }), runtime()))).toHaveProperty("additional_context");
    expect(JSON.parse(await runHookEvent(input("session-start", { harness: "vscode" }), runtime()))).toHaveProperty("additionalContext");
    expect(readSession("cursor", "sess-1")?.agent_id).toBe(AGENT_A);
  });
});

describe("user-prompt-submit", () => {
  it("prints nothing without a binding, a session id or a cached agent, and makes no request", async () => {
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");
    bind(sandbox.repo);
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");
    expect(await runHookEvent(input("user-prompt-submit", { sessionId: null }), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);
  });

  it("an empty inbox prints nothing", async () => {
    bind(sandbox.repo);
    const s = await connectingServer([]);
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin, name: "Swift Otter" }, { overwrite: true });
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");
    expect(s.toolCalls()).toEqual([{ name: "check_inbox", arguments: { agent_id: AGENT_A } }]);
  });

  it("messages: identity line plus the messages", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin, name: "Swift Otter" }, { overwrite: true });
    const out = await runHookEvent(input("user-prompt-submit"), runtime());
    const [first, second] = out.trimEnd().split("\n");
    expect(first).toBe(identityLine(AGENT_A, "Swift Otter"));
    expect(JSON.parse(second?.slice("JubarteAI messages: ".length) ?? "")).toEqual({ messages: MESSAGES });
  });

  it("prints nothing when the network is down, the server errors, or the harness has no per-prompt injection", async () => {
    bind(sandbox.repo);
    const dead = await deadOrigin();
    sandbox.signIn(dead);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: dead }, { overwrite: true });
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");

    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    writeSession("cursor", "sess-1", { harness: "cursor", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    expect(await runHookEvent(input("user-prompt-submit", { harness: "cursor" }), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);
  });

  it("works on Gemini CLI as BeforeAgent JSON", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    writeSession("gemini-cli", "sess-1", { harness: "gemini-cli", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    const out = JSON.parse(await runHookEvent(input("user-prompt-submit", { harness: "gemini-cli" }), runtime())) as { hookSpecificOutput: { hookEventName: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });
});

describe("session-end", () => {
  it("disconnects the cached agent with the 1 s timeout, prints nothing and keeps the cache", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    const timeouts: Array<number | undefined> = [];
    const out = await runHookEvent(
      input("session-end"),
      runtime({ call: (seat, tool, args, opts) => (timeouts.push(opts?.timeoutMs), callTool(seat, tool, args, opts)), endTimeoutMs: SESSION_END_NETWORK_TIMEOUT_MS }),
    );
    expect(out).toBe("");
    expect(s.toolCalls()).toEqual([{ name: "disconnect", arguments: { agent_id: AGENT_A } }]);
    expect(timeouts).toEqual([1000]);
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_A);
  });

  it("does nothing without a cached agent, outside a bound repo, or with the network down", async () => {
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-end"), runtime())).toBe("");
    bind(sandbox.repo);
    expect(await runHookEvent(input("session-end"), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);

    const dead = await deadOrigin();
    sandbox.signIn(dead);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: dead }, { overwrite: true });
    expect(await runHookEvent(input("session-end"), runtime())).toBe("");
  });

  it("disconnects on Cursor too, though it has no injection", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    writeSession("cursor", "sess-1", { harness: "cursor", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    expect(await runHookEvent(input("session-end", { harness: "cursor" }), runtime())).toBe("");
    expect(s.toolCalls()).toHaveLength(1);
  });
});

/** The key and `--harness` value `init` writes in each harness's own hook file (cursor.ts, vscode.ts). */
const OWN_KEY: Partial<Record<HookEvent, string>> = { "session-start": "sessionStart", "session-end": "sessionEnd" };

/** Writes the harness's own hook file the way init does, with `events` registered (an absolute program, as init writes it). */
function registerOwnHooks(harness: HarnessId, events: HookEvent[], program = '"/usr/local/bin/node" "/opt/jubarteai/bin/jubarteai.js"'): string {
  const file = ownHookFile(harness, homeDir(), process.env);
  if (file === null) throw new Error(`no hook file for ${harness}`);
  const hint = harness === "copilot-cli" ? "vscode" : harness;
  const hooks: Record<string, unknown> = {};
  for (const event of events) hooks[OWN_KEY[event] as string] = [{ type: "command", command: `${program} hook ${event} --harness ${hint}`, timeout: 8 }];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, hooks }));
  return file;
}

describe("a hook another harness's own registered hook duplicates (M4)", () => {
  it.each<[HarnessId, HookEvent]>([
    ["cursor", "session-start"],
    ["cursor", "session-end"],
    ["vscode", "session-start"],
    ["vscode", "session-end"],
    ["copilot-cli", "session-start"],
    ["copilot-cli", "session-end"],
  ])("detected %s differs from the claude-code hint on %s, and its own hook is registered: nothing, no request", async (harness, event) => {
    bind(sandbox.repo);
    const s = await connectingServer(MESSAGES);
    sandbox.signIn(s.origin);
    registerOwnHooks(harness, [event]);
    writeSession(harness, "sess-1", { harness, agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    expect(await runHookEvent(input(event, { harness, hint: "claude-code" }), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);
  });

  // Cursor installed after init, or its hooks declined: the Claude-registered hook is the only one that runs there.
  it.each<[string, () => void]>([
    ["no hook file", () => undefined],
    ["a hook file without our entry", () => registerOwnHooks("cursor", ["session-end"])],
    ["our entry for another harness", () => writeFileSync(registerOwnHooks("cursor", []), JSON.stringify({ hooks: { sessionStart: [{ command: "jubarteai hook session-start --harness claude-code" }] } }))],
    ["a file that isn't JSON", () => writeFileSync(registerOwnHooks("cursor", []), "{ // mine\n}")],
  ])("Cursor with %s: the claude-code hook connects the agent for Cursor", async (_name, setup) => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    setup();
    const out = await runHookEvent(input("session-start", { harness: "cursor", hint: "claude-code" }), runtime());
    expect(out).toContain(AGENT_A);
    expect(s.toolCalls()).toHaveLength(1);
    expect(readSession("cursor", "sess-1")?.agent_id).toBe(AGENT_A);
  });

  it("an unreadable hook file is 'not registered', never a throw", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const file = registerOwnHooks("cursor", ["session-start"]);
    expect(ownHookRegistered("cursor", "session-start", homeDir(), process.env)).toBe(true);
    chmodSync(file, 0o000);
    try {
      expect(ownHookRegistered("cursor", "session-start", homeDir(), process.env)).toBe(false);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("a Windsurf/Devin session never defers (no hook of ours exists there) and, with no injection, prints nothing", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(ownHookRegistered("windsurf", "session-start", homeDir(), process.env)).toBe(false);
    expect(await runHookEvent(input("session-start", { harness: "windsurf", hint: "claude-code" }), runtime())).toBe("");
    expect(s.requests).toHaveLength(0);
  });

  it("the same detected harness with its own hint, or with no hint, does the work", async () => {
    bind(sandbox.repo);
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start", { harness: "cursor", hint: "cursor" }), runtime())).toContain(AGENT_A);
    expect(await runHookEvent(input("session-start", { harness: "cursor", hint: null, sessionId: "sess-2" }), runtime())).toContain(AGENT_A);
    expect(s.toolCalls()).toHaveLength(2);
  });
});

describe("messages that don't fit are saved, not dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, content: `<untrusted_content>${"y".repeat(800)}</untrusted_content>` }));

  it("Claude Code: the rest goes to <sessions dir>/<session key>.overflow-<ts>.json (0600) and the output names it", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(many);
    sandbox.signIn(s.origin);
    const out = await runHookEvent(input("session-start"), runtime());
    expect(out.length).toBeLessThanOrEqual(10_000);
    const note = /JubarteAI: (\d+) more messages didn't fit; read them from (\S+)\n$/.exec(out);
    expect(note).not.toBeNull();
    const [, count, path] = note as RegExpExecArray;
    expect(path).toContain(`${sessionKey("claude-code", "sess-1")}.overflow-`);
    expect(path?.startsWith(sessionsDir())).toBe(true);
    const saved = JSON.parse(readFileSync(path as string, "utf8")) as { messages: Array<{ id: string }> };
    expect(saved.messages).toHaveLength(Number(count));
    const shown = JSON.parse(out.split("\n")[1]?.slice("JubarteAI messages: ".length) ?? "") as { messages: Array<{ id: string }> };
    expect([...shown.messages, ...saved.messages].map((m) => m.id)).toEqual(many.map((m) => m.id));
    if (process.platform !== "win32") expect(statSync(path as string).mode & 0o777).toBe(0o600);
  });

  it("Codex gets every message inline and no file is written", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(many);
    sandbox.signIn(s.origin);
    const out = await runHookEvent(input("session-start", { harness: "codex", hint: "codex" }), runtime());
    expect(out.length).toBeGreaterThan(10_000);
    expect(out).not.toContain("didn't fit");
    const shown = JSON.parse(out.split("\n")[1]?.slice("JubarteAI messages: ".length) ?? "") as { messages: unknown[] };
    expect(shown.messages).toHaveLength(30);
    expect(existsSync(sessionsDir()) ? readdirSync(sessionsDir()).filter((n) => n.includes("overflow")) : []).toEqual([]);
  });

  it("prunes overflow files older than 7 days, and keeps recent ones", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(many);
    sandbox.signIn(s.origin);
    mkdirSync(sessionsDir(), { recursive: true });
    const old = join(sessionsDir(), `${"a".repeat(32)}.overflow-1.json`);
    const recent = join(sessionsDir(), `${"b".repeat(32)}.overflow-2.json`);
    writeFileSync(old, "{}");
    writeFileSync(recent, "{}");
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, eightDays, eightDays);
    await runHookEvent(input("session-start"), runtime());
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("says they could not be saved when the sessions folder is unwritable", async () => {
    bind(sandbox.repo);
    const s = await connectingServer(many);
    sandbox.signIn(s.origin);
    writeFileSync(join(sandbox.dir, "tmp"), "not a directory");
    const out = await runHookEvent(input("session-start"), runtime());
    expect(out).toMatch(/didn't fit and could not be saved\.\n$/);
    expect(out.length).toBeLessThanOrEqual(10_000);
  });
});

describe("the connect description's repo slug", () => {
  async function descriptionFor(root: string, cwd: string): Promise<string> {
    const s = await connectingServer();
    sandbox.signIn(s.origin);
    await runHookEvent(input("session-start", { cwd }), runtime());
    const args = s.toolCalls()[0]?.arguments;
    return String(args?.["description"]);
  }

  it("is the git top level's folder name in the lowercase slug form", async () => {
    const root = join(sandbox.dir, "Some_Repo Name");
    bind(root);
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(await descriptionFor(root, join(root, "a", "b"))).toBe("claude-code on some_repo-name");
  });

  it("falls back to the binding's folder outside git, and to the harness alone when no usable name remains", async () => {
    const root = join(sandbox.dir, "Plain Folder");
    bind(root);
    rmSync(join(root, ".git"), { recursive: true });
    expect(await descriptionFor(root, root)).toBe("claude-code on plain-folder");

    const odd = join(sandbox.dir, "___");
    bind(odd);
    rmSync(join(odd, ".git"), { recursive: true });
    expect(await descriptionFor(odd, odd)).toBe("claude-code");
  });
});

describe("parseHookEvent", () => {
  it("knows the three events", () => {
    expect(parseHookEvent("session-start")).toBe("session-start");
    expect(parseHookEvent("user-prompt-submit")).toBe("user-prompt-submit");
    expect(parseHookEvent("session-end")).toBe("session-end");
    expect(parseHookEvent("SessionStart")).toBeNull();
    expect(parseHookEvent(undefined)).toBeNull();
  });
});
