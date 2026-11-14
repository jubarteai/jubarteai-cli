// The company-skills side of the session hooks, driven through runHookEvent (the production entry point) against
// a fake MCP server: `skills_revision` from connect / check_inbox starts one detached `skills sync --background`
// when it differs from what the repo last synced, and the lines a background sync left are injected once.
// `spawn` is replaced so no child process starts; everything else (state files, the server, the router) is real.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }> }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawned.calls.push({ command, args, options });
      return { on: () => undefined, unref: () => undefined };
    },
  };
});

import { AGENT_A, FAKE_KEY, SEAT_ID, createSandbox, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { callTool } from "../mcp/client.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { writeSession } from "../session/cache.js";
import { emptyState, readState, writeState } from "../skills/state.js";
import { runHookEvent } from "./events.js";
import type { HookEvent, HookRuntime } from "./events.js";
import { identityLine } from "./inject.js";
import type { HookInput } from "./input.js";

const COMPANY_ID = "33333333-0000-4000-8000-0000000000c1";
const NOTICE = "Company skills synced: 1 added, 0 updated, 0 removed.";

let sandbox: Sandbox;
const servers: FakeServer[] = [];

beforeEach(() => {
  sandbox = createSandbox();
  spawned.calls.length = 0;
  mkdirSync(join(sandbox.repo, ".git"), { recursive: true });
  mkdirSync(join(sandbox.repo, ".jubarteai"), { recursive: true });
  writeFileSync(
    join(sandbox.repo, ".jubarteai", "config.json"),
    JSON.stringify({ version: 1, workspace: { id: COMPANY_ID, slug: "acme" }, user: { email: "alice@example.com" } }),
  );
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  sandbox.cleanup();
});

/** A server whose connect / check_inbox carry `revision` as skills_revision (omitted when undefined). */
async function server(revision: unknown, messages: unknown[] = []): Promise<FakeServer> {
  const s = await startFakeServer({
    tool: (name) => {
      const extra = revision === undefined ? {} : { skills_revision: revision };
      if (name === "connect") return { messages, result: { agent_id: AGENT_A, name: "Swift Otter", ...extra } };
      if (name === "check_inbox") return { messages, result: { count: messages.length, ...extra } };
      return { messages: [], result: {} };
    },
  });
  servers.push(s);
  return s;
}

function runtime(): HookRuntime {
  return { call: callTool, networkTimeoutMs: 5000, endTimeoutMs: 1000, signal: new AbortController().signal };
}

function input(event: HookEvent, over: Partial<HookInput> = {}): HookInput {
  return { harness: "claude-code", hint: "claude-code", event, sessionId: "sess-1", source: "startup", cwd: sandbox.repo, ...over };
}

function cacheAgent(origin: string): void {
  writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin, name: "Swift Otter" }, { overwrite: true });
}

const identity = identityLine(AGENT_A, "Swift Otter");

describe("session-start and company skills", () => {
  it("a changed skills_revision starts one detached background sync for this agent and revision", async () => {
    const s = await server(5);
    sandbox.signIn(s.origin);
    const out = await runHookEvent(input("session-start"), runtime());
    expect(out).toBe(`${identity}\n`);
    expect(spawned.calls).toHaveLength(1);
    const [call] = spawned.calls;
    expect(call?.command).toBe(process.execPath);
    expect(call?.args.slice(1)).toEqual(["skills", "sync", "--background", "--agent", AGENT_A, "--if-changed", "5"]);
    expect(call?.options).toMatchObject({ cwd: sandbox.repo, detached: true, stdio: "ignore" });
  });

  it("the same revision starts nothing, and a pending notice follows the identity line once", async () => {
    const s = await server(5);
    sandbox.signIn(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5, pending_notice: [NOTICE] });
    expect(await runHookEvent(input("session-start"), runtime())).toBe(`${identity}\n${NOTICE}\n`);
    expect(spawned.calls).toHaveLength(0);
    expect(readState(sandbox.repo, s.origin).pending_notice).toEqual([]);
    expect(await runHookEvent(input("session-start", { sessionId: "sess-2" }), runtime())).toBe(`${identity}\n`);
  });

  it("an unreported clash is injected once", async () => {
    const s = await server(5);
    sandbox.signIn(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5, clashes: { alpha: { reported: false, dir: ".claude/skills" } } });
    const out = await runHookEvent(input("session-start"), runtime());
    expect(out).toContain("Company skill `alpha` was not synced: .claude/skills/alpha already exists and isn't managed by JubarteAI");
    expect(readState(sandbox.repo, s.origin).clashes["alpha"]?.reported).toBe(true);
    expect(await runHookEvent(input("session-start", { sessionId: "sess-2" }), runtime())).toBe(`${identity}\n`);
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "5"],
  ])("a %s skills_revision starts nothing (an older server, or a bad answer)", async (_label, revision) => {
    const s = await server(revision);
    sandbox.signIn(s.origin);
    expect(await runHookEvent(input("session-start"), runtime())).toBe(`${identity}\n`);
    expect(spawned.calls).toHaveLength(0);
  });

  it("under an environment key it never starts a background sync (the child would have no key)", async () => {
    const s = await server(5);
    process.env["JUBARTEAI_URL"] = s.origin;
    process.env["JUBARTEAI_TOKEN"] = FAKE_KEY;
    resetEnvTokenForTests();
    expect(await runHookEvent(input("session-start"), runtime())).toContain(AGENT_A);
    expect(spawned.calls).toHaveLength(0);
  });

  it("a resume with a cached agent flushes the pending notice without a request or a sync", async () => {
    const s = await server(9);
    sandbox.signIn(s.origin);
    cacheAgent(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 1, pending_notice: [NOTICE] });
    expect(await runHookEvent(input("session-start", { source: "resume" }), runtime())).toBe(`${identity}\n${NOTICE}\n`);
    expect(s.requests).toHaveLength(0);
    expect(spawned.calls).toHaveLength(0);
  });
});

describe("user-prompt-submit and company skills", () => {
  it("an empty inbox still injects a pending notice once, then nothing", async () => {
    const s = await server(5);
    sandbox.signIn(s.origin);
    cacheAgent(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5, pending_notice: [NOTICE] });
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe(`${identity}\n${NOTICE}\n`);
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");
    expect(spawned.calls).toHaveLength(0);
  });

  it("a skills_revision changed since the last sync starts the background sync from the inbox check", async () => {
    const s = await server(6);
    sandbox.signIn(s.origin);
    cacheAgent(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5 });
    expect(await runHookEvent(input("user-prompt-submit"), runtime())).toBe("");
    expect(spawned.calls.map((c) => c.args.slice(1))).toEqual([["skills", "sync", "--background", "--agent", AGENT_A, "--if-changed", "6"]]);
  });

  it("holds the sync off for 10 minutes after a failed one", async () => {
    const s = await server(6);
    sandbox.signIn(s.origin);
    cacheAgent(s.origin);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5, last_failure_at: Date.now() - 60_000 });
    await runHookEvent(input("user-prompt-submit"), runtime());
    expect(spawned.calls).toHaveLength(0);
    writeState(sandbox.repo, { ...emptyState(s.origin), revision: 5, last_failure_at: Date.now() - 11 * 60_000 });
    await runHookEvent(input("user-prompt-submit"), runtime());
    expect(spawned.calls).toHaveLength(1);
  });
});
