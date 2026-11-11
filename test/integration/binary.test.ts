// The built binary against a fake JubarteAI server: sign-in (browser callback, pasted dashboard key), the
// credentials file, every tool command and the exit codes they promise (spec section 5.2).
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TOOL_SPECS } from "../../src/mcp/tool-specs.js";
import { SERVER_TOOLS, startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { BIN, FAKE_KEY, IS_WINDOWS, PTY_SCRIPT, createSandbox, locatePython } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PYTHON = IS_WINDOWS ? null : locatePython();
const AUTHORIZE_URL = /(https?:\/\/\S+\/cli\/authorize\?\S+)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
});

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

function storedSeats(): Record<string, Record<string, unknown>> {
  return box.readJson(box.credentialsFile)["seats"] as Record<string, Record<string, unknown>>;
}

describe("login", () => {
  test("the browser callback flow: prints the URL, the approval returns a code, the key is saved", async () => {
    const running = box.start(["login", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
    const [, url] = await running.waitFor("stderr", AUTHORIZE_URL);
    expect(new URL(url as string).origin).toBe(fake.origin);
    expect(new URL(url as string).searchParams.get("port")).toMatch(/^\d+$/);

    const answered = await fake.authorize(url as string);
    expect(answered.status).toBe(200);
    const result = await running.exit;

    expect(result.code).toBe(0);
    // One exchange, with a verifier that really hashes to the challenge the URL carried (the fake checks S256).
    expect(fake.exchanges).toHaveLength(1);
    expect(fake.exchanges[0]?.replaces).toBeNull();
    const [key] = fake.mintedKeys();
    expect(key).toMatch(/^jba_/);
    const seats = storedSeats();
    const [seat] = Object.values(seats);
    expect(Object.keys(seats)).toEqual([fake.identity.seat_id]);
    expect(seat).toMatchObject({ token: key, origin: fake.origin, minted_by: "cli" });
    expect(box.readJson(box.credentialsFile)["default_seat"]).toBe(fake.identity.seat_id);
    expect(box.findLeaks([key as string])).toEqual([]);
  });

  test("a second login asks the server to revoke the key it minted before", async () => {
    for (let i = 0; i < 2; i++) {
      const running = box.start(["login", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
      const [, url] = await running.waitFor("stderr", AUTHORIZE_URL);
      await fake.authorize(url as string);
      expect((await running.exit).code).toBe(0);
    }
    const [first, second] = fake.mintedKeys();
    expect(fake.exchanges[1]?.replaces).toBe(first);
    expect(fake.isRevoked(first as string)).toBe(true);
    expect(fake.isRevoked(second as string)).toBe(false);
    expect(Object.values(storedSeats())[0]?.["token"]).toBe(second);
  });

  describe("the key in Codex's MCP entry (R-M2)", () => {
    const HINT = "Codex still uses the key that was just revoked; run `jubarteai init` to update it.";

    async function loginOnce(args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
      const running = box.start(["login", "--no-browser", ...args], { env: { JUBARTEAI_URL: fake.origin } });
      const [, url] = await running.waitFor("stderr", AUTHORIZE_URL);
      await fake.authorize(url as string);
      return running.exit;
    }

    function codexConfig(key: string): string {
      return `model = "o4"\n\n[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\nhttp_headers = { "Authorization" = "Bearer ${key}" }\n`;
    }

    /** First login, then a Codex entry holding the key it minted (what init's D5 fallback writes). */
    async function firstLoginAndCodexEntry(): Promise<{ oldKey: string; file: string }> {
      expect((await loginOnce()).code).toBe(0);
      const [oldKey] = fake.mintedKeys() as [string];
      const file = join(box.home, ".codex", "config.toml");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, codexConfig(oldKey));
      return { oldKey, file };
    }

    test("without a terminal or --yes, the hint is printed and the entry is untouched; no key is printed", async () => {
      const { oldKey, file } = await firstLoginAndCodexEntry();
      const result = await loginOnce();
      expect(result.code).toBe(0);
      const newKey = fake.mintedKeys()[1] as string;
      expect(fake.isRevoked(oldKey)).toBe(true);
      expect(result.stderr).toContain(HINT);
      expect(readFileSync(file, "utf8")).toBe(codexConfig(oldKey));
      for (const key of [oldKey, newKey]) {
        expect(result.stdout).not.toContain(key);
        expect(result.stderr).not.toContain(key);
      }
    });

    test("with --yes outside an agent session, the entry is rewritten to the new key; no key is printed", async () => {
      const { oldKey, file } = await firstLoginAndCodexEntry();
      const result = await loginOnce(["--yes"]);
      expect(result.code, result.stderr).toBe(0);
      const newKey = fake.mintedKeys()[1] as string;
      expect(readFileSync(file, "utf8")).toBe(codexConfig(newKey));
      expect(result.stderr).not.toContain(HINT);
      for (const key of [oldKey, newKey]) {
        expect(result.stdout).not.toContain(key);
        expect(result.stderr).not.toContain(key);
      }
      if (!IS_WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  test("a denied approval ends the login with a failure and saves nothing", async () => {
    const running = box.start(["login", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
    const [, url] = await running.waitFor("stderr", AUTHORIZE_URL);
    await fake.authorize(url as string, { deny: true });
    const result = await running.exit;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Login denied.");
    expect(fake.exchanges).toHaveLength(0);
    expect(() => statSync(box.credentialsFile)).toThrow();
  });

  test("a callback carrying the wrong state is refused and does not end the login", async () => {
    const running = box.start(["login", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
    const [, url] = await running.waitFor("stderr", AUTHORIZE_URL);
    const forged = await fake.authorize(url as string, { state: "not-the-state" });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(fake.exchanges).toHaveLength(0);
    // The real approval still works afterwards.
    await fake.authorize(url as string);
    expect((await running.exit).code).toBe(0);
  });

  test("--with-token reads the key from standard input, checks it with whoami and saves it", async () => {
    const result = await box.signInWithKey(fake);
    expect(result.code).toBe(0);
    expect(fake.requests.filter((r) => r.path === "/api/cli/whoami")).toHaveLength(1);
    expect(Object.values(storedSeats())[0]).toMatchObject({ token: FAKE_KEY, origin: fake.origin, minted_by: "dashboard" });
    expect(box.findLeaks([FAKE_KEY])).toEqual([]);
  });

  test("--with-token refuses a key on the command line and a key the server rejects", async () => {
    const onArgv = await box.run(["login", "--with-token", FAKE_KEY], { env: { JUBARTEAI_URL: fake.origin } });
    expect(onArgv.code).toBe(2);
    expect(onArgv.stderr).not.toContain(FAKE_KEY);
    // Not registered on the fake: whoami answers 401.
    const unknown = await box.run(["login", "--with-token"], { stdin: "jba_NOTAKEYTHESERVERKNOWS0000000\n", env: { JUBARTEAI_URL: fake.origin } });
    expect(unknown.code).toBe(3);
    expect(() => statSync(box.credentialsFile)).toThrow();
  });

  test.skipIf(IS_WINDOWS)("the credentials file is mode 0600 and its folder 0700", async () => {
    await box.signInWithKey(fake);
    expect(statSync(box.credentialsFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(box.credentialsFile)).mode & 0o777).toBe(0o700);
  });

  test.skipIf(PYTHON === null)("--paste on a terminal: the code typed at the hidden prompt is exchanged and the key saved (POSIX with Python 3.9+: runs the CLI on a pty)", async () => {
    const running = box.startCommand(PYTHON as string, ["-I", PTY_SCRIPT, process.execPath, BIN, "login", "--paste", "--no-browser"], {
      env: { JUBARTEAI_URL: fake.origin },
    });
    const [, url] = await running.waitFor("stdout", AUTHORIZE_URL);
    const authorize = new URL(url as string);
    expect(authorize.searchParams.get("mode")).toBe("paste");
    expect(authorize.searchParams.has("port")).toBe(false);

    // The browser would show this code after Approve; the person types it at the prompt.
    running.write(`${fake.mintCode(authorize.searchParams.get("challenge") as string)}\n`);
    running.end();
    const result = await running.exit;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(fake.exchanges).toHaveLength(1);
    const [key] = fake.mintedKeys();
    expect(Object.values(storedSeats())[0]).toMatchObject({ token: key, origin: fake.origin, minted_by: "cli" });
    // What the person saw on the terminal never shows the code they typed (hidden input) or the key.
    expect(result.stdout).not.toContain(fake.exchanges[0]?.code);
    expect(result.stdout).not.toContain(key);
  });

  test("--paste without a terminal explains itself instead of hanging, and shows a paste-mode URL", async () => {
    const result = await box.run(["login", "--paste", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
    expect(result.code).toBe(2);
    const url = new URL(AUTHORIZE_URL.exec(result.stderr)?.[1] as string);
    expect(url.searchParams.get("mode")).toBe("paste");
    expect(url.searchParams.has("port")).toBe(false);
    expect(result.stderr).toContain("no terminal");
  });
});

describe("status and logout", () => {
  test("status is offline, never prints the key, and logout removes the login", async () => {
    await box.signInWithKey(fake);
    const before = fake.requests.length;
    const status = await box.run(["status"]);
    expect(status.code).toBe(0);
    expect(fake.requests.length).toBe(before);
    expect(status.stdout + status.stderr).toContain("ada@example.com");
    expect(status.stdout + status.stderr).not.toContain(FAKE_KEY);

    const out = await box.run(["logout"]);
    expect(out.code).toBe(0);
    expect(Object.keys(storedSeats())).toEqual([]);
    expect((await box.run(["list-agents", "--agent", "aaaaaaaa-0000-4000-8000-00000000000a"])).code).toBe(5);
  });
});

describe("tool commands", () => {
  const SESSION = { CLAUDE_CODE_SESSION_ID: "session-one" };

  async function connected(): Promise<string> {
    await box.signInWithKey(fake);
    const result = await box.run(["connect", "--description", "integration test"], { env: SESSION });
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { messages: unknown[]; result: { agent_id: string; name: string } };
    expect(envelope.messages).toEqual([]);
    expect(envelope.result.agent_id).toMatch(UUID);
    return envelope.result.agent_id;
  }

  test("connect prints the envelope on stdout, caches the agent per session and sends the key as a bearer", async () => {
    const agentId = await connected();
    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]?.description).toBe("integration test");
    expect(fake.toolCalls()[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`);

    // Same session: later commands act as that agent with no --agent.
    const listed = await box.run(["list-agents"], { env: SESSION });
    expect(listed.code).toBe(0);
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "list_agents", arguments: { agent_id: agentId } });
  });

  test("a second session has no agent: exit 2 with the connect hint, and no request is made", async () => {
    await connected();
    const calls = fake.toolCalls().length;
    const other = await box.run(["list-agents"], { env: { CLAUDE_CODE_SESSION_ID: "session-two" } });
    expect(other.code).toBe(2);
    expect(other.stderr).toContain("jubarteai connect");
    expect(fake.toolCalls()).toHaveLength(calls);
  });

  test("--agent overrides the session; a malformed id is a usage error", async () => {
    await connected();
    const explicit = "dddddddd-0000-4000-8000-00000000000d";
    expect((await box.run(["claim", "--resource", "src/a.ts", "--agent", explicit], { env: SESSION })).code).toBe(0);
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "claim", arguments: { agent_id: explicit, resource: "src/a.ts" } });
    expect((await box.run(["claim", "--resource", "x", "--agent", "not-a-uuid"], { env: SESSION })).code).toBe(2);
  });

  test("exit 0 for a result, 1 when the server answers with an error", async () => {
    const agentId = await connected();
    fake.failTool("get_knowledge", "No such entry.");
    const failed = await box.run(["get-knowledge", "--id", "x"], { env: SESSION });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ messages: [], error: "No such entry." });
    // The failure was one call; the next works and the output is one JSON line.
    const ok = await box.run(["get-knowledge", "--id", "x"], { env: SESSION });
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim().split("\n")).toHaveLength(1);
    expect(fake.toolCalls().at(-1)?.arguments["agent_id"]).toBe(agentId);
  });

  test("exit 3 when the server refuses the key (revoked), with a login hint", async () => {
    await connected();
    fake.revoke(FAKE_KEY);
    const result = await box.run(["list-agents"], { env: SESSION });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("jubarteai login");
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "revoked_api_key" });
  });

  test("exit 4 for a server error and for a server that is not there", async () => {
    await connected();
    fake.mcpMode = "server_error";
    const failing = await box.run(["list-agents"], { env: SESSION });
    expect(failing.code).toBe(4);
    expect(JSON.parse(failing.stdout)).toMatchObject({ code: "server_error" });

    await fake.close();
    const refused = await box.run(["list-agents"], { env: SESSION });
    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: "network_error" });
    // The next afterEach closes it again; closing twice is harmless.
    fake = await startFakeServer();
  });

  test("exit 5 when nobody is signed in, with a JSON envelope on stdout for agents", async () => {
    const result = await box.run(["list-agents", "--agent", "aaaaaaaa-0000-4000-8000-00000000000a"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("jubarteai login");
    expect(JSON.parse(result.stdout)).toMatchObject({ messages: [], code: "not_signed_in" });
  });

  test("exit 2 for an unknown command and for a tool flag the CLI does not know", async () => {
    await connected();
    expect((await box.run(["frobnicate"])).code).toBe(2);
    expect((await box.run(["list-agents", "--nonsense"], { env: SESSION })).code).toBe(2);
  });

  // One row per tool command: the flags that exercise its arguments. The fake accepts anything; the table
  // is checked against the CLI's own list of tools and against the server's 16.
  const COMMANDS: Record<string, { args: string[]; expect?: Record<string, unknown> }> = {
    connect: { args: ["--description", "again"] },
    disconnect: { args: [] },
    "list-agents": { args: [] },
    "echo-current-task": { args: ["--title", "T", "--repositories", "acme-app", "--paths", "src/", "--branches", "main"], expect: { title: "T", repositories: ["acme-app"], paths: ["src/"] } },
    "search-knowledge": { args: ["--query", "how do we deploy", "--kind", "decision", "--limit", "3"], expect: { query: "how do we deploy", kind: "decision", limit: 3 } },
    "get-knowledge": { args: ["--name", "Deploys"], expect: { name: "Deploys" } },
    "create-knowledge": { args: ["--title", "T", "--description", "D", "--branches", "main", "--repositories", "acme-app", "--tags", "a", "--tags", "b"], expect: { tags: ["a", "b"] } },
    "update-knowledge": { args: ["--id", "e1", "--title", "T2", "--expected-updated-at", "2026-01-01T00:00:00Z"], expect: { id: "e1", expected_updated_at: "2026-01-01T00:00:00Z" } },
    "verify-knowledge": { args: ["--id", "e1"], expect: { id: "e1" } },
    "message-agents": { args: ["--to", "eeeeeeee-0000-4000-8000-00000000000e", "--content", "hello", "--priority", "urgent"], expect: { to_agent_ids: ["eeeeeeee-0000-4000-8000-00000000000e"], content: "hello", priority: "urgent" } },
    "check-inbox": { args: ["--wait-seconds", "1"], expect: { wait_seconds: 1 } },
    claim: { args: ["--resource", "src/a.ts", "--ttl-seconds", "120"], expect: { resource: "src/a.ts", ttl_seconds: 120 } },
    release: { args: ["--resource", "src/a.ts"], expect: { resource: "src/a.ts" } },
    "list-knowledge-gaps": { args: ["--status", "open", "--limit", "5"], expect: { status: "open", limit: 5 } },
    "list-knowledge-merges": { args: ["--limit", "5"], expect: { limit: 5 } },
    "resolve-knowledge-merge": { args: ["--id", "m1", "--action", "snooze", "--snooze-days", "7"], expect: { id: "m1", action: "snooze", snooze_days: 7 } },
  };

  test("the table covers every tool the CLI knows and every tool the server serves", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(TOOL_SPECS.map((spec) => spec.command).sort());
    expect(TOOL_SPECS.map((spec) => spec.tool).sort()).toEqual([...SERVER_TOOLS].sort());
  });

  test.each(Object.entries(COMMANDS))("jubarteai %s reaches its tool with its arguments and exits 0", async (command, row) => {
    const agentId = await connected();
    const spec = TOOL_SPECS.find((s) => s.command === command);
    const before = fake.toolCalls().length;
    const result = await box.run([command, ...row.args], { env: command === "connect" ? { CLAUDE_CODE_SESSION_ID: "session-three" } : SESSION });
    expect(result.code, result.stderr).toBe(0);
    const calls = fake.toolCalls().slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(spec?.tool);
    if (spec?.needsAgent === true) expect(calls[0]?.arguments["agent_id"]).toBe(agentId);
    expect(calls[0]?.arguments).toMatchObject(row.expect ?? {});
    const envelope = JSON.parse(result.stdout) as { messages: unknown[]; result: unknown };
    expect(Array.isArray(envelope.messages)).toBe(true);
    expect(envelope.result).toBeDefined();
  });

  test("call reaches a tool the CLI does not know, without an agent it cannot resolve", async () => {
    await connected();
    const result = await box.run(["call", "some_future_tool", "--json", '{"x":1}'], { env: SESSION });
    expect(result.code).toBe(0);
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "some_future_tool", arguments: { x: 1 } });
  });

  test("the key is in no output, no argument and no file but the credentials file", async () => {
    await connected();
    for (const args of [["list-agents"], ["status"], ["doctor"]]) await box.run(args, { env: SESSION });
    expect(box.findLeaks([FAKE_KEY])).toEqual([]);
  });
});
