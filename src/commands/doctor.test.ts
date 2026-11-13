import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSeat } from "../auth/credentials.js";
import { credentialsPath } from "../paths.js";
import { writeBinding } from "../binding/binding.js";
import type { StoredSeat } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { cliVersion } from "../constants.js";
import { claudeCodeAdapter } from "../harness/claude-code.js";
import { resolveCliCommand } from "../install/cli-command.js";
import type { InitCtx } from "../harness/types.js";
import { planInstructionSteps } from "../install/agents-md.js";
import { CLI_REGISTRY_LATEST_URL } from "../install/self-update.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { doctorCommand } from "./doctor.js";

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "JUBARTEAI_TOKEN",
  "JUBARTEAI_URL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;
const TOKEN_GOOD = "jba_SECRETGOODGOODGOODGOOD01";
const TOKEN_REVOKED = "jba_SECRETREVOKEDREVOKEDREV02";
const TOKEN_UNKNOWN = "jba_SECRETUNKNOWNUNKNOWNUNK03";
const TOKEN_ENV = "jba_SECRETENVENVENVENVENVENV04";
const ALL_TOKENS = [TOKEN_GOOD, TOKEN_REVOKED, TOKEN_UNKNOWN, TOKEN_ENV];

let sandbox: string;
let repo: string;
let saved: Record<string, string | undefined>;
let fake: FakeAuthServer;
let registry: { mode: "current" | "newer" | "offline" | "garbage" };
let realFetch: typeof fetch;

function gitDir(): string {
  if (process.platform === "win32") {
    // No sh, and a symlink needs a privilege: the folder holding git.exe is already free of harness binaries.
    const found = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() ?? "";
    return dirname(found);
  }
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  symlinkSync(git, join(bin, "git"));
  return bin;
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-doctor-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.TMPDIR = join(sandbox, "tmp");
  mkdirSync(process.env.TMPDIR);
  for (const name of ["XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) {
    delete process.env[name];
  }
  // Only git on PATH, so no harness binary of the machine running the tests is detected.
  process.env.PATH = gitDir();
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  resetEnvTokenForTests();

  fake = await startFakeAuthServer();
  registry = { mode: "current" };
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== CLI_REGISTRY_LATEST_URL) return realFetch(input, init);
    if (registry.mode === "offline") throw new TypeError("fetch failed");
    if (registry.mode === "garbage") return new Response("<html>", { status: 200 });
    return new Response(JSON.stringify({ version: registry.mode === "newer" ? "999.0.0" : cliVersion() }), { status: 200 });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  resetEnvTokenForTests();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function seat(slug: string, email: string, token: string, origin = fake.origin): StoredSeat {
  return {
    origin,
    token,
    minted_by: "dashboard",
    key: { id: `key-${slug}`, prefix: token.slice(0, 12), name: `Key ${slug}` },
    user: { id: `user-${email}`, email },
    company: { id: `company-${slug}`, slug, name: slug.toUpperCase() },
    saved_at: "2026-11-01T00:00:00Z",
  };
}

/** Revokes a CLI-minted key the way the server does: a new login that replaces it. */
async function revoke(token: string): Promise<void> {
  fake.addKey(token, "cli");
  const verifier = randomBytes(32).toString("base64url");
  const code = fake.mintCode(createHash("sha256").update(verifier).digest("base64url"));
  const response = await realFetch(new URL("/api/cli/token", fake.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, replaces: token }),
  });
  expect(response.status).toBe(200);
  expect(fake.isRevoked(token)).toBe(true);
}

async function run(argv: string[], cwd = repo) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const code = await routeWith([doctorCommand], argv, { stdout, stderr, stdin: new PassThrough(), cwd });
  for (const token of ALL_TOKENS) {
    expect(out).not.toContain(token);
    expect(err).not.toContain(token);
  }
  return { code, out, err };
}

type JsonCheck = { id: string; level: "ok" | "warn" | "fail"; label: string; detail: string; data?: Record<string, unknown> };
type JsonReport = { ok: boolean; checks: JsonCheck[]; status: { seats: unknown[] } };

async function runJson(argv: string[] = ["doctor", "--json"], cwd = repo) {
  const result = await run(argv, cwd);
  return { ...result, report: JSON.parse(result.out) as JsonReport };
}

function check(report: JsonReport, id: string): JsonCheck {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}: ${report.checks.map((c) => c.id).join(", ")}`);
  return found;
}

/** The context init plans with: the bare name for permissions, the absolute `"<node>" "<bin>"` for hook entries. */
function initCtx(): InitCtx {
  return { home: sandbox, env: process.env, platform: process.platform, which: () => null, projectRoot: repo, cliCommand: "jubarteai", hookCommand: resolveCliCommand() };
}

describe("doctor: logins", () => {
  it("reports ok for a valid key, includes the status report, exits 0 and never prints a key", async () => {
    fake.addKey(TOKEN_GOOD);
    saveSeat("s1", seat("acme", "ada@example.com", TOKEN_GOOD), { makeDefault: true });
    const result = await run(["doctor"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("Saved logins:"); // status's own section
    expect(result.out).toContain("Checks:");
    expect(result.out).toContain("ok    Login ada@example.com — acme: ok");
    expect(result.out).toContain("ok    Saved logins: 1 saved");
    // The key travelled only in the Authorization header of whoami.
    expect(fake.requests.filter((r) => r.path === "/api/cli/whoami").map((r) => r.authorization)).toEqual([`Bearer ${TOKEN_GOOD}`]);
  });

  it("fails with exit 1 for a revoked key and an unknown key, and still checks the valid one", async () => {
    fake.addKey(TOKEN_GOOD);
    await revoke(TOKEN_REVOKED);
    saveSeat("good", seat("good", "a@example.com", TOKEN_GOOD), { makeDefault: true });
    saveSeat("revoked", seat("revoked", "b@example.com", TOKEN_REVOKED), { makeDefault: false });
    saveSeat("unknown", seat("unknown", "c@example.com", TOKEN_UNKNOWN), { makeDefault: false });
    const { code, out, report } = await runJson();
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(check(report, "seat:good")).toMatchObject({ level: "ok", detail: "ok" });
    expect(check(report, "seat:revoked")).toMatchObject({ level: "fail", detail: "revoked_api_key", data: { status: "revoked_api_key" } });
    expect(check(report, "seat:unknown")).toMatchObject({ level: "fail", detail: "invalid_api_key" });
    const human = await run(["doctor"]);
    expect(human.code).toBe(1);
    expect(human.out).toContain("fail  Login b@example.com — revoked: revoked_api_key");
    expect(out).not.toContain("Bearer");
  });

  it("never echoes anything but a plain status word from the server", async () => {
    const hostile: Server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `${TOKEN_GOOD} <script>`, message: TOKEN_GOOD }));
    });
    await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`;
      saveSeat("h", seat("h", "h@example.com", TOKEN_GOOD, origin), { makeDefault: true });
      const { code, report } = await runJson();
      expect(code).toBe(1);
      expect(JSON.stringify(report)).not.toContain("script");
      expect(check(report, "seat:h")).toMatchObject({ level: "fail", detail: "invalid_api_key" });
    } finally {
      hostile.closeAllConnections();
      await new Promise<void>((resolve) => hostile.close(() => resolve()));
    }
  });

  it("treats a server error and an unreachable server as advisory (warn, exit 0)", async () => {
    fake.addKey(TOKEN_GOOD);
    fake.whoamiFailures = 1;
    saveSeat("flaky", seat("flaky", "a@example.com", TOKEN_GOOD), { makeDefault: true });
    const closed = await startFakeAuthServer();
    const deadOrigin = closed.origin;
    await closed.close();
    saveSeat("gone", seat("gone", "b@example.com", TOKEN_UNKNOWN, deadOrigin), { makeDefault: false });
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(check(report, "seat:flaky")).toMatchObject({ level: "warn", detail: "server_error" });
    expect(check(report, "seat:gone")).toMatchObject({ level: "warn", detail: "unreachable" });
  });

  it("warns when nothing is saved, and checks a key given in JUBARTEAI_TOKEN", async () => {
    const empty = await runJson();
    expect(empty.code).toBe(0);
    expect(check(empty.report, "credentials")).toMatchObject({ level: "warn", detail: "none. Run: jubarteai login" });
    expect(empty.report.checks.some((c) => c.id === "env_token")).toBe(false);

    fake.addKey(TOKEN_ENV);
    process.env.JUBARTEAI_TOKEN = TOKEN_ENV;
    process.env.JUBARTEAI_URL = fake.origin;
    resetEnvTokenForTests();
    const withEnv = await runJson();
    expect(withEnv.code).toBe(0);
    expect(check(withEnv.report, "env_token")).toMatchObject({ level: "ok", label: "Login from JUBARTEAI_TOKEN" });
  });

  it("fails when the saved logins file can't be read", async () => {
    const credentials = credentialsPath(); // ~/.config/jubarteai on POSIX, %APPDATA%\\jubarteai on Windows
    mkdirSync(dirname(credentials), { recursive: true });
    writeFileSync(credentials, "not json{", { mode: 0o600 });
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(check(report, "credentials").level).toBe("fail");
  });
});

describe("doctor: machine checks", () => {
  it("fails when Node is below the floor", async () => {
    const real = process.versions.node;
    Object.defineProperty(process.versions, "node", { value: "20.20.2", configurable: true });
    try {
      const { code, report } = await runJson();
      expect(code).toBe(1);
      expect(check(report, "node")).toMatchObject({ level: "fail", data: { version: "20.20.2", meets_floor: false } });
    } finally {
      Object.defineProperty(process.versions, "node", { value: real, configurable: true });
    }
    const ok = await runJson();
    expect(check(ok.report, "node")).toMatchObject({ level: "ok", data: { meets_floor: true } });
  });

  it("compares the CLI with the registry: current, newer, offline and garbage answers", async () => {
    const current = await runJson();
    expect(check(current.report, "cli_version")).toMatchObject({ level: "ok", data: { current: cliVersion(), latest: cliVersion() } });

    registry.mode = "newer";
    const newer = await runJson();
    expect(newer.code).toBe(0);
    expect(check(newer.report, "cli_version")).toMatchObject({ level: "warn", data: { latest: "999.0.0" } });
    expect(check(newer.report, "cli_version").detail).toContain("Run: jubarteai update");

    for (const mode of ["offline", "garbage"] as const) {
      registry.mode = mode;
      const result = await runJson();
      expect(result.code).toBe(0); // offline is not a failure
      expect(check(result.report, "cli_version")).toMatchObject({ level: "warn", data: { latest: null } });
      expect(check(result.report, "cli_version").detail).toContain("couldn't check");
    }
  });
});

describe("doctor: harnesses, skill and AGENTS.md", () => {
  it("reports a detected harness with missing setup as warn, then ok once init's own steps have run", async () => {
    mkdirSync(join(sandbox, ".claude"));
    const before = await runJson();
    expect(before.code).toBe(0);
    expect(check(before.report, "harness:claude-code")).toMatchObject({ level: "warn", data: { permission: "missing", hooks: "missing" } });
    expect(before.report.checks.some((c) => c.id === "harness:codex")).toBe(false);

    const ctx = initCtx();
    const permission = await claudeCodeAdapter.permission(ctx);
    const hooks = await claudeCodeAdapter.hooks(ctx);
    if (permission === null || "kind" in permission || hooks === null || !Array.isArray(hooks)) throw new Error("expected plan steps");
    for (const step of [permission, ...hooks]) expect((await step.apply()).status).toBe("configured");

    const after = await runJson();
    expect(check(after.report, "harness:claude-code")).toMatchObject({ level: "ok", data: { permission: "configured", hooks: "configured", mcp_entries: [] } });
  });

  // Windows registers the bare `jubarteai` on purpose (PowerShell can't parse "node" "script"), so there is no absolute
  // form to tell apart from a bare one there.
  it.skipIf(process.platform === "win32")("recognizes the absolute hook commands init registers, and calls bare or outdated ones partial", async () => {
    // The process running doctor is the install init ran from: its node and bin script are what the hooks name.
    expect(resolveCliCommand()).toMatch(/^".+" ".+"$/);
    mkdirSync(join(sandbox, ".claude"));
    const writeHooks = async (ctx: InitCtx): Promise<void> => {
      const hooks = await claudeCodeAdapter.hooks(ctx);
      if (hooks === null || !Array.isArray(hooks)) throw new Error("expected plan steps");
      for (const step of hooks) await step.apply();
    };
    await writeHooks({ home: sandbox, env: process.env, platform: process.platform, which: () => null, projectRoot: repo, cliCommand: "jubarteai" });
    expect(check((await runJson()).report, "harness:claude-code")).toMatchObject({ data: { hooks: "partial" } });
    await writeHooks(initCtx());
    expect(check((await runJson()).report, "harness:claude-code")).toMatchObject({ data: { hooks: "configured" } });
    const settings = readFileSync(join(sandbox, ".claude", "settings.json"), "utf8");
    expect(settings.split("hook session-start --harness claude-code").length - 1).toBe(1);
  });

  describe("Codex's user-level MCP entry (init's D5 fallback)", () => {
    const codexConfig = (): string => join(sandbox, ".codex", "config.toml");
    function writeCodexEntry(token: string, origin = fake.origin, form: "inline" | "table" = "inline"): void {
      mkdirSync(join(sandbox, ".codex"), { recursive: true });
      const headers =
        form === "inline"
          ? `http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${token}`)} }\n`
          : `\n[mcp_servers.jubarteai.http_headers]\nAuthorization = ${JSON.stringify(`Bearer ${token}`)}\n`;
      writeFileSync(codexConfig(), `model = "o4"\n\n[mcp_servers.jubarteai]\nurl = "${origin}/api/mcp"\n${headers}`);
    }
    function neverShown(out: string, token: string): void {
      expect(out).not.toContain(token);
      expect(out).not.toContain(createHash("sha256").update(token).digest("hex"));
      expect(out).not.toContain(createHash("sha256").update(token).digest("base64"));
    }

    it("is ok when it holds a saved login's key for its origin, never printing the key or a digest", async () => {
      fake.addKey(TOKEN_GOOD);
      saveSeat("s1", seat("acme", "ada@example.com", TOKEN_GOOD), { makeDefault: true });
      writeCodexEntry(TOKEN_GOOD);
      const { report, out } = await runJson();
      expect(check(report, "codex_mcp_entry")).toMatchObject({ level: "ok", detail: "uses your saved login for acme", data: { matched: true, workspace: "acme" } });
      // S4: the deliberate entry is not a leftover while the project has no network opt-in.
      expect(check(report, "harness:codex").data?.["mcp_entries"]).toEqual([]);
      neverShown(out, TOKEN_GOOD);
      const human = await run(["doctor"]);
      expect(human.out).toContain("Codex MCP entry: uses your saved login for acme");
      neverShown(human.out, TOKEN_GOOD);
    });

    it("reads the key from a [mcp_servers.jubarteai.http_headers] table too", async () => {
      saveSeat("s1", seat("acme", "ada@example.com", TOKEN_GOOD), { makeDefault: true });
      writeCodexEntry(TOKEN_GOOD, fake.origin, "table");
      expect(check((await runJson()).report, "codex_mcp_entry")).toMatchObject({ level: "ok" });
    });

    it.each<[string, () => void]>([
      ["a key that is not saved", () => writeCodexEntry(TOKEN_UNKNOWN)],
      ["a saved key for another origin", () => writeCodexEntry(TOKEN_GOOD, "https://elsewhere.example")],
      ["no Authorization header", () => writeFileSync(codexConfig(), `[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\n`)],
    ])("warns for %s, naming no key", async (_name, write) => {
      saveSeat("s1", seat("acme", "ada@example.com", TOKEN_GOOD), { makeDefault: true });
      mkdirSync(join(sandbox, ".codex"), { recursive: true });
      write();
      const { report, out } = await runJson();
      expect(check(report, "codex_mcp_entry")).toMatchObject({
        level: "warn",
        detail: "holds a key that isn't a saved login; run jubarteai init to refresh it",
        data: { matched: false },
      });
      neverShown(out, TOKEN_GOOD);
      neverShown(out, TOKEN_UNKNOWN);
    });

    it("says nothing when Codex has no jubarteai entry", async () => {
      mkdirSync(join(sandbox, ".codex"), { recursive: true });
      writeFileSync(codexConfig(), `model = "o4"\n`);
      const { report } = await runJson();
      expect(report.checks.some((c) => c.id === "codex_mcp_entry")).toBe(false);
      expect(report.checks.some((c) => c.id === "harness:codex")).toBe(true);
    });
  });

  it("names a leftover MCP entry and where it is", async () => {
    mkdirSync(join(sandbox, ".claude"));
    writeFileSync(join(sandbox, ".claude.json"), JSON.stringify({ mcpServers: { jubarteai: { type: "http", url: "https://example.com/api/mcp" } } }));
    const { report, out } = await runJson();
    const harness = check(report, "harness:claude-code");
    expect(harness.level).toBe("warn");
    expect(harness.data?.["mcp_entries"]).toEqual(["~/.claude.json"]);
    expect(harness.detail).toContain("leftover MCP entry in ~/.claude.json");
    expect(out).not.toContain("example.com");
  });

  describe("registered hook commands", () => {
    function writeClaudeHooks(program: string): void {
      mkdirSync(join(sandbox, ".claude"), { recursive: true });
      const hooks: Record<string, unknown> = {};
      for (const [name, arg] of [["SessionStart", "session-start"], ["UserPromptSubmit", "user-prompt-submit"], ["SessionEnd", "session-end"]]) {
        hooks[name as string] = [{ hooks: [{ type: "command", command: `${program} hook ${arg} --harness claude-code`, timeout: 8 }] }];
      }
      writeFileSync(join(sandbox, ".claude", "settings.json"), JSON.stringify({ hooks }));
    }

    it("is ok when the quoted node and bin paths exist", async () => {
      const bin = join(sandbox, "jubarteai.js");
      writeFileSync(bin, "");
      writeClaudeHooks(`"${process.execPath}" "${bin}"`);
      const { report } = await runJson();
      expect(check(report, "hook_commands:claude-code")).toMatchObject({ level: "ok", data: { count: 3, problems: [] } });
    });

    it("warns when a quoted absolute path no longer exists, naming it", async () => {
      const gone = join(sandbox, "old node", "bin", "jubarteai.js");
      writeClaudeHooks(`"${process.execPath}" "${gone}"`);
      const { code, report } = await runJson();
      expect(code).toBe(0);
      const hooks = check(report, "hook_commands:claude-code");
      expect(hooks.level).toBe("warn");
      expect(hooks.detail).toBe(`hooks point to a missing ${gone}; run jubarteai init to refresh them`);
    });

    it("warns for a bare jubarteai only when it is not on PATH", async () => {
      writeClaudeHooks("jubarteai");
      const missing = await runJson();
      expect(check(missing.report, "hook_commands:claude-code").level).toBe("warn");
      expect(check(missing.report, "hook_commands:claude-code").detail).toContain("not on your PATH");

      const bin = join(sandbox, "bin");
      if (process.platform === "win32") {
        // PATH holds only git's folder there; a .cmd is what PATHEXT finds.
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "jubarteai.cmd"), "@exit /b 0\r\n");
        process.env.PATH = `${bin};${process.env.PATH ?? ""}`;
      } else {
        const exe = join(bin, "jubarteai");
        writeFileSync(exe, "#!/bin/sh\n");
        chmodSync(exe, 0o755);
      }
      const found = await runJson();
      expect(check(found.report, "hook_commands:claude-code")).toMatchObject({ level: "ok", detail: "found" });
    });

    it("reads Codex, Cursor, Gemini and the shared Copilot file too, and says nothing when no hook is ours", async () => {
      const gone = join(sandbox, "missing", "jubarteai.js");
      const command = (event: string, harness: string): string => `"${process.execPath}" "${gone}" hook ${event} --harness ${harness}`;
      for (const dir of [".codex", ".cursor", ".gemini", ".copilot"]) mkdirSync(join(sandbox, dir), { recursive: true });
      mkdirSync(join(sandbox, ".copilot", "hooks"));
      writeFileSync(join(sandbox, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: command("session-start", "codex") }] }] } }));
      writeFileSync(join(sandbox, ".cursor", "hooks.json"), JSON.stringify({ hooks: { sessionStart: [{ command: command("session-start", "cursor") }] } }));
      writeFileSync(join(sandbox, ".gemini", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ name: "x", type: "command", command: command("session-start", "gemini-cli") }] }] } }));
      writeFileSync(join(sandbox, ".copilot", "hooks", "jubarteai.json"), JSON.stringify({ hooks: { sessionStart: [{ type: "command", command: command("session-start", "copilot-cli") }] } }));
      const { report } = await runJson();
      for (const id of ["codex", "cursor", "gemini-cli", "copilot-cli"]) {
        expect(check(report, `hook_commands:${id}`).level).toBe("warn");
        expect(check(report, `hook_commands:${id}`).detail).toContain(`missing ${gone}`);
      }
      // Someone else's hook in a detected harness's file is not ours: no check.
      writeFileSync(join(sandbox, ".cursor", "hooks.json"), JSON.stringify({ hooks: { sessionStart: [{ command: "echo hi" }] } }));
      const other = await runJson();
      expect(other.report.checks.some((c) => c.id === "hook_commands:cursor")).toBe(false);
    });
  });

  it("warns when no harness is installed", async () => {
    const { report } = await runJson();
    expect(check(report, "harnesses")).toMatchObject({ level: "warn", data: { detected: 0 } });
  });

  it("reports the skill copies it finds, and none as warn", async () => {
    const none = await runJson();
    expect(check(none.report, "skill")).toMatchObject({ level: "warn", data: { copies: [] } });
    mkdirSync(join(repo, ".claude", "skills", "jubarteai"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "jubarteai", "SKILL.md"), "---\nname: jubarteai\n---\n");
    const some = await runJson();
    const skill = check(some.report, "skill");
    expect(skill.level).toBe("ok");
    expect((skill.data?.["copies"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("walks the AGENTS.md section states: missing, current, edited, unreadable (fail)", async () => {
    const missing = await runJson();
    expect(check(missing.report, "instructions")).toMatchObject({ level: "warn", data: { state: "missing" } });

    for (const step of planInstructionSteps(repo, { mode: "init" })) expect((await step.apply()).status).toBe("configured");
    const current = await runJson();
    expect(check(current.report, "instructions")).toMatchObject({ level: "ok", detail: "current", data: { state: "current" } });

    const agents = join(repo, "AGENTS.md");
    writeFileSync(agents, "# Mine\n\n<!-- jubarteai:begin -->\nmy own words\n<!-- jubarteai:end -->\n");
    const edited = await runJson();
    expect(check(edited.report, "instructions")).toMatchObject({ level: "warn", data: { state: "edited" } });
    expect(edited.code).toBe(0);

    rmSync(agents);
    mkdirSync(agents); // a folder where the file should be: it can't be read
    const unreadable = await runJson();
    expect(unreadable.code).toBe(1);
    expect(check(unreadable.report, "instructions").level).toBe("fail");
  });

  it("skips project checks outside a git repository and from the home folder", async () => {
    const plain = join(sandbox, "plain");
    mkdirSync(plain);
    const outside = await runJson(["doctor", "--json"], plain);
    expect(outside.code).toBe(0);
    expect(check(outside.report, "instructions")).toMatchObject({ level: "ok", data: { skipped: true } });
    expect(check(outside.report, "instructions").detail).toContain("not in a git repository");

    execFileSync("git", ["init", "-q"], { cwd: sandbox });
    const home = await runJson(["doctor", "--json"], sandbox);
    expect(check(home.report, "instructions").detail).toContain("home folder");
  });
});

describe("doctor: worktree bindings", () => {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
  };
  function worktree(): string {
    git("init", "-q");
    git("commit", "--allow-empty", "-q", "-m", "init");
    const tree = join(sandbox, "wt");
    git("worktree", "add", "-q", tree);
    return realpathSync(tree);
  }

  it("names the main checkout when the worktree inherits its binding", async () => {
    const tree = worktree();
    writeBinding(repo, { workspace: { id: "c1", slug: "acme" }, email: "ada@example.com", shared: false });
    const { report } = await runJson(["doctor", "--json"], tree);
    const found = check(report, "binding");
    expect(found.level).toBe("ok");
    expect(found.detail).toContain("from the main checkout");
    expect(found.data).toMatchObject({ workspace: "acme", inherited_from: tree });
  });

  it("notes when the worktree's own binding hides the main checkout's, and warns when they differ", async () => {
    const tree = worktree();
    writeBinding(repo, { workspace: { id: "c1", slug: "acme" }, email: "ada@example.com", shared: false });
    writeBinding(tree, { workspace: { id: "c2", slug: "other" }, email: "ada@example.com", shared: false });
    const { report } = await runJson(["doctor", "--json"], tree);
    const found = check(report, "binding");
    expect(found.level).toBe("warn");
    expect(found.detail).toContain("this worktree has its own binding");
    expect(found.detail).toContain("acme");
  });

  it("warns, naming the main checkout's file, when only that binding is unreadable", async () => {
    const tree = worktree();
    writeBinding(repo, { workspace: { id: "c1", slug: "acme" }, email: "ada@example.com", shared: false });
    writeBinding(tree, { workspace: { id: "c2", slug: "other" }, email: "ada@example.com", shared: false });
    writeFileSync(join(repo, ".jubarteai", "config.json"), JSON.stringify({ version: 2 }));
    const { report } = await runJson(["doctor", "--json"], tree);
    const found = check(report, "binding");
    expect(found.level).toBe("warn");
    expect(found.detail).toContain("workspace other");
    expect(found.detail).toContain("the main checkout's");
    expect(found.detail).toContain(join(repo, ".jubarteai", "config.json"));
    expect(found.detail).not.toContain("jubarteai link");
  });

  it("does not tell the user to delete the valid config.json when the main checkout's config.local.json is the broken one", async () => {
    const tree = worktree();
    writeBinding(repo, { workspace: { id: "c1", slug: "acme" }, email: "ada@example.com", shared: true });
    writeBinding(tree, { workspace: { id: "c2", slug: "other" }, email: "ada@example.com", shared: false });
    writeFileSync(join(repo, ".jubarteai", "config.local.json"), "{ not json");
    const { report } = await runJson(["doctor", "--json"], tree);
    const found = check(report, "binding");
    expect(found.level).toBe("warn");
    expect(found.detail).toContain(join(repo, ".jubarteai", "config.local.json"));
    expect(found.detail).not.toContain(join(repo, ".jubarteai", "config.json"));
    expect(found.detail).not.toContain("delete that file");
  });

  it("names config.json, the file read first, when both of the main checkout's files are invalid", async () => {
    const tree = worktree();
    writeBinding(repo, { workspace: { id: "c1", slug: "acme" }, email: "ada@example.com", shared: true });
    writeBinding(tree, { workspace: { id: "c2", slug: "other" }, email: "ada@example.com", shared: false });
    writeFileSync(join(repo, ".jubarteai", "config.json"), "{ not json");
    writeFileSync(join(repo, ".jubarteai", "config.local.json"), "{ not json");
    const { report } = await runJson(["doctor", "--json"], tree);
    const found = check(report, "binding");
    expect(found.level).toBe("warn");
    expect(found.detail).toContain(join(repo, ".jubarteai", "config.json"));
    expect(found.detail).not.toContain("config.local.json");
    expect(found.detail).not.toContain("leave the other one alone");
  });

  it("has no binding check without a binding", async () => {
    const { report } = await runJson();
    expect(report.checks.some((c) => c.id === "binding")).toBe(false);
  });
});

describe("doctor: output", () => {
  it("--json is one object with ok, checks and the status report, and --pretty indents it", async () => {
    fake.addKey(TOKEN_GOOD);
    saveSeat("s1", seat("acme", "ada@example.com", TOKEN_GOOD), { makeDefault: true });
    const { out, report, code } = await runJson();
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(Object.keys(report).sort()).toEqual(["checks", "ok", "status"]);
    expect(report.ok).toBe(true);
    expect(report.status.seats).toHaveLength(1);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["node", "cli_version", "credentials", "seat:s1", "skill", "instructions"]));
    for (const c of report.checks) expect(["ok", "warn", "fail"]).toContain(c.level);
    const pretty = await run(["doctor", "--json", "--pretty"]);
    expect(pretty.out.split("\n").length).toBeGreaterThan(5);
  });

  it("takes no arguments", async () => {
    const result = await run(["doctor", "extra"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
  });
});
