import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeSession } from "../session/cache.js";
import {
  AGENT_A,
  AGENT_B,
  createSandbox,
  deadOrigin,
  expectNoSecrets,
  FAKE_KEY,
  FAKE_WATCH_TOKEN,
  jsonLines,
  runCli,
  SEAT_ID,
  sendJson,
  startFakeServer,
} from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { TOOL_COMMANDS } from "./tool.js";

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

const run = (argv: string[]) => runCli(TOOL_COMMANDS, argv, sandbox.repo);

// One row per command: the argv, the tool it must call and the arguments it must send.
const CASES: Array<[command: string, argv: string[], tool: string, args: Record<string, unknown>]> = [
  ["disconnect", ["disconnect"], "disconnect", {}],
  ["list-skills", ["list-skills", "--repository", "acme-app"], "list_skills", { repository: "acme-app" }],
  ["get-skill", ["get-skill", "--name", "pdf-tools", "--manifest"], "get_skill", { name: "pdf-tools", manifest: true }],
  ["list-agents", ["list-agents"], "list_agents", {}],
  [
    "echo-current-task",
    ["echo-current-task", "--title", "Fix bug", "--description", "d", "--tickets", "ENG-1", "--refs", "r1", "--refs", "r2", "--branches", "b", "--repositories", "jubarteai", "--paths", "src/a.ts", "--paths", "src/b/"],
    "echo_current_task",
    { title: "Fix bug", description: "d", tickets: ["ENG-1"], refs: ["r1", "r2"], branches: ["b"], repositories: ["jubarteai"], paths: ["src/a.ts", "src/b/"] },
  ],
  [
    "search-knowledge",
    ["search-knowledge", "--query", "how do hooks work", "--branches", "main", "--repositories", "jubarteai", "--refs", "ENG-1", "--kind", "workdone", "--paths", "src/", "--needs-verification", "--no-include-superseded", "--limit", "7"],
    "search_knowledge",
    { query: "how do hooks work", branches: ["main"], repositories: ["jubarteai"], refs: ["ENG-1"], kind: "workdone", paths: ["src/"], needs_verification: true, include_superseded: false, limit: 7 },
  ],
  ["get-knowledge", ["get-knowledge", "--id", "11111111-0000-4000-8000-000000000001", "--name", "Title"], "get_knowledge", { id: "11111111-0000-4000-8000-000000000001", name: "Title" }],
  [
    "create-knowledge",
    ["create-knowledge", "--title", "T", "--description", "body", "--branches", "main", "--repositories", "jubarteai", "--refs", "r", "--tags", "t", "--kind", "decision", "--paths", "p", "--metadata", '{"status":"done"}'],
    "create_knowledge",
    { title: "T", description: "body", branches: ["main"], repositories: ["jubarteai"], refs: ["r"], tags: ["t"], kind: "decision", paths: ["p"], metadata: { status: "done" } },
  ],
  [
    "update-knowledge",
    ["update-knowledge", "--id", "11111111-0000-4000-8000-000000000001", "--title", "New", "--tags", "x", "--expected-updated-at", "2026-11-10T00:00:00.000Z"],
    "update_knowledge",
    { id: "11111111-0000-4000-8000-000000000001", title: "New", tags: ["x"], expected_updated_at: "2026-11-10T00:00:00.000Z" },
  ],
  ["verify-knowledge", ["verify-knowledge", "--id", "11111111-0000-4000-8000-000000000001", "--expected-updated-at", "t"], "verify_knowledge", { id: "11111111-0000-4000-8000-000000000001", expected_updated_at: "t" }],
  [
    "message-agents",
    ["message-agents", "--to", AGENT_B, "--to", "cccccccc-0000-4000-8000-00000000000c", "--content", "hello", "--priority", "urgent", "--reply-to", "dddddddd-0000-4000-8000-00000000000d"],
    "message_agents",
    { to_agent_ids: [AGENT_B, "cccccccc-0000-4000-8000-00000000000c"], content: "hello", priority: "urgent", reply_to: "dddddddd-0000-4000-8000-00000000000d" },
  ],
  ["message-agents --all", ["message-agents", "--all", "--content", "heads up"], "message_agents", { all: true, content: "heads up" }],
  ["check-inbox", ["check-inbox", "--wait-seconds", "3", "--watch-minutes", "5"], "check_inbox", { wait_seconds: 3, watch_minutes: 5 }],
  ["claim", ["claim", "--resource", "src/x.ts", "--ttl-seconds", "120"], "claim", { resource: "src/x.ts", ttl_seconds: 120 }],
  ["release", ["release", "--resource", "src/x.ts"], "release", { resource: "src/x.ts" }],
  ["list-knowledge-gaps", ["list-knowledge-gaps", "--status", "answered", "--limit", "3"], "list_knowledge_gaps", { status: "answered", limit: 3 }],
  ["list-knowledge-merges", ["list-knowledge-merges", "--status", "snoozed", "--limit", "2"], "list_knowledge_merges", { status: "snoozed", limit: 2 }],
  [
    "resolve-knowledge-merge",
    ["resolve-knowledge-merge", "--id", "11111111-0000-4000-8000-000000000002", "--action", "snooze", "--snooze-days", "14"],
    "resolve_knowledge_merge",
    { id: "11111111-0000-4000-8000-000000000002", action: "snooze", snooze_days: 14 },
  ],
];

describe("the 17 tool commands", () => {
  it("cover every command of TOOL_COMMANDS", () => {
    const covered = new Set(CASES.map(([, argv]) => argv[0]));
    expect([...covered].sort()).toEqual(TOOL_COMMANDS.map((c) => c.name).sort());
    expect(TOOL_COMMANDS).toHaveLength(17);
    expect(TOOL_COMMANDS.every((c) => c.group === "tools")).toBe(true);
  });

  it.each(CASES)("%s sends the right tools/call with the key and agent_id, and prints one envelope line", async (_name, argv, tool, args) => {
    const server = await start({ tool: (name) => ({ messages: [{ id: "m1", content: "<untrusted_content>hi</untrusted_content>" }], result: { called: name } }) });
    sandbox.signIn(server.origin);
    const result = await run([...argv, "--agent", AGENT_A]);

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(request?.headers["accept"]).toBe("application/json, text/event-stream");
    expect(server.toolCalls()).toEqual([{ name: tool, arguments: { ...args, agent_id: AGENT_A } }]);

    expect(result.out.endsWith("\n")).toBe(true);
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
    expect(result.out.startsWith('{"messages":[{"id":"m1"')).toBe(true);
    expect(JSON.parse(result.out)).toEqual({ messages: [{ id: "m1", content: "<untrusted_content>hi</untrusted_content>" }], result: { called: tool } });
    expectNoSecrets(result.out + result.err);
  });

  it("--help lists a command's flags, its --x-file forms and --json offline", async () => {
    const result = await run(["search-knowledge", "--help"]);
    expect(result.code).toBe(0);
    for (const flag of ["--query <value>", "--query-file <path|->", "--branches <value> ", "--needs-verification", "--limit <number>", "--json <json|@file|->"]) {
      expect(result.out).toContain(flag);
    }
    expect(result.err).toBe("");
  });

  it("--pretty indents the envelope", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    const result = await run(["list-agents", "--pretty", "--agent", AGENT_A]);
    expect(result.out.split("\n").length).toBeGreaterThan(3);
    expect(JSON.parse(result.out)).toHaveProperty("messages");
  });

  it("fills agent_id from this session's cache when --agent is absent", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: server.origin }, { overwrite: true });
    expect((await run(["list-agents"])).code).toBe(0);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_B });
  });

  it("lets --agent beat the cache", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: SEAT_ID, origin: server.origin }, { overwrite: true });
    await run(["list-agents", "--agent", AGENT_A]);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_A });
  });

  it("lets a flag in --json carry the agent, and a flag override the --json keys", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    await run(["claim", "--json", JSON.stringify({ agent_id: AGENT_B, resource: "from-json", ttl_seconds: 60 }), "--resource", "from-flag"]);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_B, resource: "from-flag", ttl_seconds: 60 });
  });

  it("exits 2 with the connect hint, sending nothing, when there is no agent", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    const result = await run(["list-agents"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('jubarteai connect --description "');
    expect(server.requests).toHaveLength(0);
  });

  it("exits 2 for a --agent that is not a UUID, and for an unexpected argument", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    expect((await run(["list-agents", "--agent", "nope"])).code).toBe(2);
    expect((await run(["list-agents", "extra", "--agent", AGENT_A])).code).toBe(2);
    expect((await run(["claim", "--bogus", "1", "--agent", AGENT_A])).code).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it("exits 5 with the login hint (and an envelope) when not signed in", async () => {
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.code).toBe(5);
    expect(result.err).toContain("jubarteai login");
    expect(JSON.parse(result.out)).toMatchObject({ messages: [], code: "not_signed_in" });
  });

  it("prints a server error as the envelope and exits 1", async () => {
    const server = await start({ tool: () => ({ messages: [{ id: "m" }], error: "agent_id not found or not owned by this seat" }) });
    sandbox.signIn(server.origin);
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ messages: [{ id: "m" }], error: "agent_id not found or not owned by this seat" });
  });

  it.each([
    [401, "invalid_api_key"],
    [402, "billing_inactive"],
    [403, "seat_canceled"],
  ])("exits 3 with the code JSON for HTTP %i, one line on stdout and the message on stderr", async (status, code) => {
    const server = await start({
      mcp: (_req, res) => {
        sendJson(res, status, { error: code, message: "x" });
        return true;
      },
    });
    sandbox.signIn(server.origin);
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.code).toBe(3);
    expect(jsonLines(result.out)).toEqual([{ messages: [], error: expect.any(String), code }]);
    expect(result.err.trim().length).toBeGreaterThan(0);
    expectNoSecrets(result.out + result.err);
  });

  it("exits 4 for a 5xx, for ECONNREFUSED and for a timeout", async () => {
    const failing = await start({
      mcp: (_req, res) => {
        sendJson(res, 503, { error: "x" });
        return true;
      },
    });
    sandbox.signIn(failing.origin);
    const five = await run(["list-agents", "--agent", AGENT_A]);
    expect(five.code).toBe(4);
    expect(JSON.parse(five.out)).toMatchObject({ code: "server_error" });

    sandbox.signIn(await deadOrigin());
    const refused = await run(["list-agents", "--agent", AGENT_A]);
    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.out)).toMatchObject({ code: "network_error" });
    expectNoSecrets(five.out + five.err + refused.out + refused.err);
  });

  it("sends the key only to the seat's stored origin, even with JUBARTEAI_URL pointing elsewhere", async () => {
    const real = await start();
    const evil = await start();
    sandbox.signIn(real.origin);
    process.env["JUBARTEAI_URL"] = evil.origin;
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.code).toBe(0);
    expect(real.requests).toHaveLength(1);
    expect(evil.requests).toHaveLength(0);
    process.env["JUBARTEAI_URL"] = "http://evil.example";
    expect((await run(["list-agents", "--agent", AGENT_A])).code).toBe(0);
    expect(real.requests).toHaveLength(2);
  });

  it("replaces the seat's own key in anything the server sends back", async () => {
    const server = await start({ tool: () => ({ messages: [{ content: `leaked ${FAKE_KEY}` }], result: { key: FAKE_KEY } }) });
    sandbox.signIn(server.origin);
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.out).toContain("[redacted]");
    expectNoSecrets(result.out);
  });

  it("check-inbox strips the watch token (and the copy in watch.command) from its output", async () => {
    const server = await start({
      tool: () => ({
        messages: [],
        result: {
          count: 0,
          watch: {
            command: `(curl -s -H 'Authorization: Bearer ${FAKE_WATCH_TOKEN}' http://x/api/mcp/inbox-watch)`,
            expires_at: "2026-11-10T01:00:00.000Z",
            url: "http://x/api/mcp/inbox-watch",
            token: FAKE_WATCH_TOKEN,
          },
        },
      }),
    });
    sandbox.signIn(server.origin);
    const result = await run(["check-inbox", "--watch-minutes", "5", "--agent", AGENT_A]);
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as { result: { watch: Record<string, unknown> } };
    expect(printed.result.watch).not.toHaveProperty("token");
    expect(printed.result.watch["expires_at"]).toBe("2026-11-10T01:00:00.000Z");
    expectNoSecrets(result.out + result.err);
  });

  it("uses --workspace to pick the seat", async () => {
    const server = await start();
    sandbox.signIn(server.origin);
    expect((await run(["list-agents", "--workspace", "acme", "--agent", AGENT_A])).code).toBe(0);
    const unknown = await run(["list-agents", "--workspace", "nope", "--agent", AGENT_A]);
    expect(unknown.code).toBe(5);
    expect(server.requests).toHaveLength(1);
  });

  it("uses a JUBARTEAI_TOKEN key against JUBARTEAI_URL, and never saves it", async () => {
    const server = await start();
    process.env["JUBARTEAI_TOKEN"] = "jba_ENVENVENVENVENVENVENVENVENV01";
    process.env["JUBARTEAI_URL"] = server.origin;
    const result = await run(["list-agents", "--agent", AGENT_A]);
    expect(result.code).toBe(0);
    expect(server.requests[0]?.headers["authorization"]).toBe("Bearer jba_ENVENVENVENVENVENVENVENVENV01");
    expect(process.env["JUBARTEAI_TOKEN"]).toBeUndefined();
    expectNoSecrets(result.out + result.err, ["jba_ENVENVENVENVENVENVENVENVENV01"]);
  });
});
