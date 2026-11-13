// `jubarteai uninstall` through the router, after a real `init --yes` on the same throwaway machine: every file init wrote
// is taken back to what it was (or removed when init made it), other tools' entries survive, and the approval rules of
// init apply (a person's checklist, --yes, no terminal, never an agent).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { createInitSandbox, scriptedTty, sink } from "../../test/helpers/init-sandbox.js";
import type { InitSandbox } from "../../test/helpers/init-sandbox.js";
import { readCredentials } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { initCommand } from "./init.js";
import { uninstallCommand } from "./uninstall.js";

vi.setConfig({ testTimeout: 60_000 });

const KEY = "jba_UNINSTALLKEYUNINSTALLKEY01";
const posix = process.platform !== "win32";
const CHECKLIST_PROMPT = "press Enter for all: ";

let sb: InitSandbox;
let fake: FakeAuthServer;
let savedArgv1: string | undefined;

beforeEach(async () => {
  savedArgv1 = process.argv[1];
  sb = createInitSandbox();
  const bin = join(sb.root, "jubarteai.js");
  writeFileSync(bin, "// fake bin\n");
  process.argv[1] = bin;
  fake = await startFakeAuthServer();
  process.env.JUBARTEAI_URL = fake.origin;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  await fake.close();
  sb.restore();
});

async function run(argv: string[], cwd: string = sb.repo): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await routeWith([initCommand, uninstallCommand], argv, { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd });
  return { code, out: out.text(), err: err.text() };
}

/** init --yes with an environment key, the way the install one-liner runs it. */
async function initAll(): Promise<void> {
  fake.addKey(KEY);
  process.env.JUBARTEAI_TOKEN = KEY;
  const result = await run(["init", "--yes"]);
  expect(result.code, result.err).toBe(0);
  resetEnvTokenForTests();
}

const read = (path: string): string => readFileSync(path, "utf8");
const json = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

describe.skipIf(!posix)("uninstall after init", () => {
  it("takes back every file init wrote and keeps other tools' entries", async () => {
    mkdirSync(join(sb.home, ".claude"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({ model: "x", permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }, null, 2),
    );
    writeFileSync(join(sb.repo, "AGENTS.md"), "# Demo\n\nHello.\n");
    await initAll();
    expect(read(join(sb.repo, "AGENTS.md"))).toContain("jubarteai:begin");
    expect(existsSync(join(sb.repo, ".jubarteai", "config.json"))).toBe(true);
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(true);

    const result = await run(["uninstall", "--yes"]);
    expect(result.code, result.err).toBe(0);
    // Claude Code: only the other tool's settings remain.
    expect(json(join(sb.home, ".claude", "settings.json"))).toEqual({
      model: "x",
      permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] },
    });
    // Files init created are gone; the one it appended to is back to its text.
    expect(existsSync(join(sb.home, ".codex", "hooks.json"))).toBe(false);
    expect(read(join(sb.repo, "AGENTS.md"))).toBe("# Demo\n\nHello.\n");
    // init made CLAUDE.md (git never saw it) and it holds only the import: it goes, though AGENTS.md keeps the user's text.
    expect(existsSync(join(sb.repo, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
    expect(existsSync(join(sb.repo, ".gitignore")) ? read(join(sb.repo, ".gitignore")) : "").not.toContain("jubarteai");
    // The saved login is gone (local only); the key still works until revoked, and the output says so.
    expect(readCredentials().seats).toEqual({});
    expect(result.err).toContain("This key still works until you revoke it in Dashboard → API keys.");
    expect(result.err).toContain("npm uninstall -g jubarteai");
    expect(result.err).not.toContain(KEY);
    // Codex's fallback MCP entry held the key: it is removed too.
    expect(existsSync(join(sb.home, ".codex", "config.toml")) ? read(join(sb.home, ".codex", "config.toml")) : "").not.toContain("mcp_servers.jubarteai");
    // The stub installer left hand-style copies (no lock file), which the CLI doesn't delete: they are printed.
    expect(result.err).toContain("Skill hand copy (project)");
    expect(sb.calls().filter((c) => c.name === "npx").some((c) => c.args.includes("remove"))).toBe(false);
  });

  it("removes a skill the skills installer made through its own remove command", async () => {
    await initAll();
    writeFileSync(join(sb.repo, "skills-lock.json"), JSON.stringify({ version: 1, skills: { jubarteai: { source: "jubarteai/jubarteai-skills", computedHash: "x" } } }));
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    const removes = sb.calls().filter((c) => c.name === "npx" && c.args.includes("remove"));
    expect(removes.length).toBeGreaterThan(0);
    expect(removes[0]?.args).toEqual(expect.arrayContaining(["-y", "skills@1.7.4", "remove", "jubarteai", "-a", "claude-code", "-y"]));
    expect(removes[0]?.pwd).toBe(sb.repo);
    expect(removes[0]?.env).not.toContain(KEY);
  });

  it("takes back Codex's project network opt-in and the .gitignore line that kept it private, and its fallback MCP key", async () => {
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    writeFileSync(join(sb.home, ".codex", "config.toml"), `[projects.${JSON.stringify(sb.repo)}]\ntrust_level = "trusted"\n`);
    await initAll();
    expect(read(join(sb.repo, ".codex", "config.toml"))).toContain("network_access = true");
    expect(read(join(sb.repo, ".gitignore"))).toContain("/.codex/config.toml");
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(sb.repo, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(sb.repo, ".gitignore")) ? read(join(sb.repo, ".gitignore")) : "").not.toContain(".codex");
    // The person's own trust setting is theirs and stays.
    expect(read(join(sb.home, ".codex", "config.toml"))).toContain('trust_level = "trusted"');
  });

  it("in a worktree with its own binding it removes that one and names the main checkout's, which stays", async () => {
    await initAll();
    sb.git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "base"]);
    const tree = join(sb.root, "wt");
    sb.git(["worktree", "add", "-q", tree]);
    const main = JSON.parse(read(join(sb.repo, ".jubarteai", "config.json"))) as Record<string, unknown>;
    mkdirSync(join(tree, ".jubarteai"));
    writeFileSync(join(tree, ".jubarteai", "config.json"), JSON.stringify(main));
    const result = await run(["uninstall", "--yes", "--keep-login", "--skip-harness", "claude-code", "--skip-harness", "codex"], realpathSync(tree));
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(tree, ".jubarteai", "config.json"))).toBe(false);
    expect(existsSync(join(sb.repo, ".jubarteai", "config.json"))).toBe(true);
    expect(result.err).toContain("The main checkout keeps its own binding");
    expect(result.err).toContain(`${realpathSync(sb.repo)}/.jubarteai`);
  });

  it("in a worktree it still removes its own binding when the main checkout's binding can't be read", async () => {
    await initAll();
    sb.git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "base"]);
    const tree = join(sb.root, "wt");
    sb.git(["worktree", "add", "-q", tree]);
    const main = JSON.parse(read(join(sb.repo, ".jubarteai", "config.json"))) as Record<string, unknown>;
    mkdirSync(join(tree, ".jubarteai"));
    writeFileSync(join(tree, ".jubarteai", "config.json"), JSON.stringify(main));
    // A binding written by a newer CLI: valid JSON, a version this one doesn't read.
    writeFileSync(join(sb.repo, ".jubarteai", "config.json"), JSON.stringify({ ...main, version: 2 }));
    const result = await run(["uninstall", "--yes", "--keep-login", "--skip-harness", "claude-code", "--skip-harness", "codex"], realpathSync(tree));
    expect(result.code, result.err).toBe(0);
    expect(result.err).not.toContain("could not read its config files");
    expect(existsSync(join(tree, ".jubarteai", "config.json"))).toBe(false);
    // The main checkout's file is untouched, and the output still says it stays.
    expect(existsSync(join(sb.repo, ".jubarteai", "config.json"))).toBe(true);
    expect(result.err).toContain("The main checkout keeps its own binding");
  });

  it("in a worktree with its own binding and none in the main checkout it removes that one and adds no note", async () => {
    await initAll();
    sb.git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "base"]);
    const tree = join(sb.root, "wt");
    sb.git(["worktree", "add", "-q", tree]);
    const main = JSON.parse(read(join(sb.repo, ".jubarteai", "config.json"))) as Record<string, unknown>;
    mkdirSync(join(tree, ".jubarteai"));
    writeFileSync(join(tree, ".jubarteai", "config.json"), JSON.stringify(main));
    rmSync(join(sb.repo, ".jubarteai"), { recursive: true, force: true });
    const result = await run(["uninstall", "--yes", "--keep-login", "--skip-harness", "claude-code", "--skip-harness", "codex"], realpathSync(tree));
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(tree, ".jubarteai", "config.json"))).toBe(false);
    expect(result.err + result.out).not.toContain("The main checkout keeps its own binding");
  });

  it("--keep-login leaves the saved logins", async () => {
    await initAll();
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(Object.keys(readCredentials().seats)).toHaveLength(1);
    expect(result.err).not.toContain("Sign out");
  });

  it("with no terminal and no --yes nothing is removed and each row names the flag", async () => {
    await initAll();
    const before = read(join(sb.home, ".claude", "settings.json"));
    const result = await run(["uninstall"]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("skipped (needs confirmation; rerun with --yes)");
    expect(read(join(sb.home, ".claude", "settings.json"))).toBe(before);
    expect(Object.keys(readCredentials().seats)).toHaveLength(1);
  });

  it("refuses inside an agent's shell, and changes nothing", async () => {
    await initAll();
    vi.stubEnv("CLAUDECODE", "1");
    const tty = scriptedTty(() => "");
    const result = await run(["uninstall", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("needs you, not an agent");
    expect(tty.prompts).toEqual([]);
    expect(Object.keys(readCredentials().seats)).toHaveLength(1);
    expect(existsSync(join(sb.repo, ".jubarteai", "config.json"))).toBe(true);
  });

  it("on a terminal the checklist lists every row, signing out is one of them, and leaving it out keeps the login", async () => {
    await initAll();
    const tty = scriptedTty((prompt) => (prompt.includes(CHECKLIST_PROMPT) ? (prompt.split("\n").flatMap((l) => /^\s+(\d+)\. Sign out/.exec(l)?.[1] ?? []).join(" ")) : ""));
    const result = await run(["uninstall"]);
    expect(result.code, result.err).toBe(0);
    const checklist = tty.prompts.find((p) => p.includes(CHECKLIST_PROMPT)) as string;
    expect(checklist).toContain("Choose what to remove");
    expect(checklist).toContain("Remove the JubarteAI session hooks from ~/.claude/settings.json");
    expect(checklist).toContain("Sign out of every saved login on this machine (affects every repo)");
    expect(Object.keys(readCredentials().seats)).toHaveLength(1);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
    expect(result.err).not.toContain("This key still works");
  });

  it("says so when there is nothing to remove", async () => {
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("Nothing of JubarteAI's was found here to remove.");
    expect(result.err).toContain("npm uninstall -g jubarteai");
  });

  it("--skip-harness leaves that harness's files alone; an unknown id is suggested", async () => {
    await initAll();
    const hooks = read(join(sb.home, ".codex", "hooks.json"));
    const result = await run(["uninstall", "--yes", "--keep-login", "--skip-harness", "codex"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.home, ".codex", "hooks.json"))).toBe(hooks);
    const bad = await run(["uninstall", "--skip-harness", "claude_code"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('Did you mean "claude-code"?');
  });

  it("a hook file with comments is not rewritten and the removal is printed instead", async () => {
    await initAll();
    const file = join(sb.home, ".claude", "settings.json");
    const doc = read(file);
    writeFileSync(file, `// my notes\n${doc}`);
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(read(file)).toBe(`// my notes\n${doc}`);
    expect(result.err).toContain("Do these by hand:");
    expect(result.err).toContain("settings.json");
  });

  it("a git-tracked (shared) binding is left for a commit and said so", async () => {
    await initAll();
    // A committed config.json: the user shared the binding.
    const config = join(sb.repo, ".jubarteai", "config.json");
    writeFileSync(config, JSON.stringify({ version: 1, workspace: json(config)["workspace"] }, null, 2) + "\n");
    sb.git(["add", "-f", ".jubarteai/config.json"]);
    sb.git(["commit", "-q", "-m", "bind"]);
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(result.err).toContain("git rm -r .jubarteai");
  });

  it("removes the import line from a CLAUDE.md that init appended to, once AGENTS.md goes", async () => {
    writeFileSync(join(sb.repo, "CLAUDE.md"), "# Notes\n");
    await initAll();
    expect(read(join(sb.repo, "CLAUDE.md"))).toContain("@AGENTS.md");
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, "CLAUDE.md"))).toBe("# Notes\n");
    expect(existsSync(join(sb.repo, "AGENTS.md"))).toBe(false); // init created it, it held only the section
    expect(realpathSync(sb.repo)).toBeTruthy();
  });

  it("removes a CLAUDE.md that only imported the AGENTS.md init created", async () => {
    await initAll();
    expect(read(join(sb.repo, "CLAUDE.md"))).toBe("@AGENTS.md\n");
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(sb.repo, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(sb.repo, "AGENTS.md"))).toBe(false);
  });

  it("keeps a committed CLAUDE.md that only imports AGENTS.md while AGENTS.md survives, and says so", async () => {
    writeFileSync(join(sb.repo, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(sb.repo, "AGENTS.md"), "# Rules\n");
    sb.git(["add", "CLAUDE.md", "AGENTS.md"]);
    sb.git(["commit", "-q", "-m", "mine"]);
    await initAll();
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, "CLAUDE.md"))).toBe("@AGENTS.md\n");
    expect(read(join(sb.repo, "AGENTS.md"))).toBe("# Rules\n");
    expect(result.err + result.out).toContain("CLAUDE.md still imports AGENTS.md");
  });

  it("leaves a user's own CLAUDE.md alone in a repo init never touched", async () => {
    writeFileSync(join(sb.repo, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(sb.repo, "CLAUDE.md"), "@AGENTS.md\n");
    const result = await run(["uninstall", "--yes", "--keep-login"]);
    expect(result.code, result.err).toBe(0);
    expect(read(join(sb.repo, "CLAUDE.md"))).toBe("@AGENTS.md\n");
    expect(read(join(sb.repo, "AGENTS.md"))).toBe("# Rules\n");
    expect(result.out + result.err).not.toContain("held only the JubarteAI lines");
  });
});
