// Skill install and update channels, ported from the app's update.sh
// (src/lib/update-script/skill.ts) and install.sh's skill step. The decisions
// are the ones in docs/plans/update-sh-grill.md (D8-D11, D18-D22, D26):
//
//   * Channels: the Claude Code plugin at user scope and at this project's
//     scope, `npx skills` copies (the scope's lock file lists them), hand
//     copies (a SKILL.md folder with no lock entry), symlinked copies
//     (report-only) and duplicates (the plugin and a .claude/skills copy:
//     report-only).
//   * Update = re-run `npx -y skills@<pin> add <repo> -a <owner agent> -y` at the
//     scope where each copy lives (D8), overwrite hand copies (D10), skip a copy
//     whose folder already equals the latest tree (D11), update the plugin with
//     `claude plugin marketplace update` then `claude plugin update <id> --scope
//     <scope>` run from the entry's own project folder (D18).
//   * Never `claude mcp get/list` (D21). The only claude calls are
//     `claude --version`, `claude plugin list --json`, `claude plugin marketplace
//     update <marketplace>` and `claude plugin update <id> --scope <scope>`.
//   * Run from `~` or `/` (root === null): global scope only (D26).
//   * Every child process goes through run.ts (argument arrays, no shell,
//     childEnv(): the key is never in a child's environment or argv).
//
// Nothing here reads or prints a key. Every detail string in a StepResult is a
// fixed sentence plus a path, a version, a scope or an id.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homeDir } from "../paths.js";
import { MACHINE_GROUP, harnessGroup } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { HARNESS_IDS } from "../session/harness-env.js";
import type { HarnessId } from "../session/harness-env.js";
import { SKILL_AGENT_DIRS, SKILL_NAME, SKILL_REPO, SKILLS_CLI_MIN_NODE, SKILLS_CLI_VERSION } from "./constants.js";
import { logTail, runCommand, which } from "./run.js";

export type SkillChannel = {
  kind: "plugin-user" | "plugin-project" | "skills-project" | "skills-global" | "hand-copy";
  /** The copy's folder (skills and hand copies), or the plugin's install folder / this project's folder (plugins). */
  path: string;
  /** Plugins: the installed version. Skill copies: null (a copy carries no version; compare it with the latest tree). */
  version: string | null;
};

/** What the GitHub lookup of the newest skill found. A field that failed or did not validate is null. */
export type LatestSkill = { version: string | null; tree: string | null };

type DetectOptions = {
  /** The project root; null when run from `~` or `/` (global scope only). */
  root: string | null;
  /** Where the command was started (default: process.cwd()). Claude Code keys a project's local plugins by it. */
  cwd?: string;
};

type PlanOptions = DetectOptions & {
  mode: "init" | "update";
  /** `skills -a` ids of the harnesses to install the skill for (init). */
  agents: string[];
  /** The latest skill, when the caller already knows it (tests). undefined: look it up (update only); null: unknown. */
  latest?: LatestSkill | null;
  /** The Node version the skills CLI will run on (default: this process). */
  nodeVersion?: string;
};

const LIST_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 10_000;
const PLUGIN_COMMAND_TIMEOUT_MS = 120_000;
const SKILLS_ADD_TIMEOUT_MS = 180_000;
const LATEST_FETCH_TIMEOUT_MS = 10_000;
/** Claude Code below this updates the wrong plugin scope when `claude plugin update` is run by hand (D22). */
const CLAUDE_PLUGIN_SCOPE_FIXED_IN = "2.1.281";
const PLUGIN_ID_RE = /^jubarteai-mcp@[A-Za-z0-9._-]+$/;
const PLUGIN_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const LATEST_VERSION_RE = /^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]+)?$/;
const TREE_RE = /^[0-9a-f]{40}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_TREE_DEPTH = 16;
const MAX_TREE_ENTRIES = 5000;
const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_CONFIG_TIMEOUT_MS = 15_000;
/** Emptied for every npm/npx child that starts in a place a repo's .npmrc could reach, or that reads npm's config. */
const NODE_OPTIONS_OFF: Readonly<Record<string, string>> = { npm_config_node_options: "", NODE_OPTIONS: "" };
const SHELL_SAFE_RE = /^[A-Za-z0-9_./~+-]+$/;

type Scope = "project" | "global";
type PluginBucket = "user" | "current" | "other" | "report";

type PluginEntry = {
  id: string;
  /** The marketplace: the text after `@` in the id. */
  marketplace: string;
  scope: string;
  version: string;
  projectPath: string;
  installPath: string;
  enabled: boolean | null;
  bucket: PluginBucket;
};

type PluginDiscovery = {
  entries: PluginEntry[];
  /** True when `claude plugin list --json` produced the listing (so the enabled state is real and updates may run). */
  viaCli: boolean;
  hasClaude: boolean;
  disabled: boolean;
};

type SkillCopy = {
  scope: Scope;
  /** The `jubarteai` folder. */
  dir: string;
  shown: string;
  /** The skills CLI agent that writes this folder (what to re-add with). */
  owner: string;
  channel: "npx" | "hand" | "link";
  state: "current" | "stale" | "unknown" | "report";
  /** Where a link really points (the copy's own real path otherwise). */
  target: string;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(path: string, base: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A path as a status line shows it: relative to the project, `~/…` under home, else as is. */
function shownPath(path: string, root: string | null): string {
  if (root !== null && isUnder(path, root)) return relative(root, path);
  const home = homeDir();
  if (isUnder(path, home)) return `~/${relative(home, path).split(sep).join("/")}`;
  return path;
}

function tildePath(path: string): string {
  const home = homeDir();
  if (path === home) return "~";
  return isUnder(path, home) ? `~/${relative(home, path).split(sep).join("/")}` : path;
}

/** A path for a command the user will paste: `~/…` form when plain, else quoted. */
function pasteablePath(path: string): string {
  const tilde = tildePath(path);
  if (SHELL_SAFE_RE.test(tilde)) return tilde;
  if (process.platform === "win32") return `"${path.replaceAll('"', "")}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function parseVersion(version: string): [number, number, number] {
  const m = /([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(version);
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0), Number(m?.[3] ?? 0)];
}

/** True when `version` is below `than` (x.y.z, a leading `v` ignored). */
function versionLt(version: string, than: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(than);
  for (let i = 0; i < 3; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y;
  }
  return false;
}

function clean(value: unknown, max: number): string {
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.slice(0, max);
}

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== "" ? override : join(homeDir(), ".claude");
}

function pluginsFile(): string {
  return join(claudeConfigDir(), "plugins", "installed_plugins.json");
}

/** A finding that changes nothing (kind "info"): its apply() only returns this fixed result. */
function infoStep(id: string, label: string, status: StepResult["status"], detail: string, files: string[] = []): PlanStep {
  return {
    id,
    label,
    kind: "info",
    group: MACHINE_GROUP,
    files,
    sensitive: false,
    apply: async (): Promise<StepResult> => ({ id, label, status, detail }),
  };
}

// ---------------------------------------------------------------------------
// The latest skill (D11): a content check against the skills repo's main branch
// ---------------------------------------------------------------------------

function isOkVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && LATEST_VERSION_RE.test(value);
}

/**
 * The newest skill's tree SHA and the plugin's version, from two unauthenticated
 * GitHub contents-API GETs (10 s each; the API answers within about a minute of a
 * push). A value that fails or does not validate is null, which makes every copy
 * "unknown" so it is re-added, never reported current.
 */
async function fetchLatestSkill(): Promise<LatestSkill> {
  const base = `https://api.github.com/repos/${SKILL_REPO}/contents/`;
  const headers = { "User-Agent": "jubarteai-cli", Accept: "application/vnd.github+json" };
  const get = async (path: string): Promise<unknown> => {
    try {
      const res = await fetch(`${base}${path}?ref=main`, { headers, signal: AbortSignal.timeout(LATEST_FETCH_TIMEOUT_MS) });
      return res.ok ? ((await res.json()) as unknown) : null;
    } catch {
      return null;
    }
  };
  const [dirs, file] = await Promise.all([get("skills"), get(".claude-plugin/plugin.json")]);
  const out: LatestSkill = { version: null, tree: null };
  if (Array.isArray(dirs)) {
    const hit = dirs.find((e: unknown) => isRecord(e) && e.name === SKILL_NAME && e.type === "dir");
    if (isRecord(hit) && typeof hit.sha === "string" && TREE_RE.test(hit.sha)) out.tree = hit.sha;
  }
  if (isRecord(file) && file.encoding === "base64" && typeof file.content === "string") {
    try {
      const manifest: unknown = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      if (isRecord(manifest) && isOkVersion(manifest.version)) out.version = manifest.version;
    } catch {
      // an unreadable manifest leaves the version unknown
    }
  }
  return out;
}

/**
 * Git's tree SHA of a folder, byte for byte what `git rev-parse HEAD:skills/jubarteai`
 * and the GitHub contents API give for the same files: blob = sha1 of "blob <len>" NUL
 * bytes; modes 100644 / 100755 (owner exec bit) / 40000; entries ordered bytewise with
 * a folder compared as name + "/"; symlinks followed; empty folders and .DS_Store left
 * out (git cannot store the first and no repository holds the second). Null when the
 * folder cannot be read or is implausibly large.
 */
export function skillTreeSha(dir: string): string | null {
  const sha = (data: Buffer): Buffer => createHash("sha1").update(data).digest();
  let visited = 0;
  const blob = (path: string): Buffer => {
    const bytes = readFileSync(path);
    return sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  };
  const tree = (path: string, depth: number): Buffer | null => {
    visited += 1;
    if (depth > MAX_TREE_DEPTH || visited > MAX_TREE_ENTRIES) throw new Error("folder too large");
    const entries: Array<{ name: string; key: string; mode: string; hash: Buffer }> = [];
    for (const name of readdirSync(path)) {
      if (name === ".DS_Store") continue;
      const child = join(path, name);
      const st = statSync(child);
      if (st.isDirectory()) {
        const hash = tree(child, depth + 1);
        if (hash !== null) entries.push({ name, key: `${name}/`, mode: "40000", hash });
      } else if (st.isFile()) {
        entries.push({ name, key: name, mode: (st.mode & 0o100) !== 0 ? "100755" : "100644", hash: blob(child) });
      }
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.hash])));
    return sha(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
  };
  try {
    const hash = tree(dir, 0);
    return hash === null ? null : hash.toString("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code's project keys and the plugin listing
// ---------------------------------------------------------------------------

/**
 * Every key Claude Code may file this project's local-scope plugins under, the one it
 * uses now first. Claude Code 2.x keys a project by its git repository (a linked
 * worktree by its main checkout, a submodule by its own top level) and only outside
 * git by the physical directory; the top level and the directory the command started
 * in (where older versions keyed it) are checked too. A key with a non-ASCII byte is
 * listed in its composed (NFC) form first, then as it is on disk.
 */
async function claudeProjectKeys(root: string | null, startDir: string): Promise<string[]> {
  if (root === null) return [];
  let top = "";
  let key = "";
  let raw = "";
  const res = await runCommand("git", ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
    cwd: startDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (res.code === 0) {
    const lines = res.stdout.split(/\r?\n/);
    top = lines[0] ?? "";
    const gitDir = realPath(resolve(startDir, lines[1] ?? "")) ?? "";
    const commonRaw = resolve(startDir, lines[2] ?? "");
    const common = realPath(commonRaw) ?? "";
    if (gitDir !== "" && common !== "" && gitDir.startsWith(`${common}${sep}worktrees${sep}`)) {
      key = common.replace(/[\\/]\.git$/, "");
      raw = commonRaw.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "");
    }
    if (key === "" && top !== "") key = top;
  }
  const keys: string[] = [];
  for (const candidate of [key, raw, top === "" ? "" : (realPath(top) ?? ""), top, startDir]) {
    if (!isAbsolute(candidate)) continue;
    for (const form of [candidate.normalize("NFC"), candidate]) {
      if (form !== "" && !keys.includes(form)) keys.push(form);
    }
  }
  return keys;
}

/**
 * The jubarteai-mcp installs, from either `claude plugin list --json` (an array) or
 * installed_plugins.json v2 (`plugins["<id>"]` = array). Buckets: user; current (a
 * project/local entry whose projectPath is one of the project keys); other (another
 * project, never touched); report (synced/managed/unknown scope, report-only). Null
 * when the input is not a recognisable listing. Every value is cleaned of control
 * characters and checked against a strict shape, since ids and versions later reach
 * command lines.
 */
function parsePluginEntries(data: unknown, keys: string[]): PluginEntry[] | null {
  const rows: Array<{ id: unknown; raw: Record<string, unknown> }> = [];
  if (Array.isArray(data)) {
    for (const e of data) if (isRecord(e)) rows.push({ id: e.id, raw: e });
  } else if (isRecord(data) && isRecord(data.plugins)) {
    for (const [id, list] of Object.entries(data.plugins)) {
      if (!Array.isArray(list)) continue;
      for (const e of list) if (isRecord(e)) rows.push({ id, raw: e });
    }
  } else {
    return null;
  }
  const entries: PluginEntry[] = [];
  for (const { id, raw } of rows) {
    if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) continue;
    const scope = clean(raw.scope, 20) || "unknown";
    const projectPath = clean(raw.projectPath, 1024);
    const version = typeof raw.version === "string" && PLUGIN_VERSION_RE.test(raw.version) ? raw.version : "unknown";
    let bucket: PluginBucket = "report";
    if (scope === "user") bucket = "user";
    else if (scope === "project" || scope === "local") bucket = projectPath !== "" && keys.includes(projectPath) ? "current" : "other";
    entries.push({
      id,
      marketplace: id.slice(id.indexOf("@") + 1),
      scope,
      version,
      projectPath,
      installPath: clean(raw.installPath, 1024),
      enabled: raw.enabled === true ? true : raw.enabled === false ? false : null,
      bucket,
    });
  }
  return entries;
}

async function discoverPlugins(listCwd: string, keys: string[]): Promise<PluginDiscovery> {
  const hasClaude = which("claude") !== null;
  let entries: PluginEntry[] | null = null;
  let viaCli = false;
  if (hasClaude) {
    const res = await runCommand("claude", ["plugin", "list", "--json"], { cwd: listCwd, timeoutMs: LIST_TIMEOUT_MS });
    if (res.code === 0 && !res.timedOut && res.stdout.trim() !== "") {
      try {
        entries = parsePluginEntries(JSON.parse(res.stdout) as unknown, keys);
        viaCli = entries !== null;
      } catch {
        entries = null;
      }
    }
  }
  if (!viaCli) {
    // No usable claude (or an older Claude Code): the file gives versions and scopes
    // but no enabled state, so these entries are report-only.
    try {
      entries = parsePluginEntries(JSON.parse(readFileSync(pluginsFile(), "utf8")) as unknown, keys);
    } catch {
      entries = null;
    }
  }
  const list = entries ?? [];
  const disabled = viaCli && list.some((e) => (e.bucket === "user" || e.bucket === "current") && e.enabled === false);
  return { entries: list, viaCli, hasClaude, disabled };
}

async function claudeVersion(): Promise<string | null> {
  if (which("claude") === null) return null;
  const res = await runCommand("claude", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (res.code !== 0) return null;
  const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(res.stdout.split(/\r?\n/)[0] ?? "");
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Skill copies
// ---------------------------------------------------------------------------

/**
 * The distinct (scope, dir, owner) rows to look in. Several agents share one
 * physical dir (`.agents/skills`); the skills CLI writes a shared dir through its
 * "universal" agent, so that is the owner when the group has it, else the first
 * agent listed. Re-adding with the owner keeps a real dir real.
 */
function skillDirRows(): Array<{ scope: Scope; dir: string; owner: string }> {
  const rows: Array<{ scope: Scope; dir: string; owner: string }> = [];
  for (const scope of ["project", "global"] as const) {
    const owners = new Map<string, string>();
    for (const [agent, dirs] of Object.entries(SKILL_AGENT_DIRS)) {
      const dir = dirs[scope];
      const current = owners.get(dir);
      if (current === undefined || (agent === "universal" && current !== "universal")) owners.set(dir, agent);
    }
    for (const [dir, owner] of owners) rows.push({ scope, dir, owner });
  }
  return rows;
}

/** True when the skills CLI's lock file lists skills.jubarteai (the copy came from `npx skills add`). */
function lockHasSkill(lockFile: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    return isRecord(parsed) && isRecord(parsed.skills) && isRecord(parsed.skills[SKILL_NAME]);
  } catch {
    return false;
  }
}

/**
 * The installed skill copies (a `jubarteai` folder holding SKILL.md) and each one's
 * state. Real folders are registered before symlinks and copies are deduped by their
 * real path, so `.claude/skills/jubarteai` linking into `.agents/skills` is that copy,
 * not a second one. A link to somewhere outside the known dirs is report-only: a
 * re-add would replace the link itself. Project scope is skipped when root is null.
 */
function discoverSkillCopies(root: string | null, latestTree: string | null): SkillCopy[] {
  const copies: SkillCopy[] = [];
  const seen = new Set<string>();
  const home = homeDir();
  const physicalRoot = root === null ? null : (realPath(root) ?? root);
  const rows = skillDirRows();
  for (const pass of [1, 2]) {
    for (const row of rows) {
      let base: string;
      let lock: string;
      if (row.scope === "project") {
        if (root === null || physicalRoot === null) continue;
        base = join(physicalRoot, row.dir);
        lock = join(root, "skills-lock.json");
      } else {
        base = join(home, row.dir);
        lock = join(home, ".agents", ".skill-lock.json");
      }
      const copy = join(base, SKILL_NAME);
      if (!isFile(join(copy, "SKILL.md"))) continue;
      let isLink: boolean;
      try {
        isLink = lstatSync(copy).isSymbolicLink();
      } catch {
        continue;
      }
      if (isLink ? pass !== 2 : pass !== 1) continue;
      const real = realPath(copy) ?? copy;
      if (seen.has(real)) continue;
      seen.add(real);

      let channel: SkillCopy["channel"] = "hand";
      let state: SkillCopy["state"];
      if (isLink) {
        channel = "link";
        state = "report";
      } else {
        if (lockHasSkill(lock)) channel = "npx";
        const tree = skillTreeSha(copy);
        if (tree === null || latestTree === null) state = "unknown";
        else state = tree === latestTree ? "current" : "stale";
      }
      copies.push({ scope: row.scope, dir: copy, shown: shownPath(copy, physicalRoot), owner: row.owner, channel, state, target: real });
    }
  }
  return copies;
}

/** True when update would re-add the copy: not report-only and not already current. */
function copyPending(copy: SkillCopy): boolean {
  return copy.channel !== "link" && copy.state !== "current";
}

// ---------------------------------------------------------------------------
// detectSkillChannels
// ---------------------------------------------------------------------------

/**
 * Every channel the skill is installed through here: the plugin at user scope and at
 * this project's scope, `npx skills` copies, hand copies (a symlinked copy counts as
 * a hand copy: the CLI does not manage it). Reads files, plus one `claude plugin list
 * --json` when claude is on PATH; never a network call and never a write.
 */
export async function detectSkillChannels(opts: DetectOptions): Promise<SkillChannel[]> {
  const startDir = opts.cwd ?? process.cwd();
  const keys = await claudeProjectKeys(opts.root, startDir);
  const plugins = await discoverPlugins(opts.root === null ? homeDir() : startDir, keys);
  const channels: SkillChannel[] = [];
  for (const e of plugins.entries) {
    if (e.bucket === "user") channels.push({ kind: "plugin-user", path: e.installPath || pluginsFile(), version: e.version });
    else if (e.bucket === "current") channels.push({ kind: "plugin-project", path: e.installPath || e.projectPath, version: e.version });
  }
  for (const copy of discoverSkillCopies(opts.root, null)) {
    let kind: SkillChannel["kind"] = "hand-copy";
    if (copy.channel === "npx") kind = copy.scope === "project" ? "skills-project" : "skills-global";
    channels.push({ kind, path: copy.dir, version: null });
  }
  return channels;
}

// ---------------------------------------------------------------------------
// planSkillSteps
// ---------------------------------------------------------------------------

function nodeMeetsFloor(version: string): boolean {
  return !versionLt(version, SKILLS_CLI_MIN_NODE);
}

function nodeSkipDetail(nodeVersion: string, scope: Scope, root: string | null, tail: string[]): string {
  const where = scope === "global" || root === null ? "cd ~" : `cd ${pasteablePath(root)}`;
  const command = `${where} && npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO} ${tail.join(" ")}`;
  return `Node v${nodeVersion.replace(/^v/, "")} found; the skills CLI needs >= ${SKILLS_CLI_MIN_NODE}. Then run: ${command}`;
}

/**
 * The registry `skills add` fetches from: the user's own (a corporate mirror in ~/.npmrc, an npm_config_registry
 * they exported), read with `npm config get registry` run from the home folder so no project .npmrc applies. Only
 * an http(s) URL without credentials is taken; anything else, or a failed lookup, gives the public registry.
 */
async function userNpmRegistry(): Promise<string> {
  const res = await runCommand("npm", ["config", "get", "registry"], { cwd: homeDir(), env: { ...NODE_OPTIONS_OFF }, timeoutMs: NPM_CONFIG_TIMEOUT_MS });
  if (res.code !== 0 || res.timedOut || res.notFound) return NPM_REGISTRY;
  const value = res.stdout.trim();
  if (value === "" || value.length > 2048) return NPM_REGISTRY;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return NPM_REGISTRY;
    return url.href;
  } catch {
    return NPM_REGISTRY;
  }
}

async function runSkillsAdd(scope: Scope, root: string | null, tail: string[]): Promise<{ ok: boolean; why: string; log?: string[] }> {
  const cwd = scope === "global" || root === null ? homeDir() : root;
  const res = await runCommand("npx", ["-y", `skills@${SKILLS_CLI_VERSION}`, "add", SKILL_REPO, ...tail], {
    cwd,
    // The child starts in the project, where npm reads the repo's own .npmrc (`registry=`, `node-options=`): a cloned
    // repo could redirect the fetch of the pinned skills@<version>. Environment variables outrank a project .npmrc, so
    // the user's registry (resolved without the project) and empty node options are pinned here.
    env: { npm_config_registry: await userNpmRegistry(), ...NODE_OPTIONS_OFF },
    timeoutMs: SKILLS_ADD_TIMEOUT_MS,
  });
  if (res.notFound) return { ok: false, why: "npx not found" };
  if (res.timedOut) return { ok: false, why: "npx skills add timed out", log: logTail(res) };
  if (res.code !== 0) return { ok: false, why: "npx skills add error", log: logTail(res) };
  return { ok: true, why: "" };
}

function withLog(result: StepResult, log: string[]): StepResult {
  return log.length === 0 ? result : { ...result, log };
}

const LOCK_NOTE = "The skills CLI created skills-lock.json in the project root; commit it with the skill, or add it to .gitignore.";

function skillUpdateStep(
  copy: SkillCopy,
  index: number,
  ctx: { root: string | null; latest: LatestSkill | null; nodeVersion: string; nameLock: boolean },
): PlanStep {
  const id = `skill-${copy.scope}-${index}`;
  const tail = copy.scope === "global" ? ["-g", "-a", copy.owner, "-y"] : ["-a", copy.owner, "-y"];
  const lockPath = ctx.root === null ? null : join(ctx.root, "skills-lock.json");
  const label =
    copy.channel === "npx"
      ? `Update skill (${copy.scope}, npx copy)`
      : `Overwrite skill hand copy (${copy.scope}; local edits are lost${ctx.nameLock ? "; adds skills-lock.json to the project root" : ""})`;
  const files = ctx.nameLock && lockPath !== null ? [copy.dir, lockPath] : [copy.dir];
  return {
    id,
    label,
    group: harnessGroup(harnessesForAgent(copy.owner)[0] ?? "claude-code"),
    files,
    sensitive: false,
    apply: async (): Promise<StepResult> => {
      const result = (status: StepResult["status"], detail: string, log?: string[]): StepResult => ({ id, label, status, detail, ...(log === undefined || log.length === 0 ? {} : { log }) });
      if (!nodeMeetsFloor(ctx.nodeVersion)) return result("skipped", nodeSkipDetail(ctx.nodeVersion, copy.scope, ctx.root, tail));
      const hadLock = lockPath !== null && existsSync(lockPath);
      const run = await runSkillsAdd(copy.scope, ctx.root, tail);
      const lockNote = copy.scope === "project" && lockPath !== null && !hadLock && existsSync(lockPath) ? ` ${LOCK_NOTE}` : "";
      if (!run.ok) return result("failed", `${run.why}${lockNote}`, run.log);
      const tree = skillTreeSha(copy.dir);
      const restart = "Restart your IDE(s) to pick up the updated skill.";
      if (ctx.latest === null || ctx.latest.tree === null) return result("configured", `re-installed ${copy.shown}. ${restart}${lockNote}`);
      if (tree !== ctx.latest.tree) return result("failed", `${copy.shown} still differs from the latest skill${lockNote}`);
      const to = ctx.latest.version === null ? "the latest skill" : ctx.latest.version;
      return result("configured", `updated ${copy.shown} to ${to}. ${restart}${lockNote}`);
    },
  };
}

function pluginKey(e: Pick<PluginEntry, "id" | "scope" | "projectPath">): string {
  return `${e.id}\u0000${e.scope}\u0000${e.projectPath}`;
}

/** The plugin rows: update the user entry and this project's entry, report everything else. */
function pluginSteps(
  discovery: PluginDiscovery,
  ctx: { root: string | null; startDir: string; keys: string[]; latestVersion: string | null; ccVersion: string | null },
): PlanStep[] {
  const steps: PlanStep[] = [];
  const entries = discovery.entries;
  const pending = (e: PluginEntry): boolean =>
    discovery.viaCli && (e.bucket === "user" || e.bucket === "current") && !(ctx.latestVersion !== null && e.version === ctx.latestVersion);
  const baseline = new Map(entries.map((e) => [pluginKey(e), e.version]));
  // Fixed now: after an update the targeted entry is no longer "pending", but it is still the target.
  const targets = new Set(entries.filter(pending).map(pluginKey));
  const refreshed = new Map<string, Promise<boolean>>();
  const listCwd = ctx.root === null ? homeDir() : ctx.startDir;

  const refreshMarketplace = (marketplace: string): Promise<boolean> => {
    let done = refreshed.get(marketplace);
    if (done === undefined) {
      done = runCommand("claude", ["plugin", "marketplace", "update", marketplace], {
        cwd: listCwd,
        timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
      }).then((r) => r.code === 0 && !r.timedOut && !r.notFound);
      refreshed.set(marketplace, done);
    }
    return done;
  };

  let otherCount = 0;
  const otherShown: string[] = [];
  const first = entries.find((e) => e.bucket === "user" || e.bucket === "current");
  entries.forEach((e, i) => {
    const sid = `plugin-${i}`;
    switch (e.bucket) {
      case "user":
      case "current": {
        if (ctx.latestVersion !== null && e.version === ctx.latestVersion) {
          steps.push(infoStep(sid, `Plugin ${e.id} (${e.scope})`, "already configured", `already current (${e.version}, ${e.scope})`));
        } else if (pending(e)) {
          steps.push(pluginUpdateStep(e, sid));
        } else {
          steps.push(
            infoStep(
              sid,
              `Plugin ${e.id} (${e.scope})`,
              "skipped",
              `at ${e.version}; run /plugin marketplace update ${e.marketplace} inside Claude Code to update it`,
            ),
          );
        }
        break;
      }
      case "other": {
        otherCount += 1;
        if (otherShown.length < 3) otherShown.push(e.projectPath === "" ? "(unknown project)" : tildePath(e.projectPath));
        break;
      }
      default:
        steps.push(
          infoStep(sid, `Plugin ${e.id} (${e.scope})`, "skipped", `at ${e.version}; managed outside your user and project settings, so not touched`),
        );
    }
  });

  if (otherCount > 0) {
    const more = otherCount > otherShown.length ? `, +${otherCount - otherShown.length} more` : "";
    const noun = otherCount === 1 ? "1 other project install" : `${otherCount} other project installs`;
    steps.push(infoStep("plugin-other-projects", "Plugin (other projects)", "skipped", `${noun} not touched: ${otherShown.join(", ")}${more}`));
  }

  // Advisories (report-only, D9, D19, D22).
  if (entries.length > 0) {
    const mkt = first?.marketplace ?? entries[0]?.marketplace ?? "jubarteai";
    if (!discovery.viaCli) {
      const why = discovery.hasClaude
        ? "couldn't list plugins with claude, so the plugin wasn't checked or updated"
        : "jubarteai-mcp is installed, but claude isn't on PATH, so it wasn't checked or updated";
      steps.push(infoStep("plugin-unchecked", "Plugin check", "skipped", `${why}; run /plugin marketplace update ${mkt} inside Claude Code to update it`));
    } else if (discovery.disabled) {
      steps.push(infoStep("plugin-disabled", "Plugin enabled state", "skipped", "jubarteai-mcp is disabled for this project; enable it with /plugin inside Claude Code"));
    }
    if (ctx.ccVersion !== null && versionLt(ctx.ccVersion, CLAUDE_PLUGIN_SCOPE_FIXED_IN)) {
      steps.push(
        infoStep(
          "claude-code-version",
          "Claude Code version",
          "skipped",
          `${ctx.ccVersion} updates the wrong scope when you run claude plugin update by hand; update Claude Code, or let this command do the plugin update`,
        ),
      );
    }
    steps.push(
      infoStep(
        "plugin-auto-update-tip",
        "Plugin auto-update",
        "skipped",
        `tip: turn on auto-update for the ${mkt} marketplace under /plugin, Marketplaces, to get plugin releases without running update`,
      ),
    );
  }
  return steps;

  function pluginUpdateStep(e: PluginEntry, sid: string): PlanStep {
    const label = `Update plugin ${e.id} (${e.scope})`;
    const files = e.installPath === "" ? [] : [e.installPath];
    return {
      id: sid,
      label,
      group: harnessGroup("claude-code"),
      files,
      sensitive: false,
      apply: async (): Promise<StepResult> => {
        const result = (status: StepResult["status"], detail: string): StepResult => ({ id: sid, label, status, detail });
        if (!(await refreshMarketplace(e.marketplace))) return result("failed", "claude plugin marketplace update error");
        let cwd = listCwd;
        if (e.scope !== "user") {
          // Claude Code picks the entry to update from its cwd: with no entry for the cwd a
          // --scope project update changes the first project's entry and still exits 0.
          if (!isAbsolute(e.projectPath) || !isDir(e.projectPath)) {
            return result("failed", `the project folder of the ${e.scope} install, ${tildePath(e.projectPath)}, is gone`);
          }
          cwd = e.projectPath;
        }
        const run = await runCommand("claude", ["plugin", "update", e.id, "--scope", e.scope], {
          cwd,
          timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
        });
        if (run.timedOut) return withLog(result("failed", `claude plugin update timed out (${e.scope})`), logTail(run));
        if (run.code !== 0) return withLog(result("failed", `claude plugin update error (${e.scope})`), logTail(run));

        // The outcome comes from a re-listing of every entry, not from the command's output,
        // so an update that landed on another entry is reported as such.
        const after = await discoverPlugins(listCwd, ctx.keys);
        const now = after.entries.find((x) => pluginKey(x) === pluginKey(e));
        if (now === undefined) return result("failed", `${e.id} (${e.scope}) not found after the update`);
        const strays = after.entries.filter((x) => {
          const was = baseline.get(pluginKey(x));
          return !targets.has(pluginKey(x)) && was !== undefined && was !== x.version;
        });
        const strayNote = strays
          .map((x) => `; warning: the update also changed ${x.id} (${x.scope})${x.projectPath === "" ? "" : ` for ${tildePath(x.projectPath)}`}: ${baseline.get(pluginKey(x))} -> ${x.version}`)
          .join("");
        if (now.version !== e.version) {
          return result("configured", `updated ${e.version} -> ${now.version} (${e.scope}); restart Claude Code or run /reload-plugins to load it${strayNote}`);
        }
        if (strays.some((x) => x.scope === e.scope)) {
          return result("failed", `claude plugin update changed another ${e.scope} install instead of this project's${strayNote}`);
        }
        const stale =
          ctx.latestVersion !== null && now.version !== ctx.latestVersion
            ? `; GitHub lists ${ctx.latestVersion}, but the marketplace snapshot still has ${now.version}, run this again in a minute`
            : "";
        return result("already configured", `already current (${now.version}, ${e.scope})${stale}${strayNote}`);
      },
    };
  }
}

/** The report-only duplicate-load and symlink findings. */
function duplicateAndLinkSteps(discovery: PluginDiscovery, copies: SkillCopy[], root: string | null): PlanStep[] {
  const steps: PlanStep[] = [];
  const loads = discovery.entries.find((e) => e.bucket === "user" || e.bucket === "current");
  if (loads !== undefined) {
    const candidates: Array<{ path: string; global: boolean }> = [];
    if (root !== null) candidates.push({ path: join(realPath(root) ?? root, ".claude", "skills", SKILL_NAME), global: false });
    candidates.push({ path: join(homeDir(), ".claude", "skills", SKILL_NAME), global: true });
    for (const c of candidates) {
      if (!isFile(join(c.path, "SKILL.md"))) continue;
      const shown = shownPath(c.path, root);
      steps.push(
        infoStep(
          `skill-duplicate-${c.global ? "global" : "project"}`,
          `Skill duplicate load (${c.global ? "global" : "project"})`,
          "skipped",
          `the ${SKILL_NAME} skill may load twice: plugin ${loads.id} and the copy at ${shown}; keep one: claude plugin uninstall ${loads.id} --scope ${loads.scope}, or remove the copy: delete ${shown}, or run npx skills remove ${SKILL_NAME}${c.global ? " -g" : ""} -a claude-code`,
          [c.path],
        ),
      );
    }
  }
  copies.forEach((copy, i) => {
    if (copy.channel !== "link") return;
    steps.push(
      infoStep(
        `skill-link-${copy.scope}-${i}`,
        `Skill link (${copy.scope})`,
        "skipped",
        `${copy.shown} links to ${tildePath(copy.target)}; not touched, update that folder yourself (a re-install here would replace the link)`,
        [copy.dir],
      ),
    );
  });
  return steps;
}

/** The harnesses a skills-installer agent id serves: one editor, or (GitHub Copilot) VS Code and Copilot CLI. */
export function harnessesForAgent(agent: string): HarnessId[] {
  if (agent === "github-copilot") return ["vscode", "copilot-cli"];
  return (HARNESS_IDS as readonly string[]).includes(agent) ? [agent as HarnessId] : [];
}

function initStep(opts: { root: string | null; agents: string[]; copies: SkillCopy[]; plugins: PluginDiscovery; nodeVersion: string }): PlanStep {
  const id = "skill-install";
  const scope: Scope = opts.root === null ? "global" : "project";
  const valid = [...new Set(opts.agents.filter((a) => AGENT_ID_RE.test(a)))];
  if (valid.length === 0) return infoStep(id, "Install skill", "skipped", "no harness detected");

  const pluginCovers = opts.plugins.entries.some((e) => e.bucket === "user" || e.bucket === "current");
  const home = homeDir();
  const physicalRoot = opts.root === null ? null : (realPath(opts.root) ?? opts.root);
  const covered = (agent: string): boolean => {
    if (agent === "claude-code" && pluginCovers) return true;
    const dir = SKILL_AGENT_DIRS[agent]?.[scope];
    if (dir === undefined) return false;
    const base = scope === "global" ? home : physicalRoot;
    return base !== null && isFile(join(base, dir, SKILL_NAME, "SKILL.md"));
  };
  const missing = valid.filter((a) => !covered(a));
  if (missing.length === 0) return infoStep(id, "Install skill", "already configured", "skill already installed");

  const tail = [...(scope === "global" ? ["-g"] : []), ...missing.flatMap((a) => ["-a", a]), "-y"];
  const label = `Install skill for ${missing.join(", ")}${scope === "global" ? " (global)" : ""}`;
  const lockPath = opts.root === null ? null : join(opts.root, "skills-lock.json");
  // Every folder `add` writes: each missing agent's skill dir (shared dirs once), plus the project lock.
  const base = scope === "global" ? home : physicalRoot;
  const files: string[] = [];
  for (const agent of missing) {
    const dir = SKILL_AGENT_DIRS[agent]?.[scope];
    if (dir !== undefined && base !== null) {
      const folder = join(base, dir, SKILL_NAME);
      if (!files.includes(folder)) files.push(folder);
    }
  }
  if (scope === "project" && lockPath !== null) files.push(lockPath);
  const harnesses = [...new Set(missing.flatMap((agent) => harnessesForAgent(agent)))];
  return {
    id,
    label,
    // One `skills add -a a -a b` serves several harnesses: it shows under the first and narrows to those still checked.
    group: harnessGroup(harnesses[0] ?? "claude-code"),
    alsoGroups: harnesses.slice(1),
    narrow: (keep) => {
      const kept = missing.filter((agent) => harnessesForAgent(agent).some((h) => keep.has(h)));
      return kept.length === 0 ? null : initStep({ ...opts, agents: kept });
    },
    files,
    sensitive: false,
    apply: async (): Promise<StepResult> => {
      const result = (status: StepResult["status"], detail: string, log?: string[]): StepResult => ({ id, label, status, detail, ...(log === undefined || log.length === 0 ? {} : { log }) });
      if (!nodeMeetsFloor(opts.nodeVersion)) return result("skipped", nodeSkipDetail(opts.nodeVersion, scope, opts.root, tail));
      const hadLock = lockPath !== null && existsSync(lockPath);
      const run = await runSkillsAdd(scope, opts.root, tail);
      const lockNote = scope === "project" && lockPath !== null && !hadLock && existsSync(lockPath) ? ` ${LOCK_NOTE}` : "";
      if (!run.ok) return result("failed", `${run.why}${lockNote}`, run.log);
      return result("configured", `installed for ${missing.join(", ")}${lockNote}`);
    },
  };
}

/**
 * The skill steps for `init` or `update`; every step is non-sensitive.
 *
 * init: for each requested agent that has no skill yet (and is not Claude Code with the
 * plugin installed, which would load it twice) one `npx -y skills@<pin> add <repo> -a
 * <agent>… -y` (project scope; `-g` from `~`). When every agent already has one the
 * step reports "already configured".
 *
 * update: per channel (D8-D11, D18-D22): re-add each stale or unknown skill copy with
 * its owner agent at its own scope, overwrite hand copies, skip current copies, update
 * the plugin at user scope and this project's scope, and report duplicates, links, other
 * projects' installs and a disabled plugin. No skill is added for a harness that does not
 * already have one; with nothing installed the list is empty. `agents` is used by init only.
 */
export async function planSkillSteps(opts: PlanOptions): Promise<PlanStep[]> {
  const startDir = opts.cwd ?? process.cwd();
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const keys = await claudeProjectKeys(opts.root, startDir);
  const plugins = await discoverPlugins(opts.root === null ? homeDir() : startDir, keys);

  if (opts.mode === "init") {
    return [initStep({ root: opts.root, agents: opts.agents, copies: [], plugins, nodeVersion })];
  }

  const latest = opts.latest === undefined ? await fetchLatestSkill() : opts.latest;
  const copies = discoverSkillCopies(opts.root, latest?.tree ?? null);
  const ccVersion = await claudeVersion();

  const steps: PlanStep[] = [];
  steps.push(...pluginSteps(plugins, { root: opts.root, startDir, keys, latestVersion: latest?.version ?? null, ccVersion }));

  let lockNamed = false;
  copies.forEach((copy, i) => {
    if (copy.channel === "link") return;
    if (!copyPending(copy)) {
      steps.push(
        infoStep(`skill-${copy.scope}-${i}`, `Skill (${copy.scope})`, "already configured", `already current (${latest?.version ?? "latest"}), ${copy.shown}`, [copy.dir]),
      );
      return;
    }
    // Re-adding a project hand copy also creates the project's skills-lock.json when there is
    // none; the first such row says so (the CLI writes the lock once).
    let nameLock = false;
    if (copy.channel === "hand" && copy.scope === "project" && !lockNamed && opts.root !== null && !existsSync(join(opts.root, "skills-lock.json"))) {
      nameLock = true;
      lockNamed = true;
    }
    steps.push(skillUpdateStep(copy, i, { root: opts.root, latest, nodeVersion, nameLock }));
  });
  steps.push(...duplicateAndLinkSteps(plugins, copies, opts.root));
  return steps;
}
