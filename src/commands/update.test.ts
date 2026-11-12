// `jubarteai update` end to end, through the router: a throwaway HOME and project (a real git repository), stub
// `npm` / `npx` / `claude` / `jubarteai` on a private PATH that record their argv and whether the key reached them,
// and an injected registry lookup (no network). The skill's latest tree is passed in, so GitHub is never asked.
//
// ported (from the app's src/lib/update-script/flow.test.ts):
//   --check with pending changes exits 2, reports them, runs no npx / plugin update / marketplace update, and changes no file
//   counts exactly the pending changes it listed
//   when everything is current exits 0 with 'Nothing to update' and no pending line
//   with no terminal to ask and no --yes, proceeds and applies the changes
//   --yes skips the prompt (the Proceed row shows --yes) and applies
//   never asks when nothing is pending
//   points at install.sh, exits 0 and creates no AGENTS.md (now: points at jubarteai init)
//   key arguments are refused and masked (now: any positional is refused, never echoed)
//   a key in the caller's environment never reaches a child's environment or the output
//   also stays out of a --check run and of a nothing-installed run
//   a failing npx exits 1 and the closing line counts the failed step
//   tells the user to restart their IDE after a skill update
//   a second run right after an update finds nothing to do
// ported (from src/lib/update-script/static.test.ts):
//   never calls `claude mcp`, `skills check` or `skills update`
//   never embeds a key-shaped value
// Not ported (bash-only): UI modes (--plain, NO_COLOR, JUBARTEAI_UI — the CLI prints plain text only), run through
// curl | bash (stdin draining), the "Unknown argument" usage text (the router owns unknown flags), the Node-floor skip
// (the CLI refuses to start below SKILLS_CLI_MIN_NODE, so update can't run there; skill.test.ts covers the step).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeWith } from "../cli/router.js";
import { HOOK_EVENTS } from "../harness/claude-code.js";
import { CODEX_CODES } from "../harness/codex.js";
import type { HarnessAdapter, ManualInstructions } from "../harness/types.js";
import { harnessGroup } from "../safe-edit/plan.js";
import type { PlanStep } from "../safe-edit/plan.js";
import { AGENTS_MD_MARKERS, SKILL_REPO, SKILLS_CLI_VERSION, agentsMdSnippet, agentsMdSnippetHistory } from "../install/constants.js";
import { cliEntryFor } from "../install/self-update.js";
import { skillTreeSha, type LatestSkill } from "../install/skill.js";
import type { UpdateDeps } from "./update.js";
import { createUpdateCommand, reexecArgs } from "./update.js";

vi.setConfig({ testTimeout: 60_000 });

const posix = process.platform !== "win32";
const FAKE_TOKEN = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const SLUG = "demo";
const CURRENT_CLI = "0.1.0";
const NEWER_CLI = "0.2.0";
const { begin: BEGIN, end: END } = AGENTS_MD_MARKERS;
const trimBlanks = (s: string): string => s.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
const rendered = (snippet: string): string => trimBlanks(snippet).split("<repo-slug>").join(SLUG);
const CURRENT_SECTION = `${BEGIN}\n${rendered(agentsMdSnippet())}\n${END}\n`;
const OLD_SECTION = `${rendered(agentsMdSnippetHistory().at(-1) ?? "")}\n`;

const LATEST_FILES: Record<string, string> = { "SKILL.md": "# jubarteai skill (latest)\n", "references/tools.md": "tools\n" };
const STALE_FILES: Record<string, string> = { "SKILL.md": "# jubarteai skill (old)\n", "references/tools.md": "tools\n" };
const LOCK = JSON.stringify({ version: 1, skills: { jubarteai: { source: SKILL_REPO, computedHash: "x" } } });
const PLUGIN_ID = "jubarteai-mcp@jubarteai";

const STUB = `
const fs = require("fs");
const path = require("path");
const me = path.basename(process.argv[1]);
const dir = __dirname;
const cfgFile = path.join(dir, me + ".json");
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
const argv = process.argv.slice(2);
const env = JSON.stringify(process.env);
const sawToken = "JUBARTEAI_TOKEN" in process.env || env.includes("jba_FAKE");
fs.appendFileSync(path.join(dir, me + ".log"), JSON.stringify({ argv, cwd: fs.realpathSync(process.cwd()), sawToken }) + "\\n");
if (me === "npx") {
  if (cfg.exitCode) process.exit(cfg.exitCode);
  if (argv.includes("add")) {
    const scope = argv.includes("-g") ? "global" : "project";
    for (const target of (cfg.copyTo && cfg.copyTo[scope]) || []) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(cfg.fixture, target, { recursive: true });
    }
  }
} else if (me === "claude") {
  const state = path.join(dir, "claude.state");
  const current = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : cfg.pluginList || []);
  if (argv[0] === "--version") process.stdout.write("2.1.300 (Claude Code)\\n");
  else if (argv[0] === "plugin" && argv[1] === "list") process.stdout.write(JSON.stringify(current()));
  else if (argv[0] === "plugin" && argv[1] === "marketplace") process.exit(0);
  else if (argv[0] === "plugin" && argv[1] === "update") fs.writeFileSync(state, JSON.stringify(cfg.pluginListAfterUpdate || current()));
  else process.exit(64);
} else if (me === "npm") {
  if (argv[0] === "prefix") {
    if (!cfg.globalPrefix) process.exit(1);
    process.stdout.write(cfg.globalPrefix + "\\n");
    process.exit(0);
  }
  if (cfg.stderr) process.stderr.write(cfg.stderr);
  process.exit(cfg.exitCode || 0);
} else if (me === "jubarteai" || me === "jubarteai.js") {
  process.exit(cfg.exitCode || 0);
}
`;

type Call = { argv: string[]; cwd: string; sawToken: boolean };

type Sandbox = { root: string; home: string; project: string; bin: string; fixture: string; latest: LatestSkill; prefix: string };
let sb: Sandbox;
const ENV_KEYS = ["HOME", "USERPROFILE", "PATH", "JUBARTEAI_TOKEN", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function stub(name: "npx" | "claude" | "npm" | "jubarteai", config: object = {}): void {
  const file = join(sb.bin, name);
  writeFileSync(file, `#!${process.execPath}\n${STUB}`);
  chmodSync(file, 0o755);
  writeFileSync(join(sb.bin, `${name}.json`), JSON.stringify({ fixture: sb.fixture, ...config }));
}

/** The bin script npm replaces under the running install's prefix: what the re-exec must run. */
const entryFile = (): string => cliEntryFor(sb.prefix);

function stubEntry(config: object = {}): void {
  const file = entryFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!${process.execPath}\n${STUB}`);
  writeFileSync(`${file}.json`, JSON.stringify(config));
}

function entryCalls(): Call[] {
  return logOf(`${entryFile()}.log`);
}

function calls(name: string): Call[] {
  return logOf(join(sb.bin, `${name}.log`));
}

function logOf(file: string): Call[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Call);
}

const npxAdds = (): Call[] => calls("npx").filter((c) => c.argv.includes("add"));
const npmInstalls = (): Call[] => calls("npm").filter((c) => c.argv[0] === "install");
const claudeMutations = (): Call[] => calls("claude").filter((c) => c.argv[0] === "plugin" && (c.argv[1] === "update" || c.argv[1] === "marketplace"));

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeJsonFile(file: string, value: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function signIn(): void {
  // update only checks that this file exists; its content (a fake key) must never show up anywhere.
  writeJsonFile(join(sb.home, ".config", "jubarteai", "credentials.json"), {
    version: 1,
    default_seat: "seat-1",
    seats: { "seat-1": { key: FAKE_TOKEN, origin: "https://jubarte.ai" } },
  });
}

/** The program part the running install writes into a hook (injected: the test process is not a real install). */
const NEW_HOOK_COMMAND = '"/opt/node-24/bin/node" "/opt/node-24/lib/node_modules/jubarteai/bin/jubarteai.js"';
const OLD_HOOK_COMMAND = '"/opt/node-22/bin/node" "/opt/node-22/lib/node_modules/jubarteai/bin/jubarteai.js"';

const claudeSettingsFile = (): string => join(sb.home, ".claude", "settings.json");
const OTHER_HOOK = { type: "command", command: "echo other-tool", timeout: 3 };

/** ~/.claude/settings.json as `init` leaves it: our three hooks with `program`, plus another tool's hook and a permission rule. */
function writeClaudeHooks(program: string, events: readonly string[] = HOOK_EVENTS.map((e) => e.name)): Record<string, unknown> {
  const hooks: Record<string, unknown> = { Stop: [{ hooks: [OTHER_HOOK] }] };
  for (const e of HOOK_EVENTS.filter((h) => events.includes(h.name))) {
    hooks[e.name] = [{ hooks: [{ type: "command", command: `${program} hook ${e.arg} --harness claude-code`, timeout: e.timeout }] }];
  }
  const doc = { permissions: { allow: ["Bash(jubarteai *)"] }, hooks };
  writeJsonFile(claudeSettingsFile(), doc);
  return doc;
}

const readClaudeSettings = (): { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>> } =>
  JSON.parse(readFileSync(claudeSettingsFile(), "utf8")) as never;

const MCP_ENTRY = { type: "http", url: "https://jubarte.ai/api/mcp", headers: { Authorization: `Bearer ${FAKE_TOKEN}` } };
const OTHER_SERVER = { type: "http", url: "https://example.com/mcp" };

function claudeJsonWithEntry(): string {
  return writeJsonFile(join(sb.home, ".claude.json"), { mcpServers: { jubarteai: MCP_ENTRY, github: OTHER_SERVER } });
}

const projectCopy = (rel: string): string => join(sb.project, rel, "jubarteai");

/** A stale npx project copy that the stub npx refreshes. */
function staleProjectCopy(): string {
  const dir = projectCopy(".claude/skills");
  writeTree(dir, STALE_FILES);
  writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
  stub("npx", { copyTo: { project: [dir] } });
  return dir;
}

function currentProjectCopy(): string {
  const dir = projectCopy(".claude/skills");
  writeTree(dir, LATEST_FILES);
  writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
  return dir;
}

/** Answers the plan's one question: every row stays checked (what pressing Enter does). */
const approveAll: NonNullable<UpdateDeps["approve"]> = async (groups) => ({ kind: "apply", checked: new Set(groups.flatMap((g) => g.rows.map((r) => r.key))) });

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    cb();
  }
}

type RunOpts = { cwd?: string; deps?: Partial<UpdateDeps> };
type RunResult = { code: number; out: string; err: string; fetchLatest: ReturnType<typeof vi.fn>; choice: ReturnType<typeof vi.fn> };

async function update(argv: string[] = [], opts: RunOpts = {}): Promise<RunResult> {
  const fetchLatest = vi.fn(async () => CURRENT_CLI as string | null);
  const choiceFn = vi.fn(async (): Promise<"yes" | "no"> => "yes");
  const deps: Partial<UpdateDeps> = {
    fetchLatest,
    currentVersion: () => CURRENT_CLI,
    isTty: () => false,
    choice: choiceFn as unknown as UpdateDeps["choice"],
    latestSkill: sb.latest,
    nodeVersion: "24.22.3",
    cliCommand: () => ({ command: NEW_HOOK_COMMAND, npx: false }),
    locateInstall: () => ({ prefix: sb.prefix, entry: entryFile() }),
    ...opts.deps,
  };
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await routeWith([createUpdateCommand(deps)], ["update", ...argv], {
    stdout,
    stderr,
    stdin: process.stdin,
    cwd: opts.cwd ?? sb.project,
  });
  return {
    code,
    // update's report is human progress, so it goes to stderr (P3); `out` is what stdout got (nothing).
    out: stderr.text,
    err: stdout.text,
    fetchLatest: (opts.deps?.fetchLatest as ReturnType<typeof vi.fn> | undefined) ?? fetchLatest,
    choice: (opts.deps?.choice as ReturnType<typeof vi.fn> | undefined) ?? choiceFn,
  };
}

const read = (rel: string): string => readFileSync(join(sb.project, rel), "utf8");

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jba-update-")));
  const home = join(root, "home");
  const project = join(home, "code", SLUG);
  const bin = join(root, "bin");
  const fixture = join(root, "fixture");
  for (const dir of [home, project, bin]) mkdirSync(dir, { recursive: true });
  chmodSync(home, 0o700);
  writeTree(fixture, LATEST_FILES);
  const tree = skillTreeSha(fixture);
  if (tree === null) throw new Error("fixture has no tree");
  sb = { root, home, project, bin, fixture, latest: { version: "2.0.0", tree }, prefix: join(root, "prefix") };
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${gitPath}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = bin;
  for (const k of ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) delete process.env[k];
  // main() would have deleted it; it is set here to prove no child and no output ever sees it anyway.
  process.env.JUBARTEAI_TOKEN = FAKE_TOKEN;
  git(["init", "-q"], project);
  git(["remote", "add", "origin", `https://github.com/acme/${SLUG}.git`], project);
  stub("claude");
});

afterEach(() => {
  const recorded = [...["npx", "claude", "npm", "jubarteai"].flatMap((tool) => calls(tool)), ...entryCalls()];
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sb.root, { recursive: true, force: true });
  for (const call of recorded) {
    expect(call.sawToken).toBe(false);
    expect(call.argv.join(" ")).not.toContain("jba_");
    // D21: never `claude mcp get/list`; never `skills check` / `skills update` (both mutate or leak).
    expect(call.argv[0]).not.toBe("mcp");
    expect(call.argv.join(" ")).not.toMatch(/skills@\S+ (check|update)/);
  }
});

describe.skipIf(!posix)("update: self-update", () => {
  it("newer CLI on the registry → asks Proceed?, runs npm install -g jubarteai@<v>, re-execs with --no-self-update and the same flags", async () => {
    // npm's configured global prefix is elsewhere: the CLI that runs lives under sb.prefix (the ~/.local fallback).
    stub("npm", { globalPrefix: "/usr/local" });
    stubEntry({ exitCode: 0 });
    // A stale copy that comes first on PATH must not be what runs next.
    stub("jubarteai", { exitCode: 9 });
    staleProjectCopy();
    const r = await update(["--yes", "--keep-mcp"], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), isTty: () => true } });

    expect(r.code).toBe(0);
    expect(r.out).toContain(`a newer CLI is available: ${CURRENT_CLI} -> ${NEWER_CLI}`);
    // --yes: no prompt for the install either.
    expect(r.choice).not.toHaveBeenCalled();
    // Into the prefix the running CLI came from, so that copy is the one updated.
    expect(npmInstalls().map((c) => c.argv)).toEqual([["install", "-g", "--prefix", sb.prefix, `jubarteai@${NEWER_CLI}`]]);
    // From HOME, so the project's own .npmrc can't pick the registry for a global install.
    expect(npmInstalls()[0]?.cwd).toBe(sb.home);
    // The re-exec runs the file npm replaced under that prefix, never the PATH lookup.
    expect(entryCalls().map((c) => c.argv)).toEqual([["update", "--no-self-update", "--yes", "--keep-mcp"]]);
    expect(calls("jubarteai")).toEqual([]);
    // The new binary runs where update was started (it updates this project).
    expect(entryCalls()[0]?.cwd).toBe(realpathSync(process.cwd()));
    // The new binary did the rest: this process ran no skill step of its own.
    expect(npxAdds()).toEqual([]);
  });

  it("asks Install? on a terminal without --yes, and passes the re-executed CLI's exit code back", async () => {
    stub("npm", { globalPrefix: sb.prefix });
    stubEntry({ exitCode: 1 });
    const choiceFn = vi.fn(async (_ui: unknown, input: { details?: () => string[] }) => {
      // "Show the exact changes" prints what will run.
      expect(input.details?.()).toEqual([`This will run: npm install -g jubarteai@${NEWER_CLI} (into ${sb.prefix})`]);
      return "yes" as const;
    });
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), isTty: () => true, choice: choiceFn as unknown as UpdateDeps["choice"], approve: approveAll } });

    expect(choiceFn).toHaveBeenCalledTimes(1);
    expect((choiceFn.mock.calls as unknown as unknown[][])[0]?.[1]).toMatchObject({ question: `Install jubarteai@${NEWER_CLI}?`, options: ["yes", "no", "show"], defaultIndex: 0 });
    // npm's global prefix is the running one: no --prefix.
    expect(npmInstalls().map((c) => c.argv)).toEqual([["install", "-g", `jubarteai@${NEWER_CLI}`]]);
    expect(entryCalls().map((c) => c.argv)).toEqual([["update", "--no-self-update"]]);
    expect(r.code).toBe(1);
  });

  it("declined → keeps the installed CLI, warns, and carries on with the rest", async () => {
    stub("npm");
    staleProjectCopy();
    // No to the CLI install, yes to the plan that follows.
    const choiceFn = vi.fn(async () => "no" as const);
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), isTty: () => true, choice: choiceFn as unknown as UpdateDeps["choice"], approve: approveAll } });

    expect(choiceFn).toHaveBeenCalledTimes(1);
    expect(npmInstalls()).toEqual([]);
    expect(r.out).toContain("kept the installed CLI");
    expect(npxAdds()).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it("offline → one advisory line, and the update carries on", async () => {
    staleProjectCopy();
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => null) } });

    expect(r.out).toContain("[warn] CLI: 0.1.0; couldn't check for a newer version");
    expect(npmInstalls()).toEqual([]);
    expect(npxAdds()).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it("npm can't write its global folder (EACCES) → the --prefix \"$HOME/.local\" hint, the rest still runs, exit 1", async () => {
    stub("npm", { exitCode: 243, stderr: "npm error code EACCES\n" });
    staleProjectCopy();
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI) } });

    expect(r.out).toContain('npm install -g --prefix "$HOME/.local" jubarteai@0.2.0');
    expect(r.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
    // npm's last lines are shown under the failed row, as text only.
    expect(r.out).toContain("npm error code EACCES");
    expect(npxAdds()).toHaveLength(1);
    expect(r.out).toContain("1 failed");
    expect(r.code).toBe(1);
  });

  it("installed but the updated entry isn't under the prefix → says how to finish, exit 1, and never runs the PATH copy", async () => {
    stub("npm");
    stub("jubarteai");
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI) } });

    expect(r.out).toContain("open a new terminal and run: jubarteai update");
    expect(calls("jubarteai")).toEqual([]);
    expect(r.code).toBe(1);
  });

  it("a CLI outside npm's global folder (npx cache, a checkout) is not self-updated: advisory, and the update carries on", async () => {
    stub("npm");
    staleProjectCopy();
    const r = await update([], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), locateInstall: () => null } });

    expect(r.out).toContain("installed outside npm's global folder");
    expect(r.out).toContain("update it the way you installed it");
    // Neither `npm prefix -g` nor `npm install` (the skill step's own `npm config get registry` is unrelated).
    expect(calls("npm").filter((c) => c.argv[0] === "install" || c.argv[0] === "prefix")).toEqual([]);
    expect(npxAdds()).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it("--check: a newer CLI outside npm's global folder is an advisory, not a change", async () => {
    currentProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), CURRENT_SECTION);
    const r = await update(["--check"], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), locateInstall: () => null } });

    expect(r.out).toContain("[warn] CLI: a newer CLI is available");
    expect(r.code).toBe(0);
  });

  it("--check never installs and reports a newer CLI as a change (exit 2), even when everything else is current", async () => {
    stub("npm");
    currentProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), CURRENT_SECTION);
    const r = await update(["--check"], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI) } });

    expect(npmInstalls()).toEqual([]);
    expect(entryCalls()).toEqual([]);
    expect(r.out).toContain("[todo] CLI: a newer CLI is available");
    expect(r.out).toContain("1 change(s) pending");
    expect(r.code).toBe(2);
  });

  it("--no-self-update never asks the registry", async () => {
    currentProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), CURRENT_SECTION);
    const r = await update(["--no-self-update"]);

    expect(r.fetchLatest).not.toHaveBeenCalled();
    expect(r.out).toContain("CLI: 0.1.0 (self-update skipped)");
    expect(r.code).toBe(0);
  });

  it("re-exec arguments never carry --check or anything but update's own flags", () => {
    expect(reexecArgs({ yes: false, keepMcp: false })).toEqual(["update", "--no-self-update"]);
    expect(reexecArgs({ yes: true, keepMcp: true })).toEqual(["update", "--no-self-update", "--yes", "--keep-mcp"]);
  });
});

describe.skipIf(!posix)("update: --check (D28, D29)", () => {
  it("with pending changes exits 2, reports them, runs no npx / plugin update / marketplace update, and changes no file", async () => {
    staleProjectCopy();
    stub("claude", { pluginList: [{ id: PLUGIN_ID, version: "1.7.0", scope: "user", enabled: true }] });
    writeFileSync(join(sb.project, "AGENTS.md"), OLD_SECTION);
    const r = await update(["--check"]);

    expect(r.code).toBe(2);
    expect(r.out).toContain("[todo] Update plugin jubarteai-mcp@jubarteai (user)");
    expect(r.out).toContain("[todo] Update skill (project, npx copy)");
    expect(r.out).toContain("[todo] AGENTS.md section");
    // counts exactly the pending changes it listed
    expect(r.out.match(/\[todo\]/g)).toHaveLength(3);
    expect(r.out).toContain("3 change(s) pending — run without --check to apply");
    expect(npxAdds()).toEqual([]);
    expect(claudeMutations()).toEqual([]);
    expect(read("AGENTS.md")).toBe(OLD_SECTION);
  });

  it("when everything is current exits 0 with 'Nothing to update' and no pending line", async () => {
    currentProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), CURRENT_SECTION);
    const r = await update(["--check"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to update");
    expect(r.out).not.toContain("[todo]");
    expect(r.out).toContain("already current (2.0.0)");
  });
});

describe.skipIf(!posix)("update: applying (D28)", () => {
  it("with no terminal to ask and no --yes, proceeds and applies the changes; tells the user to restart", async () => {
    const dir = staleProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), `# Demo\n\n${OLD_SECTION}`);
    const r = await update();

    expect(r.code).toBe(0);
    expect(r.choice).not.toHaveBeenCalled();
    expect(npxAdds().map((c) => c.argv)).toEqual([["-y", `skills@${SKILLS_CLI_VERSION}`, "add", SKILL_REPO, "-a", "claude-code", "-y"]]);
    expect(npxAdds()[0]?.cwd).toBe(sb.project);
    expect(skillTreeSha(dir)).toBe(sb.latest.tree);
    expect(read("AGENTS.md")).toBe(`# Demo\n\n${CURRENT_SECTION}`);
    expect(r.out).toContain("Restart your IDE(s) to pick up the updated skill.");
    expect(r.out).toMatch(/Done in [^ ]+ — 2 ok\n/);
    expect(r.out).toContain("Restart your editor or agent so it picks up the changes.");

    // a second run right after an update finds nothing to do, and never asks
    const again = await update([], { deps: { isTty: () => true } });
    expect(again.code).toBe(0);
    expect(again.out).toContain("Everything is up to date");
    expect(again.choice).not.toHaveBeenCalled();
    expect(npxAdds()).toHaveLength(1);
  });

  it("on a terminal asks the one question; --yes skips it", async () => {
    staleProjectCopy();
    const approve = vi.fn(approveAll);
    const asked = await update(["--no-self-update"], { deps: { isTty: () => true, approve } });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(asked.code).toBe(0);

    staleProjectCopy();
    await update(["--yes", "--no-self-update"], { deps: { isTty: () => true, approve } });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(npxAdds()).toHaveLength(2);
  });

  it("a failing npx exits 1 and the closing line counts the failed step", async () => {
    const dir = projectCopy(".claude/skills");
    writeTree(dir, STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stub("npx", { exitCode: 1 });
    writeFileSync(join(sb.project, "AGENTS.md"), OLD_SECTION);
    const r = await update();

    expect(r.code).toBe(1);
    expect(r.out).toContain("Update skill (project, npx copy): failed");
    expect(r.out).toContain("1 step(s) failed — see above.");
    // the other step still ran
    expect(read("AGENTS.md")).toBe(CURRENT_SECTION);
  });
});

describe.skipIf(!posix)("update: nothing installed (D30)", () => {
  it("points at jubarteai init, exits 0 and creates no AGENTS.md", async () => {
    const r = await update();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to update — JubarteAI is not set up here yet.");
    expect(r.out).toContain("To set it up, run: jubarteai init");
    expect(existsSync(join(sb.project, "AGENTS.md"))).toBe(false);

    const check = await update(["--check"]);
    expect(check.code).toBe(0);
  });
});

describe.skipIf(!posix)("update: MCP cleanup (D3, D5)", () => {
  it("offers the removal and applies it with --yes: only the jubarteai entry goes", async () => {
    signIn();
    const file = claudeJsonWithEntry();
    const r = await update(["--yes"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { github: OTHER_SERVER } });
    expect(r.out).toContain("Remove the jubarteai MCP entry from ~/.claude.json");
    expect(r.out).toContain("removed the jubarteai entry");
  });

  it("lists the removal as a row of the one question and keeps the entry when it is unchecked", async () => {
    signIn();
    const file = claudeJsonWithEntry();
    const before = readFileSync(file, "utf8");
    // The one question lists the removal as a row; the person unchecks it.
    const approve = vi.fn(async (groups: Parameters<NonNullable<UpdateDeps["approve"]>>[0]) => ({
      kind: "apply" as const,
      checked: new Set(groups.flatMap((g) => g.rows).filter((row) => !row.label.includes("MCP entry")).map((row) => row.key)),
    }));
    const r = await update(["--no-self-update"], { deps: { isTty: () => true, approve } });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(r.out).toContain("skipped (not selected)");
    expect(r.code).toBe(0);
  });

  it("without a terminal and without --yes the removal is skipped and names --yes", async () => {
    signIn();
    const file = claudeJsonWithEntry();
    const before = readFileSync(file, "utf8");
    const r = await update();

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(r.out).toContain("skipped (needs confirmation; rerun with --yes)");
    expect(r.code).toBe(0);

    // --check counts it as a change
    const check = await update(["--check"]);
    expect(check.code).toBe(2);
    expect(check.out).toContain("[todo] Remove the jubarteai MCP entry from ~/.claude.json");
  });

  it("--keep-mcp keeps the entries and lists them as kept", async () => {
    signIn();
    const file = claudeJsonWithEntry();
    const before = readFileSync(file, "utf8");
    const r = await update(["--yes", "--keep-mcp"]);

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(r.out).toContain("skipped (kept (--keep-mcp))");
    expect(r.code).toBe(0);
    expect((await update(["--check", "--keep-mcp"])).code).toBe(0);
  });

  it("with no jubarteai login on this machine keeps every entry (the agents still use them)", async () => {
    const file = claudeJsonWithEntry();
    const before = readFileSync(file, "utf8");
    const r = await update(["--yes"]);

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(r.out).toContain("no jubarteai login, so the MCP entries stay");
    expect(r.code).toBe(0);
  });

  it("Codex keeps its entry unless its network opt-in is in place, even with --yes, and says why", async () => {
    signIn();
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    const toml = `model = "o4"\n\n[mcp_servers.jubarteai]\nurl = "https://jubarte.ai/api/mcp"\n`;
    writeFileSync(join(sb.home, ".codex", "config.toml"), toml);
    mkdirSync(join(sb.project, ".codex"), { recursive: true });
    writeFileSync(join(sb.project, ".codex", "config.toml"), toml);
    const r = await update(["--yes"]);

    expect(readFileSync(join(sb.home, ".codex", "config.toml"), "utf8")).toBe(toml);
    expect(readFileSync(join(sb.project, ".codex", "config.toml"), "utf8")).toBe(toml);
    expect(r.out).not.toContain("Remove the jubarteai MCP entry");
    expect(r.out).toContain("Do these by hand:");
    expect(r.out).toContain("keeps its jubarteai MCP entry");
    // Not "remove it by hand" either: under D5 the entry stays until the opt-in is in place.
    expect(r.out).not.toContain("remove it by hand");
    // update writes no hooks, so it never tells the user to trust them
    expect(r.out).not.toContain("Trust the Codex hooks");
    expect(r.code).toBe(0);
    // A kept Codex entry is not a change
    expect((await update(["--check"])).code).toBe(0);
  });
});

describe.skipIf(!posix)("update: Codex instructions are read by their code, never their text", () => {
  /** A Codex adapter whose instructions carry codes but unfamiliar wording, and one project entry to clean. */
  function fakeCodex(): { adapter: HarnessAdapter; applied: () => number } {
    let applied = 0;
    const manual = (title: string, line: string, code: string): ManualInstructions => ({ kind: "manual", harness: "codex", title, lines: [line], reason: "test", code });
    const cleanup: PlanStep = {
      id: "mcp-cleanup:codex:project:x",
      label: "Remove the jubarteai MCP entry from .codex/config.toml",
      group: harnessGroup("codex"),
      files: [],
      sensitive: true,
      async apply() {
        applied++;
        return { id: "mcp-cleanup:codex:project:x", label: "Remove", status: "configured" };
      },
    };
    const adapter: HarnessAdapter = {
      id: "codex",
      label: "Codex CLI",
      skillAgent: null,
      sessionVar: null,
      promptInjection: true,
      detect: async () => true,
      permission: async () => null,
      hooks: async () => null,
      inspect: async () => ({ permission: "n/a", hooks: "n/a", mcpEntries: [], notes: [] }),
      mcpCleanup: async () => [cleanup],
      extras: async () => [
        manual("Network access, reworded", "a reason worded some new way", CODEX_CODES.networkManual),
        manual("Hooks, reworded", "trust them some new way", CODEX_CODES.trustHooks),
      ],
    };
    return { adapter, applied: () => applied };
  }

  it("the opt-in's instructions explain the kept entry, the trust note is dropped, and nothing is removed", async () => {
    signIn();
    const fake = fakeCodex();
    const r = await update(["--yes"], { deps: { detect: async () => [fake.adapter] } });

    expect(fake.applied()).toBe(0);
    expect(r.out).toContain("a reason worded some new way");
    // The generic explanation is only for a pending opt-in that came with no instructions of its own.
    expect(r.out).not.toContain("Codex keeps its jubarteai MCP entry");
    expect(r.out).not.toContain("trust them some new way");
    expect(r.code).toBe(0);
  });
});

describe.skipIf(!posix)("update: run from ~ (D26)", () => {
  it("updates global copies only, from HOME, and writes no AGENTS.md or CLAUDE.md there", async () => {
    const dir = join(sb.home, ".claude", "skills", "jubarteai");
    writeTree(dir, STALE_FILES);
    mkdirSync(join(sb.home, ".agents"), { recursive: true });
    writeFileSync(join(sb.home, ".agents", ".skill-lock.json"), LOCK);
    stub("npx", { copyTo: { global: [dir] } });
    const r = await update([], { cwd: sb.home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("~ is your home folder, not a project; global installs only");
    expect(npxAdds().map((c) => c.argv)).toEqual([["-y", `skills@${SKILLS_CLI_VERSION}`, "add", SKILL_REPO, "-g", "-a", "claude-code", "-y"]]);
    expect(npxAdds()[0]?.cwd).toBe(sb.home);
    expect(existsSync(join(sb.home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(sb.home, "CLAUDE.md"))).toBe(false);
  });
});

describe.skipIf(!posix)("update: no key, ever (D2, D3, D21)", () => {
  it("a whole run (self-update, skill, AGENTS.md, MCP) with a stored key and JUBARTEAI_TOKEN set never shows the key", async () => {
    signIn();
    claudeJsonWithEntry();
    staleProjectCopy();
    writeFileSync(join(sb.project, "AGENTS.md"), OLD_SECTION);
    stub("npm");
    const outputs: string[] = [];

    // 1. the self-update hand-over (npm + the new binary)
    stubEntry();
    const handed = await update(["--yes"], { deps: { fetchLatest: vi.fn(async () => NEWER_CLI), isTty: () => true } });
    outputs.push(handed.out, handed.err);
    expect(entryCalls()).toHaveLength(1);

    // 2. the rest, in this process: check, then apply (prompting, so every preview is printed)
    const check = await update(["--check"]);
    const applied = await update([], { deps: { isTty: () => true, approve: approveAll } });
    outputs.push(check.out, check.err, applied.out, applied.err);
    expect(applied.code).toBe(0);
    expect(npxAdds()).toHaveLength(1);

    for (const text of outputs) {
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain("jba_");
    }
    // every stub's argv and environment were checked in afterEach (sawToken, argv)
    expect(npmInstalls()).toHaveLength(1);
  });

  it("refuses any argument without echoing it (a key pasted by mistake)", async () => {
    const r = await update([FAKE_TOKEN]);
    expect(r.code).toBe(2);
    expect(`${r.out}${r.err}`).not.toContain(FAKE_TOKEN);
    expect(r.out).toContain("update takes no arguments, and never a key");
  });

  it("the update sources never read credentials, resolve a seat, take the env key, call whoami or claude mcp", () => {
    const here = dirname(new URL(import.meta.url).pathname);
    for (const file of [join(here, "update.ts"), join(here, "..", "install", "self-update.ts"), join(here, "..", "install", "update-report.ts")]) {
      const source = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of ["readCredentials", "resolveSeat", "takeEnvToken", "whoami", "auth/", '"mcp"', "skills check", "jba_"]) {
        expect(source, `${file} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe.skipIf(!posix)("update: hook commands after a Node upgrade (R-S4)", () => {
  it("--check reports the stale hook commands and writes nothing", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND);
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update(["--check"]);

    expect(r.code).toBe(2);
    expect(r.out).toContain("[todo] Refresh the hook command in Claude Code");
    expect(r.out.match(/\[todo\] Refresh the hook command/g)).toHaveLength(1);
    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
  });

  it("--yes rewrites the program of our three entries in place: no new entry, other hooks and settings untouched", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND);
    const r = await update(["--yes"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("Refresh the hook command in Claude Code");
    const doc = readClaudeSettings();
    for (const e of HOOK_EVENTS) {
      expect(doc.hooks[e.name]).toEqual([{ hooks: [{ type: "command", command: `${NEW_HOOK_COMMAND} hook ${e.arg} --harness claude-code`, timeout: e.timeout }] }]);
    }
    expect(doc.hooks["Stop"]).toEqual([{ hooks: [OTHER_HOOK] }]);
    expect(Object.keys(doc.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(readClaudeSettings()).toMatchObject({ permissions: { allow: ["Bash(jubarteai *)"] } });

    // A second run finds them current.
    const again = await update(["--check"]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("[todo]");
  });

  it("without a terminal and without --yes the sensitive step is not applied, and says which flag applies it", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND);
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update([]);

    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
    expect(r.out).toContain("Refresh the hook command in Claude Code");
    expect(r.out).toContain("--yes");
  });

  it("updates a hook that still names a bare jubarteai, and one with an older timeout", async () => {
    const doc = writeClaudeHooks("jubarteai");
    const start = (doc["hooks"] as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>)["SessionStart"];
    if (start?.[0]?.hooks[0] !== undefined) start[0].hooks[0].timeout = 1;
    writeJsonFile(claudeSettingsFile(), doc);
    await update(["--yes"]);
    const after = readClaudeSettings();
    expect(after.hooks["SessionStart"]?.[0]?.hooks[0]).toEqual({ type: "command", command: `${NEW_HOOK_COMMAND} hook session-start --harness claude-code`, timeout: HOOK_EVENTS[0].timeout });
  });

  it("adds nothing when only some events are registered: it points at init instead and leaves the file alone", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND, ["SessionStart"]);
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update(["--yes"]);

    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
    expect(r.out).toContain("[info] Hooks: Claude Code: some of the session hooks are missing; run jubarteai init to add them");
    expect(r.out).not.toContain("Refresh the hook command");
  });

  it("does nothing for a machine with no hooks of ours: it does not register any", async () => {
    writeJsonFile(claudeSettingsFile(), { hooks: { Stop: [{ hooks: [OTHER_HOOK] }] } });
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update(["--yes"]);

    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
    expect(r.out).not.toContain("Refresh the hook command");
    expect(r.code).toBe(0);
  });

  it("leaves hooks that already carry the running install's command alone", async () => {
    writeClaudeHooks(NEW_HOOK_COMMAND);
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update(["--check"]);

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[todo]");
    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
  });

  it("from a throwaway npx copy it keeps the hooks it finds (that copy's path would not outlive the cache)", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND);
    const before = readFileSync(claudeSettingsFile(), "utf8");
    const r = await update(["--yes"], { deps: { cliCommand: () => ({ command: "jubarteai", npx: true }) } });

    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe(before);
    expect(r.out).not.toContain("Refresh the hook command");
  });

  it("never reads the key to do it (the environment key and the credentials file stay out of the output)", async () => {
    writeClaudeHooks(OLD_HOOK_COMMAND);
    const r = await update(["--yes"]);
    expect(r.out + r.err).not.toContain(FAKE_TOKEN);
  });
});
