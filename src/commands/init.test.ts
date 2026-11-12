import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { createInitSandbox, filesContaining, scriptedTty, sink } from "../../test/helpers/init-sandbox.js";
import type { InitSandbox } from "../../test/helpers/init-sandbox.js";
import { readCredentials, saveSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { INIT_COPY } from "../install/init-copy.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { initCommand, runInit } from "./init.js";
import { linkCommand } from "./link.js";

// Every run starts real git and stub processes; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const KEY = "jba_INITTESTKEYINITTESTKEY0001";
const posix = process.platform !== "win32";
const ACME = { id: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme Inc" };
const BETA = { id: "55555555-5555-4555-8555-555555555555", slug: "beta", name: "Beta LLC" };

let sb: InitSandbox;
let fake: FakeAuthServer;
let savedArgv1: string | undefined;
let hookCommandPrefix: string;

/** Makes the running "bin script" a real file in the sandbox, so the hook command is the absolute-path form. */
function installFakeBin(): void {
  const bin = join(sb.root, "jubarteai.js");
  writeFileSync(bin, "// fake bin\n");
  process.argv[1] = bin;
  hookCommandPrefix = `"${process.execPath}" "${realpathSync(bin)}"`;
}

beforeEach(async () => {
  savedArgv1 = process.argv[1];
  sb = createInitSandbox();
  installFakeBin();
  fake = await startFakeAuthServer();
  process.env.JUBARTEAI_URL = fake.origin;
});

afterEach(async () => {
  if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  await fake.close();
  sb.restore();
});

async function run(argv: string[], cwd: string = sb.repo): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await routeWith([initCommand, linkCommand], argv, { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd });
  return { code, out: out.text(), err: err.text() };
}

function withEnvKey(): void {
  fake.addKey(KEY);
  process.env.JUBARTEAI_TOKEN = KEY;
}

function seat(company: typeof ACME, email: string, token: string, savedAt = "2026-11-01T00:00:00.000Z"): StoredSeat {
  return {
    origin: fake.origin,
    token,
    minted_by: "dashboard",
    key: { id: `key-${company.slug}`, prefix: token.slice(0, 12), name: "Dashboard key" },
    user: { id: `user-${email}`, email },
    company,
    saved_at: savedAt,
  };
}

function storeSeats(): void {
  saveSeat("seat-acme", seat(ACME, "ada@example.com", "jba_ACMEKEYACMEKEYACMEKEY0001", "2026-11-01T00:00:00.000Z"), { makeDefault: false });
  saveSeat("seat-beta", seat(BETA, "ada@example.com", "jba_BETAKEYBETAKEYBETAKEY0002", "2026-11-02T00:00:00.000Z"), { makeDefault: true });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

function trustCodexProject(): void {
  mkdirSync(join(sb.home, ".codex"), { recursive: true });
  writeFileSync(join(sb.home, ".codex", "config.toml"), `[projects.${JSON.stringify(sb.repo)}]\ntrust_level = "trusted"\n`);
}

function summaryLine(err: string, label: RegExp): string {
  // The plan and the prompts print step labels too; the summary line is the last one.
  const line = err.split("\n").filter((l) => label.test(l)).pop();
  expect(line, `a summary line matching ${String(label)} in:\n${err}`).toBeDefined();
  return line as string;
}

describe("init with an environment key and --yes (the bootstrap path)", () => {
  it("signs in from JUBARTEAI_TOKEN, binds the repo privately and configures every detected harness", async () => {
    withEnvKey();
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("");

    // account: saved as a dashboard key under its seat, and the environment variable is gone
    const stored = readCredentials();
    expect(stored.seats[fake.identity.seat_id]).toMatchObject({ minted_by: "dashboard", token: KEY, origin: fake.origin });
    expect(process.env.JUBARTEAI_TOKEN).toBeUndefined();

    // binding: private by default, the workspace and address in config.json, ignored by git
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toEqual({
      version: 1,
      workspace: { id: fake.identity.company.id, slug: "acme" },
      user: { email: "ada@example.com" },
    });
    expect(read(join(sb.repo, ".gitignore"))).toContain("# jubarteai: private workspace binding");

    // skill: one npx call for both detected skill agents, in project scope
    const npx = sb.calls().filter((c) => c.name === "npx");
    expect(npx).toHaveLength(1);
    expect(npx[0]?.args).toEqual(["-y", "skills@1.7.4", "add", "jubarteai/jubarteai-skills", "-a", "claude-code", "-a", "codex", "-y"]);
    expect(npx[0]?.pwd).toBe(sb.repo);

    // AGENTS.md section and the CLAUDE.md import
    expect(read(join(sb.repo, "AGENTS.md"))).toContain("<!-- jubarteai:begin -->");
    expect(read(join(sb.repo, "CLAUDE.md"))).toContain("@AGENTS.md");

    // Claude Code: permission rule and the three hooks, in the fake ~/.claude/settings.json
    const settings = json(join(sb.home, ".claude", "settings.json")) as { permissions: { allow: string[] }; hooks: Record<string, unknown> };
    expect(settings.permissions.allow).toContain("Bash(jubarteai *)");
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    // the hook names this node and this install by absolute path (a desktop-launched editor has no nvm on PATH); the permission rule keeps the bare name
    expect(read(join(sb.home, ".claude", "settings.json"))).toContain(JSON.stringify(`${hookCommandPrefix} hook session-start --harness claude-code`));
    expect(read(join(sb.home, ".codex", "hooks.json"))).toContain(JSON.stringify(`${hookCommandPrefix} hook session-start --harness codex`));
    expect(result.err).toContain(INIT_COPY.hooksRefresh);

    // Codex hooks, and (project not trusted, no opt-in) the D5 fallback: an MCP entry at user level only
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(true);
    const codexConfig = read(join(sb.home, ".codex", "config.toml"));
    expect(codexConfig).toContain("[mcp_servers.jubarteai]");
    expect(codexConfig).toContain(`url = "${fake.origin}/api/mcp"`);
    expect(codexConfig).toContain(`http_headers = { "Authorization" = "Bearer ${KEY}" }`);
    if (posix) expect(statSync(join(sb.home, ".codex", "config.toml")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(sb.repo, ".codex"))).toBe(false);

    // summary: one line per step with the shared statuses, the by-hand block, then the restart line
    expect(result.err).toContain(`Bind this repo to workspace acme: ${INIT_COPY.statusConfigured}`);
    expect(summaryLine(result.err, /^Install skill for claude-code, codex/)).toMatch(/: configured$/);
    expect(summaryLine(result.err, /^AGENTS\.md section/)).toMatch(/: configured$/);
    expect(result.err).toContain(`${INIT_COPY.codexRegisterLabel}: ${INIT_COPY.statusConfigured}`);
    expect(result.err).toContain(INIT_COPY.manualHeading);
    expect(result.err).toContain("Trust the Codex hooks");
    expect(result.err.trimEnd().endsWith(INIT_COPY.restart)).toBe(true);
  });

  it("never lets the key reach a child process, an output stream or a repo file", async () => {
    withEnvKey();
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(sb.calls().length).toBeGreaterThan(0);
    expect(sb.callLog()).not.toContain(KEY);
    expect(sb.callLog()).not.toContain("JUBARTEAI_TOKEN");
    expect(result.err).not.toContain(KEY);
    expect(result.out).not.toContain(KEY);
    // The key lives in the credential file and, for Codex's fallback, Codex's user-level config: nowhere else.
    expect(filesContaining(sb.root, KEY).map((f) => f.slice(sb.root.length)).sort()).toEqual(["/home/.codex/config.toml", "/home/.config/jubarteai/credentials.json"]);
  });

  it("is idempotent: a second run changes nothing and reports already configured", async () => {
    withEnvKey();
    expect((await run(["init", "--yes"])).code).toBe(0);
    const files = [".jubarteai/config.json", ".gitignore", "AGENTS.md", "CLAUDE.md"].map((f) => [f, read(join(sb.repo, f))]);
    const settings = read(join(sb.home, ".claude", "settings.json"));
    const codexConfig = read(join(sb.home, ".codex", "config.toml"));
    const npxBefore = sb.calls().filter((c) => c.name === "npx").length;

    // A new process: no key in the environment, the saved login is used.
    resetEnvTokenForTests();
    const again = await run(["init", "--yes"]);
    expect(again.code, again.err).toBe(0);
    for (const line of summarySteps(again.err)) {
      expect(line, line).toMatch(/: (already configured|skipped \(kept: [^)]*\))$/);
    }
    expect(again.err).toContain(`Bind this repo to workspace acme: ${INIT_COPY.statusAlreadyConfigured}`);
    expect(again.err).not.toMatch(/: configured$/m);
    expect(sb.calls().filter((c) => c.name === "npx")).toHaveLength(npxBefore);
    for (const [name, text] of files) expect(read(join(sb.repo, name as string)), name as string).toBe(text);
    expect(read(join(sb.home, ".claude", "settings.json"))).toBe(settings);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(codexConfig);
    // The user-level Codex entry the first run wrote on purpose (D5 fallback) is not reported back as a leftover,
    // and the hooks, already in place, are not to be trusted again.
    expect(again.err).not.toContain("other Codex projects still use it");
    expect(again.err).not.toContain("Trust the Codex hooks");
  });

  it("a re-run after a Node upgrade rewrites the hook commands in place, never beside the old ones", async () => {
    withEnvKey();
    expect((await run(["init", "--yes"])).code).toBe(0);
    const upgraded = join(sb.root, "v2", "jubarteai.js");
    mkdirSync(join(sb.root, "v2"));
    writeFileSync(upgraded, "// fake bin, moved\n");
    process.argv[1] = upgraded;
    const prefix = `"${process.execPath}" "${realpathSync(upgraded)}"`;

    resetEnvTokenForTests();
    const again = await run(["init", "--yes"]);
    expect(again.code, again.err).toBe(0);
    for (const file of [join(sb.home, ".claude", "settings.json"), join(sb.home, ".codex", "hooks.json")]) {
      const hooks = json(file)["hooks"] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      for (const [event, groups] of Object.entries(hooks)) {
        const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
        expect(commands, `${file} ${event}`).toHaveLength(1);
        expect(commands[0]?.startsWith(`${prefix} hook `), `${file} ${event}`).toBe(true);
      }
    }
    expect(summaryLine(again.err, /session hooks to .*\.claude\/settings\.json/)).toMatch(/: configured$/);
    // The Codex hooks changed, so Codex will ask to trust them again.
    expect(again.err).toContain("Trust the Codex hooks");
    // The permission rule never takes the absolute form.
    expect((json(join(sb.home, ".claude", "settings.json"))["permissions"] as { allow: string[] }).allow).toEqual(["Bash(jubarteai *)"]);
  });

  it("run through npx, the hooks name the bare command and a note says to install globally", async () => {
    withEnvKey();
    mkdirSync(join(sb.root, ".npm", "_npx", "h", "bin"), { recursive: true });
    const cached = join(sb.root, ".npm", "_npx", "h", "bin", "jubarteai.js");
    writeFileSync(cached, "// fake bin\n");
    process.argv[1] = cached;
    const result = await run(["init", "--yes", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".claude", "settings.json"))).toContain('"command": "jubarteai hook session-start --harness claude-code"');
    expect(result.err).toContain(INIT_COPY.npxNote);
  });

  it("OpenCode's instructions name the bare command, never the absolute hook command", async () => {
    withEnvKey();
    mkdirSync(join(sb.home, ".config", "opencode"), { recursive: true });
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("OpenCode: session hooks");
    expect(result.err).toContain("so jubarteai does not write any");
    expect(result.err).toContain("`jubarteai connect`");
    expect(result.err).not.toContain(`${hookCommandPrefix} connect`);
  });
});

/** The step lines of a run's output: from the blank line after the plan up to the notes. */
function summarySteps(err: string): string[] {
  const lines = err.split("\n");
  const start = lines.lastIndexOf("") >= 0 ? lines.findIndex((l, i) => l === "" && /: (configured|already configured|skipped|failed)/.test(lines[i + 1] ?? "")) : -1;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!/: (configured|already configured|skipped|failed)/.test(line)) break;
    out.push(line);
  }
  expect(out.length, err).toBeGreaterThan(0);
  return out;
}

describe("init: browser login", () => {
  it("signs in through the browser callback and uses the new key for the rest of the run", async () => {
    const opened: string[] = [];
    const out = sink();
    const err = sink();
    const code = await runInit(
      { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd: sb.repo, globals: { pretty: false, yes: true } },
      { flags: {}, positionals: [] },
      {
        login: {
          openBrowser: async (url: string) => {
            opened.push(url);
            void fake.approve(url);
            return true;
          },
        },
      },
    );
    expect(code, err.text()).toBe(0);
    expect(opened).toHaveLength(1);
    expect(err.text()).toContain("Signed in as ada@example.com");
    const stored = Object.values(readCredentials().seats);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ minted_by: "cli" });
    // The binding and the codex fallback use the key minted by the login.
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "acme" } });
    const minted = (stored[0] as StoredSeat).token;
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain(minted);
    expect(sb.callLog()).not.toContain(minted);
    expect(err.text()).not.toContain(minted);
  });

  it("signs in to the workspace a repo is bound to when this machine has no login for it", async () => {
    mkdirSync(join(sb.repo, ".jubarteai"));
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), JSON.stringify({ version: 1, workspace: { id: "99999999-9999-4999-8999-999999999999", slug: "gamma" } }));
    saveSeat("seat-acme", seat(ACME, "ada@example.com", "jba_ACMEKEYACMEKEYACMEKEY0001"), { makeDefault: true });
    const opened: string[] = [];
    const out = sink();
    const err = sink();
    await runInit(
      { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd: sb.repo, globals: { pretty: false, yes: true } },
      { flags: {}, positionals: [] },
      { login: { openBrowser: async (url: string) => { opened.push(url); void fake.approve(url); return true; } } },
    );
    expect(err.text()).toContain("This repo uses workspace gamma. Signing in to it.");
    expect(new URL(opened[0] as string).searchParams.get("workspace")).toBe("gamma");
  });
});

describe("init: accounts", () => {
  it("--workspace picks a saved login without asking", async () => {
    storeSeats();
    const result = await run(["init", "--yes", "--workspace", "acme"]);
    expect(result.code, result.err).toBe(0);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "acme" } });
    expect(result.err).toContain("Using ada@example.com — Acme Inc");
  });

  it("rejects --workspace and the browser flags together with an environment key", async () => {
    withEnvKey();
    expect((await run(["init", "--yes", "--workspace", "acme"])).err).toContain(INIT_COPY.workspaceFlagWithKey);
    resetEnvTokenForTests();
    withEnvKey();
    const second = await run(["init", "--yes", "--paste"]);
    expect(second.code).toBe(2);
    expect(second.err).toContain(INIT_COPY.loginFlagsWithKey);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
  });

  it("--paste needs a terminal", async () => {
    const result = await run(["init", "--yes", "--paste"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(INIT_COPY.pasteNeedsTerminal);
    expect(fake.requests).toHaveLength(0);
  });

  it("asks 'Use <email> — <workspace>?' and, on n, offers the saved logins and a new sign-in", async () => {
    storeSeats();
    const tty = scriptedTty((p) => {
      if (p.startsWith("Use ")) return "n";
      if (p.startsWith(INIT_COPY.chooseAccount)) return "2";
      return "";
    });
    const result = await run(["init", "--private-binding", "--no-permissions", "--no-hooks", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    // beta is the default, so it is offered first; the second row is acme
    expect(tty.prompts[0]).toBe("Use ada@example.com — Beta LLC? [Y/n] ");
    expect(tty.prompts[1]).toContain("1) ada@example.com — Beta LLC");
    expect(tty.prompts[1]).toContain("2) ada@example.com — Acme Inc");
    expect(tty.prompts[1]).toContain(`3) ${INIT_COPY.signInOther}`);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "acme" } });
  });
});

describe("init: the prompts, in spec order", () => {
  it("asks account, Proceed, the binding question, then each sensitive step, then cleanup", async () => {
    storeSeats();
    trustCodexProject();
    // an old key-bearing MCP entry for Claude Code, to be offered for removal
    writeFileSync(join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { jubarteai: { type: "http", url: "https://example.com/api/mcp" }, other: { command: "x" } } }));
    const tty = scriptedTty((p) => (p.startsWith(INIT_COPY.shareBindingQuestion) ? "y" : p.startsWith("Share the Codex") ? "n" : ""));
    const result = await run(["init"]);
    expect(result.code, result.err).toBe(0);

    const asked = tty.prompts.map((p) => p.split("\n")[0] as string);
    const at = (needle: string): number => {
      const index = asked.findIndex((p) => p.includes(needle));
      expect(index, `${needle} in ${JSON.stringify(asked)}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at("Use ada@example.com"),
      at("Proceed?"),
      at(INIT_COPY.shareBindingQuestion),
      at("Allow Bash(jubarteai *)"),
      at("Add the JubarteAI session hooks to ~/.claude/settings.json"),
      at("Add the JubarteAI session hooks to ~/.codex/hooks.json"),
      at("Allow network access for jubarteai in Codex"),
      at("Share the Codex network setting"),
      at("Remove the jubarteai MCP entry from ~/.claude.json"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    // the shared answer is in effect: no address in config.json, the address in the ignored local file
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toEqual({ version: 1, workspace: { id: BETA.id, slug: "beta" } });
    expect(json(join(sb.repo, ".jubarteai", "config.local.json"))).toEqual({ version: 1, user: { email: "ada@example.com" } });
    expect(read(join(sb.repo, ".jubarteai", ".gitignore"))).toContain("config.local.json");
    expect(existsSync(join(sb.repo, ".gitignore")) ? read(join(sb.repo, ".gitignore")) : "").not.toContain("private workspace binding");
    // the opt-in is in the project's Codex config (and no D5 registration, which would put a key in Codex's user config)
    expect(read(join(sb.repo, ".codex", "config.toml"))).toContain("network_access = true");
    expect(read(join(sb.home, ".codex", "config.toml"))).not.toContain("mcp_servers");
    // the entry was removed, the other server stayed
    expect(json(join(sb.home, ".claude.json"))).toEqual({ mcpServers: { other: { command: "x" } } });
    // every sensitive prompt showed its entry first, and none ever shows a key
    expect(tty.shown()).toContain("Bash(jubarteai *)");
    expect(tty.shown()).not.toContain("jba_");
  });

  it("answering n to Proceed changes nothing and exits 0", async () => {
    storeSeats();
    scriptedTty((p) => (p.startsWith("Proceed?") ? "n" : ""));
    const result = await run(["init"]);
    expect(result.code).toBe(0);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude", "settings.json"))).toBe(false);
    expect(sb.calls().filter((c) => c.name === "npx")).toHaveLength(0);
    expect(summaryLine(result.err, /^Bind this repo/)).toMatch(/skipped \(declined\)$/);
  });

  it("a sensitive step answered n is skipped; the rest still run", async () => {
    storeSeats();
    scriptedTty((p) => (p.includes("session hooks") ? "n" : ""));
    const result = await run(["init", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(summaryLine(result.err, /^Add the JubarteAI session hooks to ~\/\.claude/)).toMatch(/: skipped \(declined\)$/);
    expect((json(join(sb.home, ".claude", "settings.json")) as { hooks?: unknown }).hooks).toBeUndefined();
    expect(read(join(sb.home, ".claude", "settings.json"))).toContain("Bash(jubarteai *)");
  });
});

describe("init: the binding", () => {
  it("is private with no terminal, and without being asked under --yes", async () => {
    withEnvKey();
    const result = await run(["init"]);
    expect(result.code, result.err).toBe(0);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ user: { email: "ada@example.com" } });
    expect(result.err).toContain(INIT_COPY.bindingPrivate);
  });

  it("--share-binding shares without asking", async () => {
    storeSeats();
    const tty = scriptedTty(() => "");
    const result = await run(["init", "--share-binding", "--no-permissions", "--no-hooks", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.includes("Share this workspace binding"))).toBe(false);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).not.toHaveProperty("user");
    expect(json(join(sb.repo, ".jubarteai", "config.local.json"))).toMatchObject({ user: { email: "ada@example.com" } });
    expect(result.err).toContain(INIT_COPY.bindingShared);
  });

  it("--private-binding makes it private without asking", async () => {
    storeSeats();
    const tty = scriptedTty(() => "");
    const result = await run(["init", "--private-binding", "--no-permissions", "--no-hooks", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.includes("Share this workspace binding"))).toBe(false);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("refuses --share-binding together with --private-binding", async () => {
    storeSeats();
    const result = await run(["init", "--share-binding", "--private-binding", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(INIT_COPY.bindingConflict);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
  });

  it("keeps the shared form of a binding git already tracks, and says why", async () => {
    storeSeats();
    mkdirSync(join(sb.repo, ".jubarteai"));
    const committed = JSON.stringify({ version: 1, workspace: { id: BETA.id, slug: "beta" } }, null, 2) + "\n";
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), committed);
    sb.git(["add", ".jubarteai/config.json"]);
    sb.git(["commit", "-q", "-m", "bind"]);
    const result = await run(["init", "--yes", "--private-binding"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, ".jubarteai", "config.json"))).toBe(committed);
    expect(json(join(sb.repo, ".jubarteai", "config.local.json"))).toMatchObject({ user: { email: "ada@example.com" } });
    expect(result.err).toContain(INIT_COPY.bindingKeptSharedExisting);
  });

  it("never commits an address: a tracked private-form binding becomes shared, with the address in the ignored file", async () => {
    storeSeats();
    mkdirSync(join(sb.repo, ".jubarteai"));
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), JSON.stringify({ version: 1, workspace: { id: BETA.id, slug: "beta" }, user: { email: "ada@example.com" } }, null, 2) + "\n");
    sb.git(["add", ".jubarteai/config.json"]);
    sb.git(["commit", "-q", "-m", "bind"]);
    const result = await run(["init", "--yes", "--private-binding"]);
    expect(result.code, result.err).toBe(0);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).not.toHaveProperty("user");
    expect(json(join(sb.repo, ".jubarteai", "config.local.json"))).toMatchObject({ user: { email: "ada@example.com" } });
    expect(result.err).toContain(INIT_COPY.bindingKeptSharedTracked);
  });

  it("a repo already bound keeps its form on a re-run and is not asked again", async () => {
    storeSeats();
    mkdirSync(join(sb.repo, ".jubarteai"));
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), JSON.stringify({ version: 1, workspace: { id: BETA.id, slug: "beta" } }));
    writeFileSync(join(sb.repo, ".jubarteai", "config.local.json"), JSON.stringify({ version: 1, user: { email: "ada@example.com" } }));
    const tty = scriptedTty(() => "");
    const result = await run(["init", "--no-permissions", "--no-hooks", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.includes("Share this workspace binding"))).toBe(false);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).not.toHaveProperty("user");
  });
});

describe("init: moving a bound repo to another workspace (R-S9)", () => {
  function bindToBeta(): void {
    storeSeats();
    mkdirSync(join(sb.repo, ".jubarteai"));
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), JSON.stringify({ version: 1, workspace: { id: BETA.id, slug: "beta" } }));
    writeFileSync(join(sb.repo, ".jubarteai", "config.local.json"), JSON.stringify({ version: 1, user: { email: "ada@example.com" } }));
  }
  const MOVE = /Move this repo from workspace beta to workspace acme/;
  const ARGS = ["init", "--workspace", "acme", "--no-permissions", "--no-hooks", "--keep-mcp"];

  it("inside an agent's shell, --yes leaves the binding where it is and offers no flag", async () => {
    bindToBeta();
    vi.stubEnv("CODEX_THREAD_ID", "thread-1");
    try {
      const result = await run([...ARGS, "--yes"]);
      expect(result.code, result.err).toBe(0);
      expect(summaryLine(result.err, MOVE)).toContain("needs your approval");
      expect(summaryLine(result.err, MOVE)).not.toContain("rerun with");
      expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { id: BETA.id, slug: "beta" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("with no terminal and no --yes it is skipped with the flag that applies it", async () => {
    bindToBeta();
    const result = await run(ARGS);
    expect(summaryLine(result.err, MOVE)).toContain("rerun with --yes");
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "beta" } });
  });

  it("a person's --yes moves it", async () => {
    bindToBeta();
    const result = await run([...ARGS, "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(summaryLine(result.err, MOVE)).toMatch(/: configured$/);
    expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { id: ACME.id, slug: "acme" } });
  });

  it("a first binding stays a plain step, applied under an agent's --yes", async () => {
    storeSeats();
    vi.stubEnv("CODEX_THREAD_ID", "thread-1");
    try {
      const result = await run([...ARGS, "--yes"]);
      expect(result.code, result.err).toBe(0);
      expect(json(join(sb.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "acme" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("init: sensitive steps", () => {
  it("with no terminal, lists them as skipped with the flag that applies them and writes nothing", async () => {
    withEnvKey();
    const result = await run(["init"]);
    expect(result.code, result.err).toBe(0);
    expect(summaryLine(result.err, /^Allow Bash\(jubarteai \*\)/)).toMatch(/: skipped \(needs confirmation; rerun with --yes\)$/);
    expect(summaryLine(result.err, /^Add the JubarteAI session hooks to ~\/\.claude/)).toMatch(/: skipped \(needs confirmation; rerun with --yes\)$/);
    expect(summaryLine(result.err, new RegExp(`^${INIT_COPY.codexRegisterLabel.replace(/[()']/g, "\\$&")}`))).toMatch(/rerun with --yes\)$/);
    expect(result.err).toContain(INIT_COPY.noTerminal);
    // non-sensitive steps still ran
    expect(existsSync(join(sb.repo, ".jubarteai", "config.json"))).toBe(true);
    expect(existsSync(join(sb.repo, "AGENTS.md"))).toBe(true);
    expect(sb.calls().filter((c) => c.name === "npx")).toHaveLength(1);
    expect(existsSync(join(sb.home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(sb.home, ".codex", "config.toml"))).toBe(false);
  });

  it("--no-permissions and --no-hooks leave those files alone and say which flag did it", async () => {
    withEnvKey();
    const result = await run(["init", "--yes", "--no-permissions", "--no-hooks"]);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(sb.home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(false);
    expect(summaryLine(result.err, /^Allow Bash\(jubarteai \*\)/)).toMatch(/: skipped \(turned off by --no-permissions\)$/);
    expect(summaryLine(result.err, /^Add the JubarteAI session hooks to ~\/\.claude/)).toMatch(/: skipped \(turned off by --no-hooks\)$/);
    expect(summaryLine(result.err, /^Add the JubarteAI session hooks to ~\/\.codex/)).toMatch(/: skipped \(turned off by --no-hooks\)$/);
    // the Codex "trust the hooks" line is about hooks that were not written
    expect(result.err).not.toContain("Trust the Codex hooks");
  });

  it("merges into an existing settings.json without touching other keys or hooks", async () => {
    withEnvKey();
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool" }] }] } }, null, 2),
    );
    const result = await run(["init", "--yes", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    const settings = json(join(sb.home, ".claude", "settings.json")) as { model: string; permissions: { allow: string[] }; hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.model).toBe("x");
    expect(settings.permissions.allow).toEqual(["Bash(ls)", "Bash(jubarteai *)"]);
    const commands = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain("other-tool");
    expect(commands).toContain(`${hookCommandPrefix} hook session-start --harness claude-code`);
  });
});

describe("init: MCP cleanup and Codex", () => {
  function plantClaudeEntry(): void {
    writeFileSync(join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { jubarteai: { type: "http", url: "https://example.com/api/mcp", headers: { Authorization: "Bearer jba_OLDOLDOLDOLDOLDOLD" } }, other: { command: "x" } } }));
  }

  it("--yes removes a planted jubarteai entry and keeps the other servers", async () => {
    withEnvKey();
    plantClaudeEntry();
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(json(join(sb.home, ".claude.json"))).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(summaryLine(result.err, /^Remove the jubarteai MCP entry from ~\/\.claude\.json/)).toMatch(/: configured$/);
  });

  it("--keep-mcp leaves it in place and lists the step as turned off", async () => {
    withEnvKey();
    plantClaudeEntry();
    const before = read(join(sb.home, ".claude.json"));
    const result = await run(["init", "--yes", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".claude.json"))).toBe(before);
    expect(summaryLine(result.err, /^Remove the jubarteai MCP entry from ~\/\.claude\.json/)).toMatch(/: skipped \(turned off by --keep-mcp\)$/);
  });

  it("with no terminal the removal is listed as skipped, never applied", async () => {
    withEnvKey();
    plantClaudeEntry();
    const before = read(join(sb.home, ".claude.json"));
    const result = await run(["init"]);
    expect(read(join(sb.home, ".claude.json"))).toBe(before);
    expect(summaryLine(result.err, /^Remove the jubarteai MCP entry from ~\/\.claude\.json/)).toMatch(/rerun with --yes\)$/);
  });

  it("writes Codex's network opt-in for a trusted project before it removes the project's Codex MCP entry (extras before cleanup)", async () => {
    withEnvKey();
    trustCodexProject();
    mkdirSync(join(sb.repo, ".codex"));
    writeFileSync(join(sb.repo, ".codex", "config.toml"), `[mcp_servers.jubarteai]\nurl = "https://example.com/api/mcp"\n`);
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    const project = read(join(sb.repo, ".codex", "config.toml"));
    expect(project).toContain("network_access = true");
    expect(project).not.toContain("mcp_servers");
    // no fallback registration, so the key is in the credential file only
    expect(read(join(sb.home, ".codex", "config.toml"))).not.toContain("[mcp_servers.jubarteai]");
    expect(filesContaining(sb.root, KEY).map((f) => f.slice(sb.root.length))).toEqual(["/home/.config/jubarteai/credentials.json"]);
  });

  it("asks before writing Codex's fallback entry, shows it without the key, and writes it only on yes", async () => {
    storeSeats();
    const tty = scriptedTty((p) => (p.includes("Register JubarteAI in Codex") ? "y" : ""));
    const result = await run(["init", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.startsWith(`Apply "${INIT_COPY.codexRegisterLabel}"?`))).toBe(true);
    // the entry is shown on the output stream before the question, with a placeholder for the key
    expect(result.err).toContain('http_headers = { "Authorization" = "Bearer <your key>" }');
    expect(tty.shown()).not.toMatch(/jba_[A-Za-z0-9]/);
    expect(result.err).not.toMatch(/jba_[A-Za-z0-9]/);
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain("jba_BETAKEYBETAKEYBETAKEY0002");
  });

  it("keeps a project's Codex MCP entry while no opt-in is possible, and says so instead of asking", async () => {
    withEnvKey();
    mkdirSync(join(sb.repo, ".codex"));
    const original = `[mcp_servers.jubarteai]\nurl = "https://example.com/api/mcp"\n`;
    writeFileSync(join(sb.repo, ".codex", "config.toml"), original);
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, ".codex", "config.toml"))).toBe(original);
    expect(result.err).toContain(INIT_COPY.codexKept);
  });

  it("registers nothing over Codex's own user-level MCP entry, and leaves it as it is", async () => {
    withEnvKey();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const original = `[mcp_servers.jubarteai]\nurl = "https://example.com/api/mcp"\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), original);
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(original);
    expect(result.err).not.toContain(INIT_COPY.codexRegisterLabel);
  });

  it("refreshes the key in Codex's own entry after a re-login revoked the old one: the file holds the new key only", async () => {
    withEnvKey();
    expect((await run(["init", "--yes"])).code).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain(KEY);

    // A new login: another key for the same seat (the old one is revoked by the server).
    const NEW_KEY = "jba_INITTESTNEWKEYNEWKEY0000002";
    fake.addKey(NEW_KEY);
    process.env.JUBARTEAI_TOKEN = NEW_KEY;
    resetEnvTokenForTests();
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    const config = read(join(sb.home, ".codex", "config.toml"));
    expect(config).toContain(`http_headers = { "Authorization" = "Bearer ${NEW_KEY}" }`);
    expect(config).not.toContain(KEY);
    expect(config.match(/\[mcp_servers\.jubarteai\]/g)).toHaveLength(1);
    expect(summaryLine(result.err, new RegExp(`^${INIT_COPY.codexUpdateLabel.replace(/[()']/g, "\\$&")}`))).toMatch(/: configured$/);
    if (posix) expect(statSync(join(sb.home, ".codex", "config.toml")).mode & 0o777).toBe(0o600);
    expect(sb.callLog()).not.toContain(NEW_KEY);
    expect(result.err).not.toContain(NEW_KEY);
    expect(result.err).not.toContain(KEY);
  });

  it("leaves the entry alone when its key is already this account's (nothing to update)", async () => {
    withEnvKey();
    expect((await run(["init", "--yes"])).code).toBe(0);
    const before = read(join(sb.home, ".codex", "config.toml"));
    resetEnvTokenForTests();
    const again = await run(["init", "--yes"]);
    expect(again.err).not.toContain(INIT_COPY.codexUpdateLabel);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(before);
  });

  it("asks before updating the key, shows who Codex will act as, and never shows the key", async () => {
    storeSeats();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const config = `model = "x"\n\n[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\nhttp_headers = { "Authorization" = "Bearer jba_REVOKEDKEYREVOKEDKEY0001" }\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), config);
    const tty = scriptedTty(() => "");
    const result = await run(["init", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.startsWith(`Apply "${INIT_COPY.codexUpdateLabel}"?`))).toBe(true);
    expect(result.err).toContain("Codex will act as ada@example.com — Beta LLC on this machine");
    expect(result.err).toContain('"Authorization" = "Bearer <your key>"');
    expect(result.err + tty.shown()).not.toMatch(/jba_[A-Za-z0-9]/);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(config.replace("jba_REVOKEDKEYREVOKEDKEY0001", "jba_BETAKEYBETAKEYBETAKEY0002"));
  });

  it("with no terminal the key update is listed as skipped with its flag, and the file is untouched", async () => {
    storeSeats();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const config = `[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\nhttp_headers = { "Authorization" = "Bearer jba_REVOKEDKEYREVOKEDKEY0001" }\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), config);
    const result = await run(["init", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(config);
    expect(result.err).toMatch(/Update the key in Codex's MCP config \(user level\): skipped \(needs confirmation; rerun with --yes\)/);
  });

  it("an entry holding another saved workspace's key is left alone even with --yes, and the workspace Codex uses is named (R-S2)", async () => {
    storeSeats();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    // Codex follows Acme; this repo's login (the default seat) is Beta. Both keys are valid saved logins.
    const original = `[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\nhttp_headers = { "Authorization" = "Bearer jba_ACMEKEYACMEKEYACMEKEY0001" }\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), original);
    const result = await run(["init", "--yes", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(original);
    expect(result.err).not.toContain(INIT_COPY.codexUpdateLabel);
    expect(result.err).toContain(INIT_COPY.manualHeading);
    expect(result.err).toContain(INIT_COPY.codexOtherWorkspaceTitle);
    expect(result.err).toContain("workspace Acme Inc");
    expect(result.err).not.toMatch(/jba_[A-Za-z0-9]/);
  });

  it("refreshes a table-form entry (http_headers as its own table) holding a revoked key, in place (R-N3)", async () => {
    storeSeats();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const config = `[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\n\n[mcp_servers.jubarteai.http_headers]\nAuthorization = "Bearer jba_REVOKEDKEYREVOKEDKEY0001"\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), config);
    const result = await run(["init", "--yes", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(config.replace("jba_REVOKEDKEYREVOKEDKEY0001", "jba_BETAKEYBETAKEYBETAKEY0002"));
    expect(result.err).not.toContain(INIT_COPY.codexUnreadableTitle);
    expect(result.err).not.toMatch(/jba_[A-Za-z0-9]/);
  });

  it("an entry for another address is left byte-identical and reported by hand", async () => {
    withEnvKey();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const original = `[mcp_servers.jubarteai]\nurl = "https://other.example.com/api/mcp"\nhttp_headers = { "Authorization" = "Bearer jba_OTHERSERVERKEYOTHER0001" }\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), original);
    const result = await run(["init", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(original);
    expect(result.err).not.toContain(INIT_COPY.codexUpdateLabel);
    expect(result.err).toContain(INIT_COPY.manualHeading);
    expect(result.err).toContain(INIT_COPY.codexForeignTitle);
    expect(result.err).toContain("https://other.example.com/api/mcp");
    expect(result.err).not.toContain("jba_OTHERSERVER");
  });

  it("an entry whose key is not in the inline form is reported, not rewritten", async () => {
    withEnvKey();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const original = `[mcp_servers.jubarteai]\nurl = "${fake.origin}/api/mcp"\nbearer_token_env_var = "JUBARTEAI_TOKEN"\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), original);
    const result = await run(["init", "--yes"]);
    expect(read(join(sb.home, ".codex", "config.toml"))).toBe(original);
    expect(result.err).toContain(INIT_COPY.codexUnreadableTitle);
  });

  it("still offers the fallback entry when the opt-in is declined, and writes it on yes", async () => {
    storeSeats();
    trustCodexProject();
    const tty = scriptedTty((p) => (p.includes("Allow network access for jubarteai") ? "n" : ""));
    const result = await run(["init", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts.some((p) => p.startsWith(`Apply "${INIT_COPY.codexRegisterLabel}"?`))).toBe(true);
    expect(existsSync(join(sb.repo, ".codex", "config.toml"))).toBe(false);
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain("[mcp_servers.jubarteai]");
  });

  it("skips the fallback entry at apply time when the opt-in took effect first", async () => {
    withEnvKey();
    trustCodexProject();
    const result = await run(["init", "--yes", "--no-hooks", "--no-permissions", "--keep-mcp"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, ".codex", "config.toml"))).toContain("network_access = true");
    expect(read(join(sb.home, ".codex", "config.toml"))).not.toContain("[mcp_servers.jubarteai]");
    expect(result.err).toContain(`${INIT_COPY.codexRegisterLabel}: skipped (${INIT_COPY.codexRegisterNotNeeded})`);
  });

  it("an old Codex gets the fallback entry too, and the opt-in is explained by hand", async () => {
    sb.restore();
    sb = createInitSandbox({ codexVersion: "0.150.0" });
    installFakeBin();
    process.env.JUBARTEAI_URL = fake.origin;
    withEnvKey();
    trustCodexProject();
    const result = await run(["init", "--yes", "--no-hooks", "--no-permissions"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain("[mcp_servers.jubarteai]");
    expect(existsSync(join(sb.repo, ".codex"))).toBe(false);
    expect(result.err).toContain("older than 0.162.1");
  });
});

describe("init: where it runs", () => {
  it("from ~ runs the global steps only", async () => {
    withEnvKey();
    const result = await run(["init", "--yes"], sb.home);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain(INIT_COPY.globalOnly);
    expect(existsSync(join(sb.home, ".jubarteai"))).toBe(false);
    expect(existsSync(join(sb.home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(sb.home, "CLAUDE.md"))).toBe(false);
    const npx = sb.calls().filter((c) => c.name === "npx");
    expect(npx).toHaveLength(1);
    expect(npx[0]?.args).toContain("-g");
    expect(npx[0]?.pwd).toBe(sb.home);
    expect(result.err).not.toMatch(/^Bind this repo/m);
    // user-level files are still written
    expect(existsSync(join(sb.home, ".claude", "settings.json"))).toBe(true);
  });

  it("from / runs the global steps only", async () => {
    withEnvKey();
    const result = await run(["init", "--yes", "--no-hooks", "--no-permissions", "--keep-mcp"], "/");
    expect(result.err).toContain(INIT_COPY.globalOnly);
    expect(existsSync("/AGENTS.md")).toBe(false);
    expect(existsSync("/.jubarteai")).toBe(false);
  });
});

describe("init: failures", () => {
  it("exits 1 when a step failed and says which", async () => {
    sb.restore();
    sb = createInitSandbox({ npxExit: 1 });
    installFakeBin();
    process.env.JUBARTEAI_URL = fake.origin;
    withEnvKey();
    const result = await run(["init", "--yes"]);
    expect(result.code).toBe(1);
    expect(summaryLine(result.err, /^Install skill/)).toMatch(/: failed: npx skills add error$/);
    // the other steps still ran
    expect(existsSync(join(sb.repo, "AGENTS.md"))).toBe(true);
  });

  it("an environment key the server rejects fails the sign-in and writes nothing", async () => {
    process.env.JUBARTEAI_TOKEN = "jba_UNKNOWNKEYUNKNOWNKEY0001";
    const result = await run(["init", "--yes"]);
    expect(result.code).toBe(3);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude", "settings.json"))).toBe(false);
    expect(result.err).not.toContain("UNKNOWNKEY");
  });

  it("takes no positional arguments, and never a key on the command line", async () => {
    const result = await run(["init", KEY]);
    expect(result.code).toBe(2);
    expect(result.err).not.toContain(KEY);
  });
});
