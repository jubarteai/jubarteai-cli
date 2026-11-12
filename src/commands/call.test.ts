import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeSession } from "../session/cache.js";
import { AGENT_A, AGENT_B, createSandbox, expectNoSecrets, FAKE_WATCH_TOKEN, runCli, SEAT_ID, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { callCommand } from "./call.js";

let sandbox: Sandbox;
const servers: FakeServer[] = [];
async function start(options: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> {
  const server = await startFakeServer(options);
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

const run = (argv: string[]) => runCli([callCommand], argv, sandbox.repo);

describe("call", () => {
  it("sends a tool this CLI doesn't know, with the --json arguments as they are", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    const result = await run(["call", "brand_new_tool", "--json", '{"x":1,"nested":{"y":[1,2]}}']);
    expect(result.code).toBe(0);
    expect(server.toolCalls()).toEqual([{ name: "brand_new_tool", arguments: { x: 1, nested: { y: [1, 2] } } }]);
    expect(JSON.parse(result.out)).toMatchObject({ messages: [], result: { tool: "brand_new_tool" } });
  });

  it("sends {} when there is no --json", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    await run(["call", "brand_new_tool"]);
    expect(server.toolCalls()[0]?.arguments).toEqual({});
  });

  it("reads --json from a file", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    mkdirSync(sandbox.repo, { recursive: true });
    const file = join(sandbox.repo, "args.json");
    writeFileSync(file, '{"limit":2}');
    await run(["call", "new_tool", "--json", `@${file}`]);
    expect(server.toolCalls()[0]?.arguments).toEqual({ limit: 2 });
  });

  it("fills agent_id for an unknown tool when --agent or the cache gives one, and omits it otherwise", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    await run(["call", "new_tool"]);
    expect(server.toolCalls()[0]?.arguments).toEqual({});
    await run(["call", "new_tool", "--agent", AGENT_A]);
    expect(server.toolCalls()[1]?.arguments).toEqual({ agent_id: AGENT_A });
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: server.origin }, { overwrite: true });
    await run(["call", "new_tool"]);
    expect(server.toolCalls()[2]?.arguments).toEqual({ agent_id: AGENT_B });
  });

  it("keeps an agent_id given in --json (an explicit agent) and rejects one that is not a UUID", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    await run(["call", "new_tool", "--json", JSON.stringify({ agent_id: AGENT_A })]);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_A });
    expect((await run(["call", "new_tool", "--json", '{"agent_id":"bad"}'])).code).toBe(2);
    expect((await run(["call", "new_tool", "--json", '{"agent_id":7}'])).code).toBe(2);
    expect(server.requests).toHaveLength(1);
  });

  it("holds a known tool to its rules: list_agents needs an agent (exit 2)", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    const result = await run(["call", "list_agents"]);
    expect(result.code).toBe(2);
    expect(server.requests).toHaveLength(0);
    expect((await run(["call", "list_agents", "--agent", AGENT_A])).code).toBe(0);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_A });
  });

  it("sends connect without an agent and rejects --agent for it", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    expect((await run(["call", "connect", "--json", '{"description":"d"}'])).code).toBe(0);
    expect(server.toolCalls()[0]?.arguments).toEqual({ description: "d" });
    expect((await run(["call", "connect", "--agent", AGENT_A])).code).toBe(2);
  });

  it("is a usage error without a tool name, with two, or with a bad name", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    for (const argv of [["call"], ["call", "a", "b"], ["call", "no spaces"], ["call", "../x"], ["call", "x", "--json", "[1]"], ["call", "x", "--json", "{bad"]]) {
      expect((await run(argv)).code, argv.join(" ")).toBe(2);
    }
    expect(server.requests).toHaveLength(0);
  });

  it("prints the failure envelope and the same exit codes as the tool commands", async () => {
    const server = await start({ tool: () => ({ messages: [], error: "nope" }) });
    sandbox.signIn(server.origin);
    const result = await run(["call", "new_tool"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ messages: [], error: "nope" });
    sandbox.signIn("http://127.0.0.1:1");
    expect((await run(["call", "new_tool"])).code).toBe(4);
  });

  it("strips the watch token from check_inbox called through it", async () => {
    const server = await start({
      tool: () => ({ messages: [], result: { count: 0, watch: { command: `curl -H 'Authorization: Bearer ${FAKE_WATCH_TOKEN}' x`, expires_at: "e", url: "u", token: FAKE_WATCH_TOKEN } } }),
    });
    sandbox.signIn(server.origin);
    const result = await run(["call", "check_inbox", "--agent", AGENT_A, "--json", '{"watch_minutes":5}']);
    expect(result.code).toBe(0);
    expectNoSecrets(result.out + result.err);
    expect(JSON.parse(result.out).result.watch.expires_at).toBe("e");
  });
});
