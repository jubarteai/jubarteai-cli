import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionsDir } from "../paths.js";
import { keyFingerprint, readSession, writeSession } from "../session/cache.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { AGENT_A, AGENT_B, createSandbox, expectNoSecrets, FAKE_KEY, runCli, SEAT_ID, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { connectCommand } from "./connect.js";
import { TOOL_COMMANDS } from "./tool.js";

let sandbox: Sandbox;
const servers: FakeServer[] = [];
async function start(agentIds: string[]): Promise<FakeServer> {
  let n = 0;
  const server = await startFakeServer({
    tool: (name) => {
      if (name !== "connect") return { messages: [], result: {} };
      return { messages: [], result: { agent_id: agentIds[n++] ?? AGENT_B, name: `Agent ${n}` } };
    },
  });
  servers.push(server);
  return server;
}
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  sandbox.cleanup();
});

const run = (argv: string[]) => runCli([connectCommand], argv, sandbox.repo);

describe("connect", () => {
  it("calls the connect tool with the description and prints the envelope only", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    const result = await run(["connect", "--description", "Claude Code on jubarteai — CLI"]);
    expect(result.code).toBe(0);
    expect(server.toolCalls()).toEqual([{ name: "connect", arguments: { description: "Claude Code on jubarteai — CLI" } }]);
    expect(server.requests[0]?.headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(result.out)).toEqual({ messages: [], result: { agent_id: AGENT_A, name: "Agent 1" } });
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
    expectNoSecrets(result.out + result.err);
  });

  it("sends no description when none is given", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    await run(["connect"]);
    expect(server.toolCalls()[0]?.arguments).toEqual({});
  });

  it("writes the session cache (agent, seat, origin, name) when the harness session is known", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    const result = await run(["connect"]);
    expect(result.code).toBe(0);
    expect(readSession("claude-code", "sess-1")).toMatchObject({ agent_id: AGENT_A, seat_id: SEAT_ID, origin: server.origin, name: "Agent 1" });
    expect(result.err).toContain("cached for this session");
  });

  it("writes the cache only when absent: a second connect mints another agent but the session keeps its first", async () => {
    const server = await start([AGENT_A, AGENT_B]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    await run(["connect"]);
    const second = await run(["connect"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ result: { agent_id: AGENT_B } });
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_A);
    expect(second.err).toContain("Kept the existing agent for this session");
    expect(second.err).not.toContain("cached for this session");
  });

  it("treats an entry cached for another seat as absent: connect as seat B replaces it and B's commands use B's agent", async () => {
    const server = await start([AGENT_B]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    const otherSeat = "99999999-0000-4000-8000-000000000009";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: otherSeat, origin: server.origin }, { overwrite: true });
    const result = await run(["connect"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain("cached for this session");
    expect(readSession("claude-code", "sess-1")).toMatchObject({ agent_id: AGENT_B, seat_id: SEAT_ID });
    // a tool command as seat B now resolves B's agent
    const listed = await runCli([...TOOL_COMMANDS], ["list-agents"], sandbox.repo);
    expect(listed.code).toBe(0);
    expect(server.toolCalls().at(-1)).toEqual({ name: "list_agents", arguments: { agent_id: AGENT_B } });
    // and a same-seat entry is still never overwritten
    const again = await run(["connect"]);
    expect(again.err).toContain("Kept the existing agent");
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_B);
  });

  it("replaces an entry cached for another origin the same way", async () => {
    const server = await start([AGENT_B]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: "https://jubarte.ai" }, { overwrite: true });
    await run(["connect"]);
    expect(readSession("claude-code", "sess-1")).toMatchObject({ agent_id: AGENT_B, origin: server.origin });
  });

  it("with an environment key, stores its fingerprint and keeps its entry only for that key", async () => {
    const server = await start([AGENT_A, AGENT_B]);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    process.env["JUBARTEAI_URL"] = server.origin;
    process.env["JUBARTEAI_TOKEN"] = "jba_ENVKEYONEENVKEYONEENVKEYONE01";
    await run(["connect"]);
    const entry = readSession("claude-code", "sess-1");
    expect(entry).toMatchObject({ agent_id: AGENT_A, seat_id: null, key_fp: keyFingerprint("jba_ENVKEYONEENVKEYONEENVKEYONE01") });
    expect(JSON.stringify(entry)).not.toContain("ENVKEYONE");
    // another environment key is another account: its connect replaces the entry
    resetEnvTokenForTests();
    process.env["JUBARTEAI_TOKEN"] = "jba_ENVKEYTWOENVKEYTWOENVKEYTWO02";
    await run(["connect"]);
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_B);
  });

  it("keeps separate sessions apart (a fork or another harness gets its own agent)", async () => {
    const server = await start([AGENT_A, AGENT_B]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    await run(["connect"]);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-2";
    await run(["connect"]);
    expect(readSession("claude-code", "sess-1")?.agent_id).toBe(AGENT_A);
    expect(readSession("claude-code", "sess-2")?.agent_id).toBe(AGENT_B);
  });

  it("writes no cache without a session id and says to pass --agent", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    const result = await run(["connect"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(`--agent ${AGENT_A}`);
    expect(result.out).not.toContain("--agent");
  });

  it("still succeeds, with a note, when the cache can't be written", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    // A file where the per-user folder must be.
    mkdirSync(join(sandbox.dir, "tmp"), { recursive: true });
    writeFileSync(join(sessionsDir(), ".."), "in the way");
    const result = await run(["connect"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ result: { agent_id: AGENT_A } });
    expect(result.err).toContain(`--agent ${AGENT_A}`);
  });

  it("does not write the cache when the server refused", async () => {
    const server = await startFakeServer({ tool: () => ({ messages: [], error: "agent limit reached" }) });
    servers.push(server);
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    const result = await run(["connect"]);
    expect(result.code).toBe(1);
    expect(readSession("claude-code", "sess-1")).toBeNull();
  });

  it("rejects --agent: connect always registers a new agent", async () => {
    const server = await start([AGENT_A]);
    sandbox.signIn(server.origin);
    const result = await run(["connect", "--agent", AGENT_B]);
    expect(result.code).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it("is not signed in → exit 5", async () => {
    expect((await run(["connect"])).code).toBe(5);
  });
});
