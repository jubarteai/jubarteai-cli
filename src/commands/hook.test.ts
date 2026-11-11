import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_A,
  AGENT_B,
  FAKE_KEY,
  SEAT_ID,
  createSandbox,
  deadOrigin,
  capture,
  expectNoSecrets,
  makeCtx,
  startFakeServer,
} from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { GUARD_INPUT_MAX_BYTES, HOOK_NETWORK_TIMEOUT_MS, HOOK_TOTAL_BUDGET_MS } from "../constants.js";
import { routeWith } from "../cli/router.js";
import { SESSION_END_NETWORK_TIMEOUT_MS, ownHookFile } from "../hooks/events.js";
import { homeDir } from "../paths.js";
import { callTool } from "../mcp/client.js";
import { readSession, writeSession } from "../session/cache.js";
import { hookCommand, runHook } from "./hook.js";
import type { HookDeps } from "./hook.js";

let sandbox: Sandbox;
const servers: FakeServer[] = [];

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  sandbox.cleanup();
});

function bind(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".jubarteai"), { recursive: true });
  writeFileSync(
    join(root, ".jubarteai", "config.json"),
    JSON.stringify({
      version: 1,
      workspace: { id: "33333333-0000-4000-8000-0000000000c1", slug: "acme" },
      user: { email: "alice@example.com" },
    }),
  );
}

async function server(messages: unknown[] = []): Promise<FakeServer> {
  const s = await startFakeServer({
    tool: (name) => {
      if (name === "connect") return { messages, result: { agent_id: AGENT_A, name: "Swift Otter" } };
      if (name === "check_inbox") return { messages, result: { count: messages.length } };
      return { messages: [], result: {} };
    },
  });
  servers.push(s);
  return s;
}

function deps(over: Partial<HookDeps> = {}): HookDeps {
  return { call: callTool, budgetMs: HOOK_TOTAL_BUDGET_MS, networkTimeoutMs: HOOK_NETWORK_TIMEOUT_MS, endTimeoutMs: SESSION_END_NETWORK_TIMEOUT_MS, guardMaxBytes: GUARD_INPUT_MAX_BYTES, env: {}, ...over };
}

type Result = { code: number; out: string; err: string };

/** Runs the hook with `stdin` (an object is sent as JSON, a string as is, null leaves the stream open). */
async function hook(
  event: string | undefined,
  stdin: unknown,
  opts: { harness?: string; deps?: Partial<HookDeps> } = {},
): Promise<Result> {
  const { ctx, out, err } = makeCtx(sandbox.repo);
  const stream = new PassThrough();
  if (stdin !== null) stream.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  const flags: Record<string, unknown> = opts.harness === undefined ? { harness: "claude-code" } : { harness: opts.harness };
  const code = await runHook({ ...ctx, stdin: stream }, { flags, positionals: event === undefined ? [] : [event] }, deps(opts.deps));
  return { code, out: out(), err: err() };
}

const START = { session_id: "sess-1", cwd: "", source: "startup" };
const startPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...START, cwd: sandbox.repo, ...over });
const MESSAGES = [{ id: "m1", from_name: "Peer", content: "<untrusted_content>hi</untrusted_content>", priority: "urgent" }];

describe("hook command", () => {
  it("defines an internal command named hook with a --harness flag (registration is CW2's)", () => {
    expect(hookCommand.name).toBe("hook");
    expect(hookCommand.group).toBe("internal");
    expect(hookCommand.flags.map((f) => f.name)).toEqual(["harness"]);
  });

  it("routes through the real router: jubarteai hook session-start --harness claude-code", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const out = capture();
    const err = capture();
    const stdin = new PassThrough();
    stdin.end(JSON.stringify(startPayload()));
    const code = await routeWith([hookCommand], ["hook", "session-start", "--harness", "claude-code"], {
      stdout: out.stream,
      stderr: err.stream,
      stdin,
      cwd: sandbox.repo,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain(`Your JubarteAI agent_id is ${AGENT_A}`);
    expect(err.text()).toBe("");
  });
});

describe("acceptance (plan C7)", () => {
  it("not bound: no output, exit 0", async () => {
    const s = await server();
    sandbox.signIn(s.origin);
    expect(await hook("session-start", startPayload())).toEqual({ code: 0, out: "", err: "" });
    expect(s.requests).toHaveLength(0);
  });

  it("signed out: the hint", async () => {
    bind(sandbox.repo);
    const result = await hook("session-start", startPayload());
    expect(result.code).toBe(0);
    expect(result.out).toBe("JubarteAI: not signed in here, run jubarteai login (use the MCP tools if they're available).\n");
  });

  it("startup: connects, prints the identity line and the messages, caches the agent", async () => {
    bind(sandbox.repo);
    const s = await server(MESSAGES);
    sandbox.signIn(s.origin);
    const result = await hook("session-start", startPayload());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Your JubarteAI agent_id is ${AGENT_A} (Swift Otter).`);
    expect(result.out).toContain("JubarteAI messages: ");
    expect(result.out).toContain("<untrusted_content>hi</untrusted_content>");
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_A);
    expectNoSecrets(result.out + result.err, [FAKE_KEY]);
  });

  it("resume and compact with a cache hit: identity only and a fake server records zero requests", async () => {
    bind(sandbox.repo);
    const s = await server(MESSAGES);
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin, name: "Old" }, { overwrite: true });
    for (const source of ["resume", "compact"]) {
      const result = await hook("session-start", startPayload({ source }));
      expect(result.out.trimEnd().split("\n")).toHaveLength(1);
      expect(result.out).toContain(AGENT_B);
    }
    expect(s.requests).toHaveLength(0);
  });

  it("fork: connects a new agent and says it replaces the earlier one", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    writeSession("claude-code", "parent", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    const result = await hook("session-start", startPayload({ source: "fork", session_id: "fork-1" }));
    expect(s.toolCalls().map((c) => c.name)).toEqual(["connect"]);
    expect(result.out).toContain("it replaces any earlier JubarteAI agent_id in this conversation.");
  });

  it("user-prompt-submit: an empty inbox prints nothing, messages print identity plus messages", async () => {
    bind(sandbox.repo);
    const empty = await server([]);
    sandbox.signIn(empty.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: empty.origin, name: "Swift Otter" }, { overwrite: true });
    expect(await hook("user-prompt-submit", startPayload())).toEqual({ code: 0, out: "", err: "" });

    const full = await server(MESSAGES);
    sandbox.signIn(full.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: full.origin, name: "Swift Otter" }, { overwrite: true });
    const result = await hook("user-prompt-submit", startPayload());
    expect(result.out).toContain(`agent_id is ${AGENT_A}`);
    expect(result.out).toContain("JubarteAI messages: ");
  });

  it("session-end: disconnects, prints nothing", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    const result = await hook("session-end", startPayload());
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(s.toolCalls()).toEqual([{ name: "disconnect", arguments: { agent_id: AGENT_A } }]);
  });

  it("network down: the unreachable line on start, nothing on the other events", async () => {
    bind(sandbox.repo);
    const dead = await deadOrigin();
    sandbox.signIn(dead);
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: dead }, { overwrite: true });
    expect((await hook("session-start", startPayload())).out).toBe("JubarteAI is unreachable right now; retry with jubarteai connect later.\n");
    expect(await hook("user-prompt-submit", startPayload())).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("session-end", startPayload())).toEqual({ code: 0, out: "", err: "" });
  });
});

describe("never fails the harness (exit 0)", () => {
  it("malformed, empty, oversized or non-object stdin", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    for (const stdin of ["", "{ nope", "[]", "null", "x".repeat(2 * 1024 * 1024)]) {
      const result = await hook("session-start", stdin);
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
    }
  });

  it("an unknown or missing event", async () => {
    expect(await hook("post-tool-use", startPayload())).toEqual({ code: 0, out: "", err: "" });
    expect(await hook(undefined, startPayload())).toEqual({ code: 0, out: "", err: "" });
  });

  it("an exception inside the work prints nothing and says nothing", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const result = await hook("session-start", startPayload(), {
      deps: {
        call: () => {
          throw new Error(`boom ${FAKE_KEY}`);
        },
      },
    });
    expect(result).toEqual({ code: 0, out: "", err: "" });
  });

  it("a server that stalls past the 6.5 s budget (fake timers): exit 0 and no output", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = hook("session-start", startPayload(), {
      deps: {
        call: (_seat, _tool, _args, opts) => {
          signal = opts?.signal;
          return new Promise(() => undefined);
        },
      },
    });
    await vi.advanceTimersByTimeAsync(HOOK_TOTAL_BUDGET_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ code: 0, out: "", err: "" });
    expect(signal?.aborted).toBe(true);
  });

  it("a stdin that never closes is cut at the budget", async () => {
    bind(sandbox.repo);
    vi.useFakeTimers();
    const pending = hook("session-start", null);
    await vi.advanceTimersByTimeAsync(HOOK_TOTAL_BUDGET_MS);
    expect(await pending).toEqual({ code: 0, out: "", err: "" });
  });

  it("a real stalled server is cut at the network timeout and reported as unreachable", async () => {
    bind(sandbox.repo);
    const stalled = await startFakeServer({ mcp: () => true });
    servers.push(stalled);
    sandbox.signIn(stalled.origin);
    const result = await hook("session-start", startPayload(), { deps: { networkTimeoutMs: 150 } });
    expect(result.code).toBe(0);
    expect(result.out).toContain("unreachable");
  });
});

describe("detection and per-harness output", () => {
  const CURSOR_STDIN = (): Record<string, unknown> => ({
    conversation_id: "conv-1",
    session_id: "cur-1",
    cursor_version: "1.7.0",
    workspace_roots: [sandbox.repo],
  });

  it("a Claude-registered hook that receives Cursor-shaped stdin does nothing: Cursor's own hook connects (no second agent)", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    // Cursor's own hooks, as init registers them: only then does the imported Claude hook stand aside.
    const cursorHooks = ownHookFile("cursor", homeDir(), process.env) as string;
    mkdirSync(dirname(cursorHooks), { recursive: true });
    writeFileSync(
      cursorHooks,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: "jubarteai hook session-start --harness cursor", timeout: 8 }],
          sessionEnd: [{ command: "jubarteai hook session-end --harness cursor", timeout: 3 }],
        },
      }),
    );
    expect(await hook("session-start", CURSOR_STDIN(), { harness: "claude-code" })).toEqual({ code: 0, out: "", err: "" });
    expect(s.requests).toHaveLength(0);
    expect(readSession("cursor", "cur-1")).toBeNull();
    expect(readSession("claude-code", "cur-1")).toBeNull();
    // Nor does its session-end disconnect what Cursor's own hook owns.
    writeSession("cursor", "cur-1", { harness: "cursor", agent_id: AGENT_A, seat_id: SEAT_ID, origin: s.origin }, { overwrite: true });
    expect(await hook("session-end", CURSOR_STDIN(), { harness: "claude-code" })).toEqual({ code: 0, out: "", err: "" });
    expect(s.requests).toHaveLength(0);
  });

  it("the Cursor-registered hook on Cursor stdin connects once, in Cursor's format and under Cursor's cache key", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const result = await hook("session-start", CURSOR_STDIN(), { harness: "cursor" });
    const parsed = JSON.parse(result.out) as { additional_context: string };
    expect(parsed.additional_context).toContain(AGENT_A);
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
    expect(readSession("cursor", "cur-1")?.agent_id).toBe(AGENT_A);
    expect(s.toolCalls()).toEqual([{ name: "connect", arguments: { description: `cursor on ${sandbox.repo.split("/").pop()?.toLowerCase()}` } }]);
  });

  it("Devin's environment makes it the Windsurf product, which has no injection: nothing printed, no request", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const result = await hook("session-start", startPayload(), { deps: { env: { DEVIN_PROJECT_DIR: sandbox.repo } } });
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(s.requests).toHaveLength(0);
  });

  it("Gemini CLI gets only hookSpecificOutput JSON; Codex gets plain stdout", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const gemini = await hook("session-start", startPayload({ session_id: "g-1" }), { harness: "gemini-cli" });
    expect(Object.keys(JSON.parse(gemini.out) as object)).toEqual(["hookSpecificOutput"]);
    const codex = await hook("session-start", startPayload({ session_id: "x-1" }), { harness: "codex" });
    expect(codex.out.startsWith("Your JubarteAI agent_id is ")).toBe(true);
  });

  it("falls back to the environment's session id when stdin has none", async () => {
    bind(sandbox.repo);
    const s = await server();
    sandbox.signIn(s.origin);
    const result = await hook("session-start", { cwd: sandbox.repo, source: "startup" }, { deps: { env: { CLAUDE_CODE_SESSION_ID: "env-sess" } } });
    expect(result.out).toContain(AGENT_A);
    expect(readSession("claude-code", "env-sess")?.agent_id).toBe(AGENT_A);
  });

  it("never prints the key, even when a server message echoes it", async () => {
    bind(sandbox.repo);
    const s = await server([{ id: "m", content: `<untrusted_content>my key is ${FAKE_KEY}</untrusted_content>` }]);
    sandbox.signIn(s.origin);
    const result = await hook("session-start", startPayload());
    expect(result.out).toContain("JubarteAI messages: ");
    expectNoSecrets(result.out + result.err, [FAKE_KEY]);
  });
});

describe("pre-tool-use (the shared Copilot file's guard)", () => {
  const call = (command: string, toolName = "bash"): Record<string, unknown> => ({ sessionId: "s", cwd: sandbox.repo, toolName, toolArgs: JSON.stringify({ command }) });

  it("denies a shell call that runs a person command, with no binding, no login and no request", async () => {
    const s = await server();
    const result = await hook("pre-tool-use", call("jubarteai inbox && jubarteai \"login\" --with-token"), { harness: "vscode" });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const out = JSON.parse(result.out) as Record<string, unknown>;
    expect(out["permissionDecision"]).toBe("deny");
    expect(out["permissionDecisionReason"]).toContain("jubarteai login");
    expect(s.requests).toHaveLength(0);
  });

  it("prints {} (no decision) for an agent command, another tool, empty or broken stdin", async () => {
    for (const stdin of [call("jubarteai inbox --agent x"), { toolName: "edit", toolArgs: { new_str: "jubarteai login" } }, "", "{", "[]"]) {
      expect(await hook("pre-tool-use", stdin, { harness: "vscode" }), JSON.stringify(stdin)).toEqual({ code: 0, out: "{}\n", err: "" });
    }
  });

  it("routes through the real router and prints exactly one JSON object", async () => {
    const out = capture();
    const err = capture();
    const stdin = new PassThrough();
    stdin.end(JSON.stringify(call("jubarteai init --yes")));
    const code = await routeWith([hookCommand], ["hook", "pre-tool-use", "--harness", "vscode"], { stdout: out.stream, stderr: err.stream, stdin, cwd: sandbox.repo });
    expect(code).toBe(0);
    expect(err.text()).toBe("");
    expect(out.text().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out.text())).toMatchObject({ permissionDecision: "deny" });
  });

  it("reads a payload past 1 MiB whole, so padding before the command can't hide it (review R-S14)", async () => {
    const before = JSON.stringify(call(`echo ${"x".repeat(1024 * 1024 + 100)}; jubarteai login`));
    expect(JSON.parse((await hook("pre-tool-use", before, { harness: "vscode" })).out)).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("jubarteai login") });
    // A description padded ahead of the command in the arguments object, too.
    const padded = JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ description: "y".repeat(1024 * 1024 + 100), command: "jubarteai logout" }) });
    expect(JSON.parse((await hook("pre-tool-use", padded, { harness: "vscode" })).out)).toMatchObject({ permissionDecision: "deny" });
    const after = JSON.stringify(call(`jubarteai logout; echo ${"x".repeat(1024 * 1024 + 10)}`));
    expect(JSON.parse((await hook("pre-tool-use", after, { harness: "vscode" })).out)).toMatchObject({ permissionDecision: "deny" });
    const innocent = JSON.stringify(call(`echo ${"x".repeat(1024 * 1024 + 10)}; jubarteai inbox`));
    expect((await hook("pre-tool-use", innocent, { harness: "vscode" })).out).toBe("{}\n");
  });

  it("denies a payload past the guard's read cap, whatever it holds, since the unread rest could hide a person command", async () => {
    const cap = 64 * 1024;
    const over = JSON.stringify(call(`echo ${"x".repeat(cap)}`));
    const result = await hook("pre-tool-use", over, { harness: "vscode", deps: { guardMaxBytes: cap } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("too large") });
    const under = JSON.stringify(call(`echo ${"x".repeat(cap / 2)}`));
    expect((await hook("pre-tool-use", under, { harness: "vscode", deps: { guardMaxBytes: cap } })).out).toBe("{}\n");
  });

  it("a stdin that never closes is cut at the budget with no decision, so the harness's normal flow decides", async () => {
    const result = await hook("pre-tool-use", null, { harness: "vscode", deps: { budgetMs: 50 } });
    expect(result).toEqual({ code: 0, out: "{}\n", err: "" });
  });
});
