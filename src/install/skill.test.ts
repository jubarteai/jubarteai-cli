// Tests for the skill install and update channels. Every external command is a stub
// `npx` / `claude` / `git` on a private PATH that records its argv, cwd and whether
// it saw the key; HOME and the project are throwaway folders. Nothing touches the
// network (the latest skill is always passed in) or a real claude.
//
// ported (from the app's src/lib/update-script/skill.test.ts and install-script.test.ts):
//   updates a stale user-scope plugin: marketplace update, then plugin update --scope user, then the reload tip
//   leaves a current plugin alone: no marketplace update, no plugin update, no reload tip
//   updates this project's local-scope entry with --scope local, run from the project root
//   runs a project-scope update from the entry's own projectPath, not another project's
//   fails, and names the entry it hit, when claude plugin update changed another project's entry instead of this one
//   reports this project's entry as updated and warns about another project's entry the same update also moved
//   lists another project's entry as not touched and never passes it to plugin update
//   makes no plugin call at all when the only entry belongs to another project
//   reports a synced entry without touching it
//   warns, without changing anything, when the plugin is disabled for this project
//   without claude on PATH reads installed_plugins.json (v2), advises, and runs neither claude nor npx
//   warns that Claude Code 2.1.270 updates the wrong scope when a plugin is installed
//   does not print the wrong-scope warning on Claude Code 2.1.281 or newer
//   re-adds a stale npx project copy from the project root, without -g, and refreshes it
//   re-adds a stale npx global copy with -g, from HOME
//   re-adds a stale shared .agents/skills copy in one call with -a universal
//   dedupes .claude/skills/jubarteai symlinked into .agents/skills: one call with the owner agent
//   plans an overwrite for a hand copy, names the skills-lock.json it creates, and still adds it
//   with two project hand copies, names the skills-lock.json only on the first row and notes it once
//   does not mention skills-lock.json for a hand copy when the project already has one
//   makes no npx call for a copy whose tree already matches the latest, and says so
//   re-adds every copy and reports 're-installed' when the latest skill is unknown (GitHub unreachable)
//   warns about a duplicate load, naming both removal options, when the plugin and a claude-code copy coexist
//   marks a failed npx add as failed and still runs the next step
//   skips a stale copy on Node below the floor: no npx, advisory with the manual command
//   on Node below the floor, the manual command for a project under HOME is `cd ~/<path> && ...`
//   on Node below the floor, quotes a project root with a space in the manual command
//   --check with a stale copy and a stale plugin changes nothing and runs no npx or claude mutation (planning only)
//   install: one npx call with every detected agent as -a (install-script "Skill install"), skipped on old Node, skipped with no harness
// Not ported: the ctrl-c / sigterm tests (the bash spinner's signal handling; run.ts owns child timeouts and kills).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { SKILL_REPO, SKILLS_CLI_VERSION } from "./constants.js";
import { detectSkillChannels, planSkillSteps, skillTreeSha } from "./skill.js";
import type { LatestSkill } from "./skill.js";

// Each test spawns a few real child processes (stubs and git); a loaded machine can outlast the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const FAKE_TOKEN = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const PLUGIN_ID = "jubarteai-mcp@jubarteai";
const OLD_VERSION = "1.7.0";
const NEW_VERSION = "1.7.1";
const OTHER_PROJECT = "/somewhere/else/other-project";
const posix = process.platform !== "win32";

const LATEST_FILES: Record<string, string> = { "SKILL.md": "# jubarteai skill (latest)\n", "references/tools.md": "tools\n" };
const STALE_FILES: Record<string, string> = { "SKILL.md": "# jubarteai skill (old)\n", "references/tools.md": "tools\n" };
const HAND_FILES: Record<string, string> = { "SKILL.md": "# jubarteai skill (my local edits)\n" };
const LOCK = JSON.stringify({ version: 1, skills: { jubarteai: { source: SKILL_REPO, computedHash: "x" } } });

const STUB_PRELUDE = `
const fs = require("fs");
const path = require("path");
const me = path.basename(process.argv[1]);
const dir = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(dir, me + ".json"), "utf8"));
const argv = process.argv.slice(2);
const sawToken = "JUBARTEAI_TOKEN" in process.env || Object.values(process.env).some((v) => String(v).includes("jba_FAKE"));
fs.appendFileSync(path.join(dir, me + ".log"), JSON.stringify({ argv: argv, cwd: fs.realpathSync(process.cwd()), sawToken: sawToken, env: { registry: process.env.npm_config_registry === undefined ? null : process.env.npm_config_registry, nodeOptionsNpm: process.env.npm_config_node_options === undefined ? null : process.env.npm_config_node_options, nodeOptions: process.env.NODE_OPTIONS === undefined ? null : process.env.NODE_OPTIONS } }) + "\\n");
`;

const NPX_STUB = `${STUB_PRELUDE}
if (cfg.exitCode) process.exit(cfg.exitCode);
if (argv.includes("add")) {
  const scope = argv.includes("-g") ? "global" : "project";
  for (const target of (cfg.copyTo && cfg.copyTo[scope]) || []) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(cfg.fixture, target, { recursive: true });
  }
  const lock = path.join(process.cwd(), "skills-lock.json");
  if (cfg.writesLock && scope === "project" && !fs.existsSync(lock)) fs.writeFileSync(lock, "{}\\n");
}
`;

const CLAUDE_STUB = `${STUB_PRELUDE}
const state = path.join(dir, "claude.state");
const current = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : cfg.pluginList || []);
if (argv[0] === "--version") {
  process.stdout.write((cfg.version || "2.1.300") + " (Claude Code)\\n");
} else if (argv[0] === "plugin" && argv[1] === "list") {
  if (cfg.listExit) process.exit(cfg.listExit);
  process.stdout.write(JSON.stringify(current()));
} else if (argv[0] === "plugin" && argv[1] === "marketplace") {
  if (cfg.marketplaceExit) process.exit(cfg.marketplaceExit);
} else if (argv[0] === "plugin" && argv[1] === "update") {
  if (cfg.updateExit) process.exit(cfg.updateExit);
  let next = current();
  if (cfg.pluginListAfterUpdate) next = cfg.pluginListAfterUpdate;
  else if (cfg.pluginUpdateByCwd) {
    const here = fs.realpathSync(process.cwd());
    next = next.map((e) => (e.projectPath === here ? Object.assign({}, e, { version: cfg.pluginUpdateByCwd }) : e));
  }
  fs.writeFileSync(state, JSON.stringify(next));
} else {
  process.exit(64);
}
`;

type Call = { argv: string[]; cwd: string; sawToken: boolean; env: Record<string, string | null> };
type NpxConfig = { exitCode?: number; copyTo?: { project?: string[]; global?: string[] }; writesLock?: boolean };
type ClaudeConfig = {
  version?: string;
  pluginList?: unknown[];
  pluginListAfterUpdate?: unknown[];
  pluginUpdateByCwd?: string;
  marketplaceExit?: number;
  updateExit?: number;
  listExit?: number;
};

type Sandbox = {
  root: string;
  home: string;
  project: string;
  bin: string;
  fixture: string;
  latest: LatestSkill;
};

const ENV_KEYS = ["HOME", "USERPROFILE", "PATH", "CLAUDE_CONFIG_DIR", "JUBARTEAI_TOKEN"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let sb: Sandbox;

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function writeStub(name: string, script: string, config: object): void {
  const file = join(sb.bin, name);
  writeFileSync(file, `#!${process.execPath}\n${script}`);
  chmodSync(file, 0o755);
  writeFileSync(join(sb.bin, `${name}.json`), JSON.stringify(config));
}

function stubNpx(config: NpxConfig = {}): void {
  writeStub("npx", NPX_STUB, { fixture: sb.fixture, ...config });
}

/** An npm whose `config get registry` answers from the registry= line of $HOME/.npmrc, like npm's user config. */
const NPM_STUB = `${STUB_PRELUDE}
if (argv.join(" ") === "config get registry") {
  let registry = "https://registry.npmjs.org/";
  try {
    const m = /^registry=(.*)$/m.exec(fs.readFileSync(path.join(process.env.HOME, ".npmrc"), "utf8"));
    if (m) registry = m[1].trim();
  } catch (e) {}
  if (cfg.answer !== undefined) registry = cfg.answer;
  process.stdout.write(registry + "\\n");
} else {
  process.exit(64);
}
`;

function stubNpm(config: { answer?: string } = {}): void {
  writeStub("npm", NPM_STUB, config);
}

function stubClaude(config: ClaudeConfig = {}): void {
  writeStub("claude", CLAUDE_STUB, config);
}

function calls(tool: "npx" | "claude" | "npm"): Call[] {
  const file = join(sb.bin, `${tool}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
}

const claudeMutations = (): Call[] =>
  calls("claude").filter((c) => c.argv[0] === "plugin" && (c.argv[1] === "update" || c.argv[1] === "marketplace"));

/** The exact argv of a skills add call. */
const addArgv = (...rest: string[]): string[] => ["-y", `skills@${SKILLS_CLI_VERSION}`, "add", SKILL_REPO, ...rest, "-y"];

function copyAt(path: string, files: Record<string, string>): string {
  writeTree(path, files);
  return path;
}

const projectCopy = (rel: string): string => join(sb.project, rel, "jubarteai");
const homeCopy = (rel: string): string => join(sb.home, rel, "jubarteai");

type Opts = { root?: string | null; cwd?: string; latest?: LatestSkill | null; nodeVersion?: string; mode?: "init" | "update"; agents?: string[] };

async function plan(opts: Opts = {}): Promise<PlanStep[]> {
  return planSkillSteps({
    root: opts.root === undefined ? sb.project : opts.root,
    cwd: opts.cwd ?? sb.project,
    mode: opts.mode ?? "update",
    agents: opts.agents ?? [],
    latest: opts.latest === undefined ? sb.latest : opts.latest,
    nodeVersion: opts.nodeVersion ?? "24.22.1",
  });
}

async function applyAll(steps: PlanStep[]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) results.push(await step.apply());
  return results;
}

/** Plan, then apply every step; the first return value is the plan itself. */
async function run(opts: Opts = {}): Promise<{ steps: PlanStep[]; results: StepResult[] }> {
  const steps = await plan(opts);
  return { steps, results: await applyAll(steps) };
}

const find = (results: StepResult[], needle: string): StepResult => {
  const hit = results.find((r) => r.label.includes(needle) || r.id.includes(needle));
  if (hit === undefined) throw new Error(`no step matching ${needle}: ${results.map((r) => r.label).join(" | ")}`);
  return hit;
};

const userPlugin = (version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PLUGIN_ID,
  version,
  scope: "user",
  enabled: true,
  ...extra,
});
const projectPlugin = (scope: string, projectPath: string, version: string): Record<string, unknown> => ({
  id: PLUGIN_ID,
  version,
  scope,
  enabled: true,
  projectPath,
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jba-skill-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const fixture = join(root, "fixture");
  for (const dir of [home, project, bin]) mkdirSync(dir, { recursive: true });
  writeTree(fixture, LATEST_FILES);
  const tree = skillTreeSha(fixture);
  if (tree === null) throw new Error("fixture has no tree");
  sb = { root, home, project, bin, fixture, latest: { version: NEW_VERSION, tree } };
  // git is the one real tool the code runs; npx and claude are stubs (or absent).
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${gitPath}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = bin;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.JUBARTEAI_TOKEN = FAKE_TOKEN;
});

afterEach(() => {
  // A key in the caller's environment must never reach a child.
  for (const tool of ["npx", "claude", "npm"] as const) {
    for (const call of calls(tool)) {
      expect(call.sawToken).toBe(false);
      expect(call.argv.join(" ")).not.toContain("jba_");
    }
  }
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sb.root, { recursive: true, force: true });
});

describe.skipIf(!posix)("skill: Claude Code plugin channel", () => {
  it("updates a stale user-scope plugin: marketplace update, then plugin update --scope user, then the reload tip", async () => {
    stubNpx();
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], pluginListAfterUpdate: [userPlugin(NEW_VERSION)] });
    const { results } = await run();

    const step = find(results, "Update plugin");
    expect(step.status).toBe("configured");
    expect(step.detail).toContain(`updated ${OLD_VERSION} -> ${NEW_VERSION} (user)`);
    expect(step.detail).toContain("/reload-plugins");
    expect(claudeMutations().map((c) => c.argv.join(" "))).toEqual([
      "plugin marketplace update jubarteai",
      `plugin update ${PLUGIN_ID} --scope user`,
    ]);
  });

  it("leaves a current plugin alone: no marketplace update, no plugin update, no reload tip", async () => {
    stubClaude({ pluginList: [userPlugin(NEW_VERSION)] });
    const { results } = await run();

    const step = find(results, "Plugin jubarteai-mcp");
    expect(step.status).toBe("already configured");
    expect(step.detail).toBe(`already current (${NEW_VERSION}, user)`);
    expect(claudeMutations()).toEqual([]);
    expect(results.map((r) => r.detail ?? "").join("\n")).not.toContain("/reload-plugins");
    expect(results.map((r) => r.detail ?? "").join("\n")).not.toContain("wrong scope");
  });

  it("updates this project's local-scope entry with --scope local, run from the project root", async () => {
    stubClaude({
      pluginList: [projectPlugin("local", sb.project, OLD_VERSION)],
      pluginListAfterUpdate: [projectPlugin("local", sb.project, NEW_VERSION)],
    });
    const { results } = await run();

    const updates = claudeMutations().filter((c) => c.argv[1] === "update");
    expect(updates.map((c) => c.argv.join(" "))).toEqual([`plugin update ${PLUGIN_ID} --scope local`]);
    expect(updates[0]?.cwd).toBe(sb.project);
    expect(find(results, "Update plugin").detail).toContain(`updated ${OLD_VERSION} -> ${NEW_VERSION} (local)`);
  });

  it("runs a project-scope update from the entry's own projectPath, not another project's", async () => {
    const sub = join(sb.project, "packages", "app");
    mkdirSync(sub, { recursive: true });
    stubClaude({
      // The other project's entry is first: a --scope project update from a folder with no
      // entry of its own changes that one (the hazard the cwd rule guards against).
      pluginList: [projectPlugin("project", OTHER_PROJECT, OLD_VERSION), projectPlugin("project", sub, OLD_VERSION)],
      pluginUpdateByCwd: NEW_VERSION,
    });
    const { results } = await run({ cwd: sub });

    const updates = claudeMutations().filter((c) => c.argv[1] === "update");
    expect(updates.map((c) => c.argv.join(" "))).toEqual([`plugin update ${PLUGIN_ID} --scope project`]);
    expect(updates[0]?.cwd).toBe(sub);
    const step = find(results, "Update plugin");
    expect(step.status).toBe("configured");
    expect(step.detail).toContain(`updated ${OLD_VERSION} -> ${NEW_VERSION} (project)`);
    expect(step.detail).not.toContain("also changed");
  });

  it("matches a project entry through the git top level, and a linked worktree through its main checkout", async () => {
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    };
    git(sb.project, "init", "-q");
    git(sb.project, "commit", "-q", "--allow-empty", "-m", "x");
    const worktree = join(sb.root, "wt");
    git(sb.project, "worktree", "add", "-q", worktree);
    const sub = join(sb.project, "src");
    mkdirSync(sub, { recursive: true });

    stubClaude({ pluginList: [projectPlugin("project", sb.project, OLD_VERSION)], pluginUpdateByCwd: NEW_VERSION });
    // From a sub folder of the checkout: the entry is keyed by the top level.
    let steps = await plan({ cwd: sub });
    expect(steps.map((s) => s.label)).toContain(`Update plugin ${PLUGIN_ID} (project)`);
    // From the linked worktree: Claude Code keys it by the main checkout.
    steps = await plan({ root: worktree, cwd: worktree });
    expect(steps.map((s) => s.label)).toContain(`Update plugin ${PLUGIN_ID} (project)`);
    // From a different folder with no git: the same entry is another project's.
    const elsewhere = join(sb.root, "elsewhere");
    mkdirSync(elsewhere);
    steps = await plan({ root: elsewhere, cwd: elsewhere });
    expect(steps.map((s) => s.label)).not.toContain(`Update plugin ${PLUGIN_ID} (project)`);
    expect(claudeMutations()).toEqual([]);
  });

  it("fails, and names the entry it hit, when claude plugin update changed another project's entry instead of this one", async () => {
    stubClaude({
      pluginList: [projectPlugin("project", OTHER_PROJECT, OLD_VERSION), projectPlugin("project", sb.project, OLD_VERSION)],
      pluginListAfterUpdate: [projectPlugin("project", OTHER_PROJECT, NEW_VERSION), projectPlugin("project", sb.project, OLD_VERSION)],
    });
    const { results } = await run();

    const step = find(results, "Update plugin");
    expect(step.status).toBe("failed");
    expect(step.detail).toContain("claude plugin update changed another project install instead of this project's");
    expect(step.detail).toContain(`warning: the update also changed ${PLUGIN_ID} (project) for ${OTHER_PROJECT}: ${OLD_VERSION} -> ${NEW_VERSION}`);
    expect(step.detail).not.toContain("/reload-plugins");
  });

  it("reports this project's entry as updated and warns about another project's entry the same update also moved", async () => {
    stubClaude({
      pluginList: [projectPlugin("project", OTHER_PROJECT, OLD_VERSION), projectPlugin("project", sb.project, OLD_VERSION)],
      pluginListAfterUpdate: [projectPlugin("project", OTHER_PROJECT, NEW_VERSION), projectPlugin("project", sb.project, NEW_VERSION)],
    });
    const { results } = await run();

    expect(claudeMutations().filter((c) => c.argv[1] === "update").map((c) => c.argv.join(" "))).toEqual([
      `plugin update ${PLUGIN_ID} --scope project`,
    ]);
    const step = find(results, "Update plugin");
    expect(step.status).toBe("configured");
    expect(step.detail).toContain(`updated ${OLD_VERSION} -> ${NEW_VERSION} (project)`);
    expect(step.detail).toContain(`warning: the update also changed ${PLUGIN_ID} (project) for ${OTHER_PROJECT}`);
    expect(step.detail).not.toContain("instead of this project's");
  });

  it("lists another project's entry as not touched and never passes it to plugin update", async () => {
    stubClaude({
      pluginList: [userPlugin(OLD_VERSION), projectPlugin("project", OTHER_PROJECT, OLD_VERSION)],
      pluginListAfterUpdate: [userPlugin(NEW_VERSION), projectPlugin("project", OTHER_PROJECT, OLD_VERSION)],
    });
    const { results } = await run();

    expect(find(results, "other projects").detail).toBe(`1 other project install not touched: ${OTHER_PROJECT}`);
    expect(claudeMutations().filter((c) => c.argv[1] === "update").map((c) => c.argv.join(" "))).toEqual([
      `plugin update ${PLUGIN_ID} --scope user`,
    ]);
    expect(calls("claude").some((c) => c.argv.includes(OTHER_PROJECT))).toBe(false);
  });

  it("makes no plugin call at all when the only entry belongs to another project", async () => {
    stubClaude({ pluginList: [projectPlugin("project", OTHER_PROJECT, OLD_VERSION)] });
    const { results } = await run();

    expect(find(results, "other projects").detail).toContain(`1 other project install not touched: ${OTHER_PROJECT}`);
    expect(claudeMutations()).toEqual([]);
  });

  it("summarises more than three other-project installs as the first three plus a count", async () => {
    stubClaude({ pluginList: ["a", "b", "c", "d", "e"].map((n) => projectPlugin("project", `/x/${n}`, OLD_VERSION)) });
    const { results } = await run();
    expect(find(results, "other projects").detail).toBe("5 other project installs not touched: /x/a, /x/b, /x/c, +2 more");
  });

  it("reports a synced entry without touching it", async () => {
    stubClaude({ pluginList: [{ id: PLUGIN_ID, version: OLD_VERSION, scope: "synced", enabled: true }] });
    const { results } = await run();

    const step = find(results, "(synced)");
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain(`at ${OLD_VERSION}`);
    expect(step.detail).toContain("so not touched");
    expect(claudeMutations()).toEqual([]);
  });

  it("warns, without changing anything, when the plugin is disabled for this project", async () => {
    stubClaude({ pluginList: [userPlugin(NEW_VERSION, { enabled: false })] });
    const { results } = await run();

    const step = find(results, "Plugin enabled state");
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain("jubarteai-mcp is disabled for this project");
    expect(step.detail).toContain("enable it with /plugin inside Claude Code");
    expect(claudeMutations()).toEqual([]);
  });

  it("without claude on PATH reads installed_plugins.json (v2), advises, and runs neither claude nor npx", async () => {
    stubNpx();
    mkdirSync(join(sb.home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/x", version: OLD_VERSION }] } }),
    );
    const { results } = await run();

    const step = find(results, "Plugin check");
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain("jubarteai-mcp is installed, but claude isn't on PATH, so it wasn't checked or updated");
    expect(step.detail).toContain("run /plugin marketplace update jubarteai inside Claude Code to update it");
    expect(calls("claude")).toEqual([]);
    expect(calls("npx")).toEqual([]);
  });

  it("falls back to the plugins file, with the advisory, when claude plugin list fails (an older Claude Code)", async () => {
    stubClaude({ listExit: 1 });
    mkdirSync(join(sb.home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(sb.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", version: OLD_VERSION }] } }),
    );
    const { results } = await run();
    expect(find(results, "Plugin check").detail).toContain("couldn't list plugins with claude");
    expect(claudeMutations()).toEqual([]);
  });

  it("warns that Claude Code 2.1.270 updates the wrong scope when a plugin is installed", async () => {
    stubClaude({ version: "2.1.270", pluginList: [userPlugin(NEW_VERSION)] });
    const { results } = await run();
    const step = find(results, "Claude Code version");
    expect(step.detail).toContain("2.1.270 updates the wrong scope when you run claude plugin update by hand");
    expect(step.detail).toContain("update Claude Code, or let this command do the plugin update");
  });

  it("does not print the wrong-scope warning on Claude Code 2.1.281 or newer", async () => {
    stubClaude({ version: "2.1.281", pluginList: [userPlugin(NEW_VERSION)] });
    const { results } = await run();
    expect(results.map((r) => r.detail ?? "").join("\n")).not.toContain("wrong scope");
  });

  it("fails the step, and runs no plugin update, when the marketplace refresh fails", async () => {
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], marketplaceExit: 1 });
    const { results } = await run();
    expect(find(results, "Update plugin")).toMatchObject({ status: "failed", detail: "claude plugin marketplace update error" });
    expect(claudeMutations().map((c) => c.argv.join(" "))).toEqual(["plugin marketplace update jubarteai"]);
  });

  it("reports a failed claude plugin update", async () => {
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], updateExit: 1 });
    const { results } = await run();
    expect(find(results, "Update plugin")).toMatchObject({ status: "failed", detail: "claude plugin update error (user)" });
  });

  it("says the marketplace snapshot lags when an update leaves the version below the latest", async () => {
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], pluginListAfterUpdate: [userPlugin(OLD_VERSION)] });
    const { results } = await run();
    const step = find(results, "Update plugin");
    expect(step.status).toBe("already configured");
    expect(step.detail).toContain(`GitHub lists ${NEW_VERSION}, but the marketplace snapshot still has ${OLD_VERSION}`);
  });
});

describe.skipIf(!posix)("skill: copies (npx, hand, shared, link)", () => {
  it("re-adds a stale npx project copy from the project root, without -g, and refreshes it", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    const { steps, results } = await run();

    expect(steps.map((s) => s.label)).toContain("Update skill (project, npx copy)");
    const calls_ = calls("npx");
    expect(calls_).toHaveLength(1);
    expect(calls_[0]?.argv).toEqual(addArgv("-a", "claude-code"));
    expect(calls_[0]?.argv).not.toContain("-g");
    expect(calls_[0]?.cwd).toBe(sb.project);
    expect(skillTreeSha(dir)).toBe(sb.latest.tree);
    expect(find(results, "Update skill")).toMatchObject({ status: "configured" });
    expect(find(results, "Update skill").detail).toContain(`updated .claude/skills/jubarteai to ${NEW_VERSION}`);
    expect(find(results, "Update skill").detail).toContain("Restart your IDE(s) to pick up the updated skill.");
  });

  it("re-adds a stale npx global copy with -g, from HOME, and never writes a project lock", async () => {
    const dir = copyAt(homeCopy(".claude/skills"), STALE_FILES);
    mkdirSync(join(sb.home, ".agents"), { recursive: true });
    writeFileSync(join(sb.home, ".agents", ".skill-lock.json"), LOCK);
    stubNpx({ copyTo: { global: [dir] }, writesLock: true });
    const { results } = await run();

    const recorded = calls("npx");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.argv).toEqual(addArgv("-g", "-a", "claude-code"));
    expect(recorded[0]?.cwd).toBe(sb.home);
    expect(skillTreeSha(dir)).toBe(sb.latest.tree);
    expect(find(results, "Update skill").status).toBe("configured");
    expect(existsSync(join(sb.project, "skills-lock.json"))).toBe(false);
  });

  it("re-adds a stale shared .agents/skills copy in one call with -a universal", async () => {
    const dir = copyAt(projectCopy(".agents/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    await run();

    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-a", "universal")]);
    expect(skillTreeSha(dir)).toBe(sb.latest.tree);
  });

  it("dedupes .claude/skills/jubarteai symlinked into .agents/skills: one call with the owner agent, never -a claude-code alone", async () => {
    const dir = copyAt(projectCopy(".agents/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    mkdirSync(join(sb.project, ".claude", "skills"), { recursive: true });
    symlinkSync(dir, projectCopy(".claude/skills"));
    stubNpx({ copyTo: { project: [dir] } });
    const { steps } = await run();

    const recorded = calls("npx");
    expect(recorded.map((c) => c.argv)).toEqual([addArgv("-a", "universal")]);
    expect(recorded.some((c) => c.argv.includes("claude-code"))).toBe(false);
    // The link is its own copy only when nothing real sits behind it: here it is the same copy.
    expect(steps.map((s) => s.label).filter((l) => l.startsWith("Skill link"))).toEqual([]);
  });

  it("reports a symlinked copy that points outside the known folders and never re-adds it", async () => {
    const elsewhere = copyAt(join(sb.root, "vendor", "jubarteai"), STALE_FILES);
    mkdirSync(join(sb.project, ".claude", "skills"), { recursive: true });
    symlinkSync(elsewhere, projectCopy(".claude/skills"));
    stubNpx();
    const { results } = await run();

    const step = find(results, "Skill link (project)");
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain(".claude/skills/jubarteai links to ");
    expect(step.detail).toContain("a re-install here would replace the link");
    expect(calls("npx")).toEqual([]);
  });

  it("plans an overwrite for a hand copy (local edits are lost), names the skills-lock.json it creates, and still adds it", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), HAND_FILES);
    stubNpx({ copyTo: { project: [dir] }, writesLock: true });
    const { steps, results } = await run();

    const label = steps.map((s) => s.label).find((l) => l.startsWith("Overwrite skill hand copy"));
    expect(label).toBe("Overwrite skill hand copy (project; local edits are lost; adds skills-lock.json to the project root)");
    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-a", "claude-code")]);
    expect(skillTreeSha(dir)).toBe(sb.latest.tree);
    expect(existsSync(join(sb.project, "skills-lock.json"))).toBe(true);
    const detail = find(results, "Overwrite skill hand copy").detail ?? "";
    expect(detail).toContain(`updated .claude/skills/jubarteai to ${NEW_VERSION}`);
    expect(detail).toContain("The skills CLI created skills-lock.json in the project root");
  });

  it("with two project hand copies, names the skills-lock.json only on the first row and notes it once", async () => {
    const a = copyAt(projectCopy(".claude/skills"), HAND_FILES);
    const b = copyAt(projectCopy(".agents/skills"), HAND_FILES);
    stubNpx({ copyTo: { project: [a, b] }, writesLock: true });
    const { steps, results } = await run();

    const labels = steps.map((s) => s.label).filter((l) => l.startsWith("Overwrite skill hand copy"));
    expect(labels).toHaveLength(2);
    expect(labels.filter((l) => l.includes("adds skills-lock.json"))).toHaveLength(1);
    expect(labels[0]).toContain("adds skills-lock.json to the project root");
    expect(labels[1]).toBe("Overwrite skill hand copy (project; local edits are lost)");
    expect(calls("npx")).toHaveLength(2);
    expect(results.filter((r) => (r.detail ?? "").includes("The skills CLI created skills-lock.json"))).toHaveLength(1);
  });

  it("does not mention skills-lock.json for a hand copy when the project already has one", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), HAND_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }));
    stubNpx({ copyTo: { project: [dir] } });
    const { steps, results } = await run();

    expect(steps.map((s) => s.label).join("\n")).not.toContain("skills-lock.json");
    expect(results.map((r) => r.detail ?? "").join("\n")).not.toContain("skills-lock.json");
    expect(steps.map((s) => s.label)).toContain("Overwrite skill hand copy (project; local edits are lost)");
  });

  it("makes no npx call for a copy whose tree already matches the latest, and says so", async () => {
    copyAt(projectCopy(".claude/skills"), LATEST_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx();
    const { results } = await run();

    expect(calls("npx")).toEqual([]);
    const step = find(results, "Skill (project)");
    expect(step.status).toBe("already configured");
    expect(step.detail).toBe(`already current (${NEW_VERSION}), .claude/skills/jubarteai`);
  });

  it("re-adds every copy and reports 're-installed' when the latest skill is unknown (GitHub unreachable)", async () => {
    // Even a copy that happens to match the latest cannot be called current.
    const dir = copyAt(projectCopy(".claude/skills"), LATEST_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    const { results } = await run({ latest: null });

    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-a", "claude-code")]);
    const step = find(results, "Update skill");
    expect(step.status).toBe("configured");
    expect(step.detail).toContain("re-installed .claude/skills/jubarteai");
    expect(results.map((r) => r.status)).not.toContain("already configured");
  });

  it("fails a copy whose folder still differs from the latest after the add", async () => {
    copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [] } });
    const { results } = await run();
    expect(find(results, "Update skill")).toMatchObject({
      status: "failed",
      detail: ".claude/skills/jubarteai still differs from the latest skill",
    });
  });

  it("warns about a duplicate load, naming both removal options, when the plugin and a claude-code copy coexist", async () => {
    stubNpx();
    stubClaude({ pluginList: [userPlugin(NEW_VERSION)] });
    copyAt(projectCopy(".claude/skills"), LATEST_FILES);
    copyAt(homeCopy(".claude/skills"), LATEST_FILES);
    const { results } = await run();

    const project = find(results, "Skill duplicate load (project)");
    const global = find(results, "Skill duplicate load (global)");
    expect(project.status).toBe("skipped");
    expect(project.detail).toContain(`the jubarteai skill may load twice: plugin ${PLUGIN_ID} and the copy at .claude/skills/jubarteai`);
    expect(project.detail).toContain(`claude plugin uninstall ${PLUGIN_ID} --scope user`);
    expect(project.detail).toContain("npx skills remove jubarteai -a claude-code");
    expect(global.detail).toContain("npx skills remove jubarteai -g -a claude-code");
    // Report-only: nothing was removed or reinstalled.
    expect(calls("npx")).toEqual([]);
    expect(existsSync(join(projectCopy(".claude/skills"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(homeCopy(".claude/skills"), "SKILL.md"))).toBe(true);
  });

  it("marks a failed npx add as failed and still runs the next step", async () => {
    copyAt(projectCopy(".claude/skills"), STALE_FILES);
    copyAt(projectCopy(".agents/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ exitCode: 1 });
    const { results } = await run();

    expect(calls("npx")).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(results.map((r) => r.detail)).toEqual(["npx skills add error", "npx skills add error"]);
  });

  it("makes no project-scope lookups when run from ~ (root null): only global copies, plugin user scope", async () => {
    copyAt(projectCopy(".claude/skills"), STALE_FILES);
    const dir = copyAt(homeCopy(".claude/skills"), STALE_FILES);
    mkdirSync(join(sb.home, ".agents"), { recursive: true });
    writeFileSync(join(sb.home, ".agents", ".skill-lock.json"), LOCK);
    stubNpx({ copyTo: { global: [dir] } });
    stubClaude({ pluginList: [userPlugin(NEW_VERSION), projectPlugin("local", sb.home, OLD_VERSION)] });
    const { steps } = await run({ root: null, cwd: sb.home });

    expect(steps.map((s) => s.label).filter((l) => l.includes("(project"))).toEqual([]);
    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-g", "-a", "claude-code")]);
    expect(calls("npx")[0]?.cwd).toBe(sb.home);
    expect(claudeMutations()).toEqual([]);
  });
});

describe.skipIf(!posix)("skill: Node below the floor", () => {
  it("skips a stale copy on Node 22.13.0: no npx, the copy untouched, the manual command in the detail", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    const before = readFileSync(join(dir, "SKILL.md"), "utf8");
    const { results } = await run({ nodeVersion: "22.13.0" });

    const step = find(results, "Update skill");
    expect(step.status).toBe("skipped");
    expect(step.detail).toMatch(/^Node v22\.13\.0 found; the skills CLI needs >= 22\.23\.4\. Then run: /);
    expect(step.detail).toContain(`cd ${sb.project} && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} -a claude-code -y`);
    expect(calls("npx")).toEqual([]);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(before);
  });

  it("a stale global copy on old Node gets `cd ~ && ... -g -a claude-code -y`", async () => {
    copyAt(homeCopy(".claude/skills"), STALE_FILES);
    mkdirSync(join(sb.home, ".agents"), { recursive: true });
    writeFileSync(join(sb.home, ".agents", ".skill-lock.json"), LOCK);
    stubNpx();
    const { results } = await run({ nodeVersion: "22.13.0" });
    expect(find(results, "Update skill").detail).toContain(
      `Then run: cd ~ && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} -g -a claude-code -y`,
    );
    expect(calls("npx")).toEqual([]);
  });

  it("the manual command for a project under HOME is `cd ~/<path> && ...`", async () => {
    const project = join(sb.home, "work", "demo");
    mkdirSync(project, { recursive: true });
    copyAt(join(project, ".claude/skills/jubarteai"), STALE_FILES);
    writeFileSync(join(project, "skills-lock.json"), LOCK);
    stubNpx();
    const { results } = await run({ root: project, cwd: project, nodeVersion: "22.13.0" });
    expect(find(results, "Update skill").detail).toContain(
      `Then run: cd ~/work/demo && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} -a claude-code -y`,
    );
  });

  it("quotes a project root with a space in the manual command", async () => {
    const project = join(sb.root, "my project");
    mkdirSync(project);
    copyAt(join(project, ".claude/skills/jubarteai"), STALE_FILES);
    writeFileSync(join(project, "skills-lock.json"), LOCK);
    stubNpx();
    const { results } = await run({ root: project, cwd: project, nodeVersion: "22.13.0" });
    expect(find(results, "Update skill").detail).toContain(
      `Then run: cd '${project}' && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} -a claude-code -y`,
    );
  });

  it("accepts exactly the floor and refuses the version below it", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    expect((await run({ nodeVersion: "22.23.3" })).results[0]?.status).toBe("skipped");
    expect((await run({ nodeVersion: "22.23.4" })).results[0]?.status).toBe("configured");
    expect(calls("npx")).toHaveLength(1);
  });
});

describe.skipIf(!posix)("skill: planning changes nothing", () => {
  it("planning with a stale copy and a stale plugin runs no npx call, no claude mutation, and writes no file (the --check behaviour)", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], pluginListAfterUpdate: [userPlugin(NEW_VERSION)] });
    const before = skillTreeSha(dir);
    const steps = await plan();

    expect(steps.map((s) => s.label)).toEqual(
      expect.arrayContaining([`Update plugin ${PLUGIN_ID} (user)`, "Update skill (project, npx copy)"]),
    );
    expect(steps.every((s) => !s.sensitive)).toBe(true);
    expect(calls("npx")).toEqual([]);
    expect(claudeMutations()).toEqual([]);
    expect(skillTreeSha(dir)).toBe(before);
    expect(existsSync(join(sb.bin, "claude.state"))).toBe(false);
  });

  it("marks every finding kind info and every change kind change (unset), and running the findings changes nothing", async () => {
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    stubClaude({ pluginList: [userPlugin(OLD_VERSION)], pluginListAfterUpdate: [userPlugin(NEW_VERSION)] });
    const before = skillTreeSha(dir);
    const steps = await plan();

    const changes = steps.filter((s) => s.kind !== "info");
    const findings = steps.filter((s) => s.kind === "info");
    expect(changes.map((s) => s.label).sort()).toEqual([`Update plugin ${PLUGIN_ID} (user)`, "Update skill (project, npx copy)"].sort());
    expect(changes.every((s) => s.kind === undefined)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((s) => s.label)).toContain("Plugin auto-update");
    for (const finding of findings) await finding.apply();
    expect(calls("npx")).toEqual([]);
    expect(claudeMutations()).toEqual([]);
    expect(skillTreeSha(dir)).toBe(before);
  });

  it("with nothing installed the update plan is empty and nothing runs", async () => {
    stubNpx();
    expect(await plan()).toEqual([]);
    expect(calls("npx")).toEqual([]);
  });
});

describe.skipIf(!posix)("skill: init", () => {
  it("installs with one npx call for every harness that has no skill, from the project root", async () => {
    stubNpx();
    const { steps, results } = await run({ mode: "init", agents: ["claude-code", "cursor", "windsurf"] });

    expect(steps).toHaveLength(1);
    // The plan lists every folder add writes (the shared dir once) and the project lock.
    expect(steps[0]?.files).toEqual([
      join(sb.project, ".claude/skills/jubarteai"),
      join(sb.project, ".agents/skills/jubarteai"),
      join(sb.project, ".windsurf/skills/jubarteai"),
      join(sb.project, "skills-lock.json"),
    ]);
    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-a", "claude-code", "-a", "cursor", "-a", "windsurf")]);
    expect(calls("npx")[0]?.cwd).toBe(sb.project);
    expect(results[0]).toMatchObject({ status: "configured", detail: "installed for claude-code, cursor, windsurf" });
  });

  it("from ~ installs at global scope (-g) from HOME", async () => {
    stubNpx();
    const { steps } = await run({ mode: "init", root: null, cwd: sb.home, agents: ["claude-code"] });
    expect(steps[0]?.files).toEqual([join(sb.home, ".claude/skills/jubarteai")]);
    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-g", "-a", "claude-code")]);
    expect(calls("npx")[0]?.cwd).toBe(sb.home);
  });

  it("is idempotent: a harness that already has a copy, or the plugin for Claude Code, is not added again", async () => {
    stubNpx();
    copyAt(projectCopy(".agents/skills"), LATEST_FILES);
    stubClaude({ pluginList: [userPlugin(NEW_VERSION)] });
    const { steps, results } = await run({ mode: "init", agents: ["claude-code", "cursor", "codex"] });

    expect(calls("npx")).toEqual([]);
    expect(results[0]).toMatchObject({ status: "already configured", detail: "skill already installed" });
    expect(steps[0]?.kind).toBe("info");
  });

  it("adds only the harnesses that are missing", async () => {
    stubNpx();
    copyAt(projectCopy(".agents/skills"), LATEST_FILES);
    await run({ mode: "init", agents: ["cursor", "claude-code"] });
    expect(calls("npx").map((c) => c.argv)).toEqual([addArgv("-a", "claude-code")]);
  });

  it("skips with the reason on Node below the floor, with the command to run, and never calls npx", async () => {
    stubNpx();
    const { results } = await run({ mode: "init", agents: ["cursor"], nodeVersion: "20.12.0" });
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.detail).toBe(
      `Node v20.12.0 found; the skills CLI needs >= 22.23.4. Then run: cd ${sb.project} && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} -a cursor -y`,
    );
    expect(calls("npx")).toEqual([]);
  });

  it("skips with 'no harness detected' when the caller names no agent, and drops an id that is not a plain slug", async () => {
    stubNpx();
    expect((await run({ mode: "init", agents: [] })).results[0]).toMatchObject({ status: "skipped", detail: "no harness detected" });
    expect((await run({ mode: "init", agents: ["--global", "a b", "$(x)"] })).results[0]).toMatchObject({ status: "skipped", detail: "no harness detected" });
    expect(calls("npx")).toEqual([]);
  });

  it("fails with a fixed detail when npx fails, and when npx is missing", async () => {
    stubNpx({ exitCode: 1 });
    expect((await run({ mode: "init", agents: ["cursor"] })).results[0]).toMatchObject({ status: "failed", detail: "npx skills add error" });
    rmSync(join(sb.bin, "npx"));
    expect((await run({ mode: "init", agents: ["cursor"] })).results[0]).toMatchObject({ status: "failed", detail: "npx not found" });
  });

  it("notes the skills-lock.json the CLI created in the project root", async () => {
    stubNpx({ writesLock: true });
    const { results } = await run({ mode: "init", agents: ["cursor"] });
    expect(results[0]?.detail).toContain("The skills CLI created skills-lock.json in the project root");
  });
});

describe.skipIf(!posix)("skill: npm environment of the skills add child", () => {
  const MIRROR = "https://npm.mirror.example.test/repository/npm/";
  const npxEnv = (): Array<Call["env"]> => calls("npx").map((c) => c.env);

  /** init, and an update of a stale copy: both start npx in the project folder. */
  async function runInitAndUpdate(): Promise<void> {
    stubNpx();
    await run({ mode: "init", agents: ["cursor"] });
    const dir = copyAt(projectCopy(".claude/skills"), STALE_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    stubNpx({ copyTo: { project: [dir] } });
    await run();
  }

  it("gives the child the user's registry from ~/.npmrc, never the repo's, with node options emptied", async () => {
    writeFileSync(join(sb.home, ".npmrc"), `registry=${MIRROR}\n`);
    writeFileSync(join(sb.project, ".npmrc"), "registry=https://evil.example.test/\nnode-options=--require=./x.js\n");
    stubNpm();
    await runInitAndUpdate();

    expect(npxEnv()).toEqual([
      { registry: MIRROR, nodeOptionsNpm: "", nodeOptions: "" },
      { registry: MIRROR, nodeOptionsNpm: "", nodeOptions: "" },
    ]);
    // The lookup ran from the home folder (no project .npmrc) with the node options emptied.
    const lookups = calls("npm");
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) {
      expect(l.argv).toEqual(["config", "get", "registry"]);
      expect(l.cwd).toBe(sb.home);
      expect(l.env.nodeOptions).toBe("");
      expect(l.env.nodeOptionsNpm).toBe("");
    }
  });

  it("falls back to the public registry when npm is missing or answers with something that is not a plain http(s) URL", async () => {
    const pinned = { registry: "https://registry.npmjs.org/", nodeOptionsNpm: "", nodeOptions: "" };
    process.env.NODE_OPTIONS = "--require=./x.js";
    process.env.npm_config_node_options = "--require=./x.js";
    try {
      writeFileSync(join(sb.project, ".npmrc"), "registry=https://evil.example.test/\n");
      // npm not on PATH
      await runInitAndUpdate();
      expect(npxEnv()).toEqual([pinned, pinned]);
      for (const answer of ["file:///etc/passwd", "https://user:pw@mirror.example.test/", "not a url", ""]) {
        rmSync(join(sb.bin, "npx.log"));
        stubNpm({ answer });
        stubNpx();
        await run({ mode: "init", agents: ["cursor"] });
        expect(npxEnv()).toEqual([pinned]);
      }
    } finally {
      delete process.env.NODE_OPTIONS;
      delete process.env.npm_config_node_options;
    }
  });
});

describe.skipIf(!posix)("skill: detectSkillChannels", () => {
  it("finds the plugin at user and project scope, npx copies by their lock, and hand copies", async () => {
    stubClaude({ pluginList: [userPlugin(NEW_VERSION), projectPlugin("project", sb.project, OLD_VERSION), projectPlugin("project", OTHER_PROJECT, OLD_VERSION)] });
    const npxProject = copyAt(projectCopy(".claude/skills"), LATEST_FILES);
    writeFileSync(join(sb.project, "skills-lock.json"), LOCK);
    const hand = copyAt(projectCopy(".agents/skills"), HAND_FILES);
    const npxGlobal = copyAt(homeCopy(".claude/skills"), LATEST_FILES);
    mkdirSync(join(sb.home, ".agents"), { recursive: true });
    writeFileSync(join(sb.home, ".agents", ".skill-lock.json"), LOCK);

    const channels = await detectSkillChannels({ root: sb.project, cwd: sb.project });
    expect(channels.map((c) => [c.kind, c.version])).toEqual([
      ["plugin-user", NEW_VERSION],
      ["plugin-project", OLD_VERSION],
      ["skills-project", null],
      ["skills-project", null],
      ["skills-global", null],
    ]);
    expect(channels.filter((c) => c.kind !== "plugin-user" && c.kind !== "plugin-project").map((c) => c.path)).toEqual([npxProject, hand, npxGlobal]);

    // Without the project's lock the same two folders are hand copies.
    rmSync(join(sb.project, "skills-lock.json"));
    const again = await detectSkillChannels({ root: sb.project, cwd: sb.project });
    expect(again.filter((c) => c.kind === "hand-copy").map((c) => c.path)).toEqual([npxProject, hand]);
  });

  it("returns nothing for a machine with no skill, and only global channels from ~", async () => {
    expect(await detectSkillChannels({ root: sb.project, cwd: sb.project })).toEqual([]);
    copyAt(projectCopy(".claude/skills"), LATEST_FILES);
    expect(await detectSkillChannels({ root: null, cwd: sb.home })).toEqual([]);
  });
});

describe.skipIf(!posix)("skill: tree SHA", () => {
  it("equals git's tree SHA for the same folder (exec bit, nested folders, byte order; .DS_Store and empty folders left out)", () => {
    const dir = join(sb.root, "repo");
    writeTree(join(dir, "skills", "jubarteai"), {
      "SKILL.md": "# skill\n",
      "references/tools.md": "tools\n",
      "references/a b.md": "spaces\n",
      "z.txt": "z\n",
      "a-b": "dash\n",
      "a/inner.md": "inner\n",
    });
    writeFileSync(join(dir, "skills", "jubarteai", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(dir, "skills", "jubarteai", "run.sh"), 0o755);
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const expected = git("rev-parse", "HEAD:skills/jubarteai");

    const folder = join(dir, "skills", "jubarteai");
    expect(skillTreeSha(folder)).toBe(expected);
    writeFileSync(join(folder, ".DS_Store"), "finder litter");
    mkdirSync(join(folder, "empty"));
    expect(skillTreeSha(folder)).toBe(expected);
    writeFileSync(join(folder, "SKILL.md"), "# changed\n");
    expect(skillTreeSha(folder)).not.toBe(expected);
    expect(skillTreeSha(join(dir, "does-not-exist"))).toBeNull();
  });
});
