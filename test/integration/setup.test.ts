// `init` and `update` through the built binary, with recording stubs for npx, npm, claude and codex on PATH:
// what gets written (binding, AGENTS.md section, Claude Code settings, Codex), what gets removed (MCP entries),
// that a second run changes nothing, and that update reports a stale section with exit 2.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { FAKE_KEY, IS_WINDOWS, createSandbox, plantJson, previousAgentsMdSection } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const OLD_KEY = "jba_OLDINSTALLERKEY000000000000000001";
const MARKERS = { begin: "<!-- jubarteai:begin -->", end: "<!-- jubarteai:end -->" };
const HOOKS = [
  { event: "SessionStart", arg: "session-start", timeout: 8 },
  { event: "UserPromptSubmit", arg: "user-prompt-submit", timeout: 8 },
  { event: "SessionEnd", arg: "session-end", timeout: 5 },
] as const;

let fake: FakeServer;
let box: Sandbox;

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

async function setup(stubs: Parameters<typeof createSandbox>[0] = {}): Promise<void> {
  fake = await startFakeServer();
  box = createSandbox(stubs);
}

/** The "<label>: <status>" lines init prints at the end. */
function summary(stderr: string): Array<{ label: string; status: string }> {
  return stderr
    .split("\n")
    .map((line) => /^(\S.*): (configured|already configured|skipped.*|failed.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ label: m[1] as string, status: m[2] as string }));
}

const settingsPath = (): string => join(box.home, ".claude", "settings.json");
const agentsMd = (): string => join(box.repo, "AGENTS.md");

describe("init and update", () => {
  describe("init --yes", () => {
    beforeEach(async () => {
      await setup({ stubs: ["npx", "npm", "claude"] });
    });

    async function plantOldInstall(): Promise<void> {
      // What the old installer left: the MCP entry (with a key) in Claude Code's user config and in the project's .mcp.json,
      // beside other servers that must survive.
      plantJson(join(box.home, ".claude.json"), {
        numStartups: 3,
        mcpServers: {
          jubarteai: { type: "http", url: "https://jubarte.ai/api/mcp", headers: { Authorization: `Bearer ${OLD_KEY}` } },
          other: { command: "other-server" },
        },
      });
      plantJson(join(box.repo, ".mcp.json"), {
        mcpServers: { jubarteai: { type: "http", url: "https://jubarte.ai/api/mcp" }, other: { command: "project-server" } },
      });
      plantJson(settingsPath(), {
        theme: "dark",
        permissions: { allow: ["Bash(ls)"] },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo someone-elses-hook" }] }] },
      });
    }

    test("writes the binding, the AGENTS.md section, the Claude Code permission and hooks, and removes the old MCP entries", async () => {
      expect((await box.signInWithKey(fake)).code).toBe(0);
      await plantOldInstall();

      const result = await box.run(["init", "--yes"]);
      expect(result.code, result.stderr).toBe(0);
      expect(summary(result.stderr).every((row) => row.status === "configured")).toBe(true);

      // The binding names the workspace and the user, and is kept out of git.
      const binding = box.readJson(join(box.repo, ".jubarteai", "config.json"));
      expect(binding).toMatchObject({ version: 1, workspace: { id: fake.identity.company.id, slug: "acme" }, user: { email: "ada@example.com" } });
      expect(box.read(join(box.repo, ".gitignore"))).toContain("/.jubarteai/");

      // The section is between its markers, with the repo's name filled in, and Claude Code imports AGENTS.md.
      const agents = box.read(agentsMd());
      expect(agents).toContain(MARKERS.begin);
      expect(agents).toContain(MARKERS.end);
      expect(agents).toContain("JubarteAI Agent Identity");
      expect(agents).not.toContain("<repo-slug>");
      expect(box.read(join(box.repo, "CLAUDE.md"))).toContain("@AGENTS.md");

      // Claude Code: the permission rule and the three hooks, next to what was already there.
      const settings = box.readJson(settingsPath()) as {
        theme: string;
        permissions: { allow: string[] };
        hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
      };
      expect(settings.theme).toBe("dark");
      // Windows adds the PowerShell spelling beside the Bash rule.
      expect(settings.permissions.allow).toEqual(IS_WINDOWS ? ["Bash(ls)", "Bash(jubarteai *)", "PowerShell(jubarteai *)"] : ["Bash(ls)", "Bash(jubarteai *)"]);
      expect(settings.hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe("echo someone-elses-hook");
      for (const { event, arg, timeout } of HOOKS) {
        const ours = (settings.hooks[event] ?? []).flatMap((group) => group.hooks).filter((hook) => hook.command.endsWith(` hook ${arg} --harness claude-code`));
        expect(ours, event).toHaveLength(1);
        expect(ours[0]).toMatchObject({ type: "command", timeout });
      }

      // The old entries are gone (and the old key with them); the other servers and keys stay.
      expect(box.readJson(join(box.home, ".claude.json"))).toEqual({ numStartups: 3, mcpServers: { other: { command: "other-server" } } });
      expect(box.readJson(join(box.repo, ".mcp.json"))).toEqual({ mcpServers: { other: { command: "project-server" } } });
      expect(box.findLeaks([OLD_KEY])).toEqual([]);
    });

    test("installs the skill through npx at the project, and no key reaches npx, npm or claude", async () => {
      await box.signInWithKey(fake);
      await box.run(["init", "--yes"]);

      const [add] = box.stubCalls("npx");
      expect(add?.argv).toEqual(["-y", "skills@1.7.4", "add", "jubarteai/jubarteai-skills", "-a", "claude-code", "-y"]);
      expect(add?.cwd).toBe(box.repo);
      expect(existsSync(join(box.repo, ".claude", "skills", "jubarteai", "SKILL.md"))).toBe(true);
      // Every child process: no key in its argv, its environment, or anywhere in what it recorded.
      expect(box.stubCalls().length).toBeGreaterThan(1);
      for (const call of box.stubCalls()) {
        expect(JSON.stringify(call.argv)).not.toContain(FAKE_KEY);
        expect(Object.keys(call.env)).not.toContain("JUBARTEAI_TOKEN");
      }
      expect(box.findLeaks([FAKE_KEY])).toEqual([]);
    });

    test("the hook command init registered is the one a harness can run: it connects an agent", async () => {
      await box.signInWithKey(fake);
      await box.run(["init", "--yes"]);
      const settings = box.readJson(settingsPath()) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      const command = settings.hooks["SessionStart"]?.[0]?.hooks[0]?.command as string;

      const started = await box.runShell(command, { stdin: JSON.stringify({ session_id: "from-settings", cwd: box.repo, source: "startup" }) });
      expect(started.code).toBe(0);
      expect(started.stdout).toMatch(/Your JubarteAI agent_id is [0-9a-f-]{36}/);
      expect(fake.agents).toHaveLength(1);
      expect(fake.agents[0]?.description).toBe("claude-code on acme-app");
    });

    // The guard's `bash` line is POSIX shell syntax (`|| true`); Windows runs the `powershell` line instead.
    test.skipIf(IS_WINDOWS)("with Copilot present, init registers the preToolUse guard, and its own command denies an agent's login but not inbox (review R-S12)", async () => {
      mkdirSync(join(box.home, ".copilot"), { recursive: true });
      await box.signInWithKey(fake);
      const result = await box.run(["init", "--yes"]);
      expect(result.code, result.stderr).toBe(0);
      const doc = box.readJson(join(box.home, ".copilot", "hooks", "jubarteai.json")) as { hooks: Record<string, Array<Record<string, unknown>>> };
      const guard = doc.hooks["preToolUse"]?.[0];
      expect(guard).toMatchObject({ type: "command", matcher: "bash|powershell", timeoutSec: 8 });
      const bash = guard?.["bash"] as string;
      expect(bash).toMatch(/ hook pre-tool-use --harness vscode \|\| true$/);

      const callsBefore = fake.toolCalls().length;
      const payload = (command: string): string => JSON.stringify({ sessionId: "s", timestamp: 1, cwd: box.repo, toolName: "bash", toolArgs: JSON.stringify({ command }) });
      const login = await box.runShell(bash, { stdin: payload("echo jba_x | jubarteai \"login\" --with-token") });
      expect(login.code).toBe(0);
      expect(login.stderr).toBe("");
      expect(JSON.parse(login.stdout)).toMatchObject({ permissionDecision: "deny" });
      const inbox = await box.runShell(bash, { stdin: payload("jubarteai inbox --agent 11111111-1111-4111-8111-111111111111") });
      expect(inbox.code).toBe(0);
      expect(JSON.parse(inbox.stdout)).toEqual({});
      // The guard never calls the server.
      expect(fake.toolCalls()).toHaveLength(callsBefore);
    });

    test("a second init changes nothing: every line says already configured and no file differs", async () => {
      await box.signInWithKey(fake);
      await plantOldInstall();
      await box.run(["init", "--yes"]);
      const files = [settingsPath(), agentsMd(), join(box.repo, "CLAUDE.md"), join(box.repo, ".gitignore"), join(box.repo, ".mcp.json"), join(box.home, ".claude.json"), join(box.repo, ".jubarteai", "config.json"), box.credentialsFile];
      const before = files.map((file) => readFileSync(file, "utf8"));
      const mtimes = files.map((file) => statSync(file).mtimeMs);

      const again = await box.run(["init", "--yes"]);
      expect(again.code, again.stderr).toBe(0);
      const rows = summary(again.stderr);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.status !== "already configured")).toEqual([]);
      expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      expect(files.map((file) => statSync(file).mtimeMs)).toEqual(mtimes);
    });

    test("--no-hooks --no-permissions --keep-mcp leave the harness files alone", async () => {
      await box.signInWithKey(fake);
      await plantOldInstall();
      const result = await box.run(["init", "--yes", "--no-hooks", "--no-permissions", "--keep-mcp"]);
      expect(result.code, result.stderr).toBe(0);
      const settings = box.readJson(settingsPath()) as { permissions: { allow: string[] }; hooks: Record<string, unknown[]> };
      expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
      expect(Object.keys(settings.hooks)).toEqual(["SessionStart"]);
      expect(settings.hooks["SessionStart"]).toHaveLength(1);
      expect(JSON.stringify(box.readJson(join(box.repo, ".mcp.json")))).toContain("jubarteai");
      expect(JSON.stringify(box.readJson(join(box.home, ".claude.json")))).toContain(OLD_KEY);
    });

    test("with the key in JUBARTEAI_TOKEN and no saved login, init signs in with it and the key stays out of every child", async () => {
      fake.addKey(FAKE_KEY);
      const result = await box.run(["init", "--yes"], { env: { JUBARTEAI_TOKEN: FAKE_KEY, JUBARTEAI_URL: fake.origin } });
      expect(result.code, result.stderr).toBe(0);
      expect(box.readJson(box.credentialsFile)["seats"]).toHaveProperty(fake.identity.seat_id);
      expect(box.stubCalls().length).toBeGreaterThan(0);
      expect(box.findLeaks([FAKE_KEY])).toEqual([]);
    });

    test("with nobody signed in, init --yes starts the browser login and waits for it (no key is invented)", async () => {
      const running = box.start(["init", "--yes", "--no-browser"], { env: { JUBARTEAI_URL: fake.origin } });
      const [, url] = await running.waitFor("stderr", /(https?:\/\/\S+\/cli\/authorize\?\S+)/);
      await fake.authorize(url as string);
      const result = await running.exit;
      expect(result.code, result.stderr).toBe(0);
      expect(fake.mintedKeys()).toHaveLength(1);
      expect(box.readJson(join(box.repo, ".jubarteai", "config.json"))).toMatchObject({ workspace: { slug: "acme" } });
      expect(box.findLeaks(fake.mintedKeys())).toEqual([]);
    });
  });

  describe("init with Codex installed", () => {
    beforeEach(async () => {
      await setup();
    });

    test("writes Codex's hooks, registers its user-level MCP entry privately, and a second run is a no-op", async () => {
      await box.signInWithKey(fake);
      const result = await box.run(["init", "--yes"]);
      expect(result.code, result.stderr).toBe(0);

      const codexHooks = box.readJson(join(box.home, ".codex", "hooks.json")) as { hooks: Record<string, unknown[]> };
      expect(Object.keys(codexHooks.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "UserPromptSubmit"]);
      expect(box.stubCalls("codex").every((call) => call.argv.join(" ") === "--version")).toBe(true);

      // Codex cannot reach the CLI without its network opt-in, so it keeps an MCP entry: the key goes into
      // Codex's own user config only, not into any project file.
      const codexConfig = join(box.home, ".codex", "config.toml");
      expect(box.read(codexConfig)).toContain("[mcp_servers.jubarteai]");
      if (!IS_WINDOWS) expect(statSync(codexConfig).mode & 0o777).toBe(0o600);
      expect(box.findLeaks([FAKE_KEY], { allowFiles: [codexConfig] })).toEqual([]);

      const again = await box.run(["init", "--yes"]);
      expect(again.code, again.stderr).toBe(0);
      expect(summary(again.stderr).filter((row) => row.status !== "already configured")).toEqual([]);
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await setup({ stubs: ["npx", "npm", "claude"] });
      await box.signInWithKey(fake);
      expect((await box.run(["init", "--yes"])).code).toBe(0);
      // Something to update: the skill copies init just made would be re-installed from GitHub (which the sandbox
      // cannot reach), so they go; an MCP entry that --keep-mcp leaves alone stands in for "a JubarteAI setup exists".
      for (const dir of [".claude", ".agents"]) await rmDir(join(box.repo, dir));
      plantJson(join(box.repo, ".mcp.json"), { mcpServers: { jubarteai: { type: "http", url: "https://jubarte.ai/api/mcp" } } });
    });

    const check = (): ReturnType<Sandbox["run"]> => box.run(["update", "--check", "--no-self-update", "--keep-mcp"]);

    test("--check exits 0 when the AGENTS.md section is current", async () => {
      const result = await check();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("[todo]");
    });

    test("--check exits 2 once the section is an older release's, and changes nothing", async () => {
      makeSectionStale();
      const staleText = box.read(agentsMd());
      const result = await check();
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("[todo]");
      expect(result.stderr).toContain("AGENTS.md");
      expect(box.read(agentsMd())).toBe(staleText);
    });

    test("update --yes refreshes the stale section, then --check is clean again", async () => {
      const current = box.read(agentsMd());
      makeSectionStale();
      const applied = await box.run(["update", "--yes", "--no-self-update", "--keep-mcp"]);
      expect(applied.code, applied.stderr).toBe(0);
      expect(box.read(agentsMd())).toBe(current);
      expect((await check()).code).toBe(0);
    });

    test("update never talks to the JubarteAI server and never reads the key", async () => {
      makeSectionStale();
      const before = fake.requests.length;
      await check();
      await box.run(["update", "--yes", "--no-self-update", "--keep-mcp"]);
      expect(fake.requests.length).toBe(before);
      expect(box.findLeaks([FAKE_KEY])).toEqual([]);
    });

    test("update refuses a key on the command line without echoing it", async () => {
      const result = await box.run(["update", FAKE_KEY]);
      expect(result.code).toBe(2);
      expect(result.stdout + result.stderr).not.toContain(FAKE_KEY);
    });

    test("an unreadable credentials file is not a reason to fail the check (update only looks that it exists)", async () => {
      writeFileSync(box.credentialsFile, "{ not json");
      chmodSync(box.credentialsFile, 0o600);
      const result = await check();
      expect(result.code).toBe(0);
    });

    test("with nothing installed it says so and exits 0", async () => {
      await rmDir(join(box.repo, ".mcp.json"));
      const result = await check();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("not set up here yet");
      expect(result.stderr).toContain("jubarteai init");
    });

    function makeSectionStale(): void {
      const text = box.read(agentsMd());
      const start = text.indexOf(MARKERS.begin) + MARKERS.begin.length;
      const end = text.indexOf(MARKERS.end);
      expect(start).toBeGreaterThan(MARKERS.begin.length - 1);
      writeFileSync(agentsMd(), `${text.slice(0, start)}\n${previousAgentsMdSection("acme-app")}\n${text.slice(end)}`);
    }
  });
});

async function rmDir(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}
