// MCP cleanup (spec §6.2, D3): remove the `jubarteai` server entry install.sh wrote into the six harnesses'
// user and project configs, and into Claude Code's local scope. Only that one entry goes; every other key,
// server and byte stays. Ported from install.sh / update.sh's MCP writers.
//
// Nothing here writes a file itself (I6): each change is a PlanStep whose apply() goes through editJsonFile /
// editTomlFile (guards: symlink, other owner, hard links, atomic exact-mode write). A file the safe-edit layer
// would refuse (JSONC, hard link, foreign owner, a symlink leaving the home directory…) comes back as
// ManualInstructions, "skipped: <reason>, remove it by hand: <path>", and is never edited. Project configs are only
// reported when the command ran from ~ or / (no single project is meant there).
import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "../install/run.js";
import { safeForDisplay } from "../output.js";
import { editJsonFile, readConfigText, readJsonObject, type JsonEditResult } from "../safe-edit/json-edit.js";
import { editTomlFile, removeTomlTable, TomlConflictError } from "../safe-edit/toml-edit.js";
import { assertSafeTarget, type RefusalReason } from "../safe-edit/file-guards.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import type { CleanupScope, ManualInstructions } from "./types.js";
import type { HarnessId } from "../session/harness-env.js";

/** The six harnesses install.sh wrote an MCP entry for. */
export type CleanupHarness = Extract<HarnessId, "claude-code" | "codex" | "cursor" | "vscode" | "windsurf" | "zed">;

export const MCP_SERVER_NAME = "jubarteai";
const CODEX_TABLE = `mcp_servers.${MCP_SERVER_NAME}`;
const GIT_TIMEOUT_MS = 5_000;
const MAX_KEYS_SHOWN = 3;

/**
 * Decides at apply time whether a harness' entry may go. Returns null to proceed, or a fixed reason to keep it
 * (Codex under D5: its MCP entry stays until the network opt-in is in place, and the plan lists the cleanup before
 * the opt-in has been applied).
 */
export type CleanupGate = () => Promise<string | null>;

type Entry = { path: string[]; what: string };
type Target = {
  harness: CleanupHarness;
  file: string;
  format: "json" | "toml";
  /** True for a config that belongs to one project (a .mcp.json, .codex/config.toml, Claude Code's local scope). */
  project: boolean;
  /** True when the file sits in the project's own tree (what a repo's contents can steer): a link out of the project is never followed. */
  inProject: boolean;
  /** JSON only: the entries to remove from this file. */
  entries: Entry[];
};

type Finding = {
  target: Target;
  /** The file holds (or, for a file we can't read, may hold) a jubarteai entry. */
  holds: boolean;
  /** Set when the file must not be edited: the reason, as printed. */
  blocked: string | null;
  /** The entries actually present (JSON). */
  present: Entry[];
};

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  symlink: "it is a symbolic link, or sits in a directory that is one",
  hardlink: "it has other hard links",
  "foreign-owner": "it belongs to another user",
  "reparse-point": "it is a link or reparse point",
  "outside-home": "it is a link that leads outside your home directory",
  "unsafe-parent": "its directory belongs to another user or can be written to by others",
};

const FROM_HOME = "run from ~ or /, project configs are only reported";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function physical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whether `file` sits under the home directory (lexically or by real path): then a symlinked config is followed, else no link is. */
export function isUnderHome(file: string, home: string): boolean {
  const abs = path.resolve(file);
  return inside(abs, path.resolve(home)) || inside(abs, physical(home)) || inside(physical(abs), physical(home));
}

const SHOWN_PATH_LIMIT = 400;

/** A path as printed: ~/… when under the home directory, control and format characters replaced (a folder name is not trusted). */
export function shownPath(file: string, home: string): string {
  const abs = path.resolve(file);
  for (const base of [path.resolve(home), physical(home)]) {
    const rel = path.relative(base, abs);
    if (rel === "") return "~";
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return safeForDisplay(`~/${rel.split(path.sep).join("/")}`, SHOWN_PATH_LIMIT);
  }
  return safeForDisplay(abs, SHOWN_PATH_LIMIT);
}

function manual(harness: CleanupHarness, file: string, home: string, reason: string): ManualInstructions {
  const shown = shownPath(file, home);
  return {
    kind: "manual",
    harness,
    title: `jubarteai MCP entry in ${shown}`,
    lines: [`skipped: ${reason}, remove it by hand: ${shown}`],
    reason,
  };
}

/** A user-level entry that is deliberately left in place, and why. */
function kept(harness: CleanupHarness, file: string, home: string, reason: string): ManualInstructions {
  const shown = shownPath(file, home);
  return { kind: "manual", harness, title: `jubarteai MCP entry in ${shown}`, lines: [`kept: ${reason}: ${shown}`], reason };
}

function absoluteEnvDir(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== "" && path.isAbsolute(value) ? value : null;
}

/** Claude Code's config file for the user and local scopes: a legacy .config.json in its config directory when one exists, else .claude.json. */
export function claudeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  const configDir = absoluteEnvDir(env, "CLAUDE_CONFIG_DIR");
  const legacy = path.join(configDir ?? path.join(home, ".claude"), ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  return path.join(configDir ?? home, ".claude.json");
}

/** `$CODEX_HOME` when absolute, else ~/.codex. */
export function codexHome(home: string, env: NodeJS.ProcessEnv): string {
  return absoluteEnvDir(env, "CODEX_HOME") ?? path.join(home, ".codex");
}

function zedConfigDir(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return path.join(absoluteEnvDir(env, "APPDATA") ?? path.join(home, "AppData", "Roaming"), "Zed");
  if (platform === "darwin") return path.join(home, ".config", "zed");
  return path.join(absoluteEnvDir(env, "XDG_CONFIG_HOME") ?? path.join(home, ".config"), "zed");
}

function vscodeUserDirs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  let base: string;
  if (platform === "darwin") base = path.join(home, "Library", "Application Support");
  else if (platform === "win32") base = absoluteEnvDir(env, "APPDATA") ?? path.join(home, "AppData", "Roaming");
  else base = absoluteEnvDir(env, "XDG_CONFIG_HOME") ?? path.join(home, ".config");
  return [path.join(base, "Code", "User"), path.join(base, "Code - Insiders", "User")];
}

function profileConfigs(userDir: string, name: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(userDir, "profiles"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().map((n) => path.join(userDir, "profiles", n, name));
}

/** The directories whose project config a harness may read: where the command ran, then each parent up to the project root (or, from ~ or /, up to that). */
function projectDirs(scope: CleanupScope): string[] {
  const home = physical(scope.home);
  const start = physical(scope.startDir ?? process.cwd());
  const root = scope.projectRoot === null ? (inside(start, home) ? home : path.parse(start).root) : physical(scope.projectRoot);
  if (!inside(start, root)) return [root];
  const dirs: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return dirs;
}

/** Claude Code files a project's local scope under its git top level, a linked worktree's main checkout, or the folder itself — NFC and raw spellings. */
async function claudeProjectKeys(scope: CleanupScope, start: string): Promise<string[]> {
  const candidates: string[] = [];
  const root = scope.projectRoot;
  if (root !== null) {
    let main = "";
    let mainRaw = "";
    // git before 2.31 has no --path-format: it echoes the option back and answers relative to the directory it runs in.
    // Then the plain answer is taken and resolved against the project root.
    const git = async (arg: string): Promise<string> => {
      const modern = await runCommand("git", ["rev-parse", "--path-format=absolute", arg], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
      const line = modern.code === 0 ? modern.stdout.trim() : "";
      if (path.isAbsolute(line)) return line;
      const plain = await runCommand("git", ["rev-parse", arg], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
      const answer = plain.code === 0 ? plain.stdout.trim() : "";
      return answer === "" || answer.includes("\n") ? "" : path.resolve(root, answer);
    };
    const gitDir = await git("--git-dir");
    const commonRaw = await git("--git-common-dir");
    if (gitDir !== "" && commonRaw !== "") {
      const common = physical(commonRaw);
      if (inside(physical(gitDir), path.join(common, "worktrees")) && physical(gitDir) !== path.join(common, "worktrees")) {
        main = common.replace(/[\\/]\.git$/, "");
        mainRaw = commonRaw.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "");
      }
    }
    candidates.push(main, mainRaw, physical(root), path.resolve(root));
  }
  candidates.push(start, path.resolve(scope.startDir ?? process.cwd()));
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (candidate === "" || !path.isAbsolute(candidate)) continue;
    for (const form of [candidate.normalize("NFC"), candidate]) {
      if (seen.has(form)) continue;
      seen.add(form);
      keys.push(form);
    }
  }
  return keys;
}

function jsonTarget(harness: CleanupHarness, file: string, project: boolean, entryPath: string[], what: string): Target {
  return { harness, file, format: "json", project, inProject: project, entries: [{ path: entryPath, what }] };
}

/** How the safe-edit layer treats links for this file: inside the project's own tree only while they stay in the project, else within the home directory. */
function linkRules(target: Target, scope: CleanupScope): { withinRoot: string } | { withinHome: boolean } {
  if (target.inProject && scope.projectRoot !== null) return { withinRoot: scope.projectRoot };
  return { withinHome: isUnderHome(target.file, scope.home) };
}

async function targetsFor(harness: CleanupHarness, scope: CleanupScope): Promise<Target[]> {
  const env = scope.env ?? process.env;
  const home = scope.home;
  const dirs = projectDirs(scope);
  const start = dirs[0] ?? path.resolve(scope.startDir ?? process.cwd());
  const out: Target[] = [];
  const jsonName = (rel: string[], entry: string[], what: string): void => {
    for (const dir of dirs) out.push(jsonTarget(harness, path.join(dir, ...rel), true, entry, what));
  };

  switch (harness) {
    case "claude-code": {
      const file = claudeConfigFile(home, env);
      const keys = await claudeProjectKeys(scope, start);
      out.push(jsonTarget(harness, file, false, ["mcpServers", MCP_SERVER_NAME], "user scope"));
      // Local scope belongs to one project: it is reported, not edited, when no project is meant.
      out.push({
        harness,
        file,
        format: "json",
        project: true,
        inProject: false,
        entries: keys.map((key) => ({ path: ["projects", key, "mcpServers", MCP_SERVER_NAME], what: `local scope of ${safeForDisplay(key, SHOWN_PATH_LIMIT)}` })),
      });
      jsonName([".mcp.json"], ["mcpServers", MCP_SERVER_NAME], "project config");
      break;
    }
    case "codex": {
      out.push({ harness, file: path.join(codexHome(home, env), "config.toml"), format: "toml", project: false, inProject: false, entries: [] });
      for (const dir of dirs) out.push({ harness, file: path.join(dir, ".codex", "config.toml"), format: "toml", project: true, inProject: true, entries: [] });
      break;
    }
    case "cursor": {
      out.push(jsonTarget(harness, path.join(home, ".cursor", "mcp.json"), false, ["mcpServers", MCP_SERVER_NAME], "user config"));
      jsonName([".cursor", "mcp.json"], ["mcpServers", MCP_SERVER_NAME], "project config");
      break;
    }
    case "vscode": {
      for (const userDir of vscodeUserDirs(home, scope.platform, env)) {
        for (const file of [path.join(userDir, "mcp.json"), ...profileConfigs(userDir, "mcp.json")]) {
          out.push(jsonTarget(harness, file, false, ["servers", MCP_SERVER_NAME], "user config"));
        }
      }
      jsonName([".vscode", "mcp.json"], ["servers", MCP_SERVER_NAME], "project config");
      break;
    }
    case "windsurf": {
      out.push(jsonTarget(harness, path.join(home, ".codeium", "windsurf", "mcp_config.json"), false, ["mcpServers", MCP_SERVER_NAME], "user config"));
      break;
    }
    case "zed": {
      out.push(jsonTarget(harness, path.join(zedConfigDir(home, scope.platform, env), "settings.json"), false, ["context_servers", MCP_SERVER_NAME], "user settings"));
      jsonName([".zed", "settings.json"], ["context_servers", MCP_SERVER_NAME], "project settings");
      break;
    }
  }
  return mergeSameFile(out, scope);
}

/**
 * One target per (real file, entry path). A path that is one of the harness' user-level configs (by real path) is never a
 * project candidate, whichever order the targets were listed in: run from ~, the project walk reaches ~/.codex/config.toml
 * and ~/.cursor/mcp.json, which are the user's files, not a project's. Claude Code's local scope lives in the user file
 * itself and belongs to a project, so with no project (run from ~ or /) there is none to look for.
 */
function mergeSameFile(targets: Target[], scope: CleanupScope): Target[] {
  const id = (real: string, entryPath: string[] | null): string => `${real}\u0000${entryPath === null ? "toml" : entryPath.join("\u0001")}`;
  const userIds = new Set<string>();
  for (const target of targets) {
    if (target.project) continue;
    const real = physical(target.file);
    if (target.format === "toml") userIds.add(id(real, null));
    else for (const e of target.entries) userIds.add(id(real, e.path));
  }
  const merged: Target[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.project && target.entries.length > 0 && !target.inProject && scope.projectRoot === null) continue;
    const real = physical(target.file);
    if (target.format === "toml") {
      const key = id(real, null);
      if ((target.project && userIds.has(key)) || seen.has(key)) continue;
      seen.add(key);
      merged.push(target);
      continue;
    }
    const entries = target.entries.filter((e) => {
      const key = id(real, e.path);
      if ((target.project && userIds.has(key)) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (entries.length > 0) merged.push({ ...target, entries });
  }
  return merged;
}

function hasPath(doc: Record<string, unknown>, entryPath: string[]): boolean {
  let node: unknown = doc;
  for (const key of entryPath) {
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return false;
    node = node[key];
  }
  return true;
}

function removePath(doc: Record<string, unknown>, entryPath: string[]): boolean {
  if (!hasPath(doc, entryPath)) return false;
  let node: unknown = doc;
  for (const key of entryPath.slice(0, -1)) node = (node as Record<string, unknown>)[key];
  delete (node as Record<string, unknown>)[entryPath[entryPath.length - 1] as string];
  return true;
}

type Guarded = { ok: true } | { ok: false; reason: string };

function guard(target: Target, scope: CleanupScope): Guarded {
  const result = assertSafeTarget(target.file, { allowMissing: false, ...linkRules(target, scope) });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason === "missing" ? "the file went away" : REFUSAL_TEXT[result.reason] };
}

/** Whether a file that isn't plain JSON mentions jubarteai; one that can't be read counts as mentioning it. */
function mentionsServer(file: string): boolean {
  try {
    const read = readConfigText(file);
    return read.status === "ok" ? read.text.includes(MCP_SERVER_NAME) : true;
  } catch {
    return true;
  }
}

function examine(target: Target, scope: CleanupScope): Finding {
  const none: Finding = { target, holds: false, blocked: null, present: [] };
  let st: fs.Stats;
  try {
    st = fs.statSync(target.file);
  } catch (e) {
    if (isNotFound(e)) return none;
    return { ...none, holds: true, blocked: "it could not be read" };
  }
  if (!st.isFile()) return none;

  let present: Entry[] = [];
  let holds: boolean;
  let blocked: string | null = null;

  if (target.format === "toml") {
    let read: ReturnType<typeof readConfigText>;
    try {
      read = readConfigText(target.file);
    } catch {
      return { ...none, holds: true, blocked: "it could not be read" };
    }
    if (read.status !== "ok") return { ...none, holds: true, blocked: "it is too large or not text" };
    try {
      holds = removeTomlTable(read.text, CODEX_TABLE).changed;
    } catch (e) {
      if (!(e instanceof TomlConflictError)) throw e;
      return { ...none, holds: true, blocked: "it sets jubarteai inline or with dotted keys, which can't be removed safely" };
    }
  } else {
    let parsed: ReturnType<typeof readJsonObject>;
    try {
      parsed = readJsonObject(target.file);
    } catch {
      return { ...none, holds: true, blocked: "it could not be read" };
    }
    if (parsed.status === "missing") return none;
    if (parsed.status === "ok") {
      present = target.entries.filter((e) => hasPath(parsed.doc, e.path));
      holds = present.length > 0;
    } else {
      // Not plain JSON: only a file that mentions jubarteai is worth reporting.
      if (!mentionsServer(target.file)) return none;
      holds = true;
      blocked =
        parsed.status === "jsonc"
          ? "it has comments or trailing commas (JSONC)"
          : parsed.status === "not-object"
            ? "it is not a JSON object"
            : "it is not valid JSON, or too large";
    }
  }
  if (!holds) return none;
  if (blocked === null && target.project && scope.projectRoot === null) blocked = FROM_HOME;
  if (blocked === null) {
    const g = guard(target, scope);
    if (!g.ok) blocked = g.reason;
  }
  return { target, holds, blocked, present };
}

/** Every config of `harness` that holds a jubarteai MCP entry (or may: a file that can't be read safely but mentions it). Read-only; for doctor. */
export async function findMcpEntries(harness: CleanupHarness, scope: CleanupScope): Promise<string[]> {
  const files: string[] = [];
  for (const target of await targetsFor(harness, scope)) {
    const finding = examine(target, scope);
    if (finding.holds && !files.includes(target.file)) files.push(target.file);
  }
  return files;
}

function refusalText(reason: JsonEditResult["reason"]): string {
  if (reason === "jsonc") return "it has comments or trailing commas (JSONC)";
  if (reason === "invalid-json") return "it is not valid JSON, or too large";
  if (reason === "not-object") return "it is not a JSON object";
  return reason === undefined ? "it was refused" : REFUSAL_TEXT[reason];
}

function skippedResult(step: { id: string; label: string }, detail: string): StepResult {
  return { id: step.id, label: step.label, status: "skipped", detail };
}

function describe(entries: Entry[]): string {
  const names = entries.map((e) => e.what);
  const shown = names.slice(0, MAX_KEYS_SHOWN).join(", ");
  return names.length > MAX_KEYS_SHOWN ? `${shown} +${names.length - MAX_KEYS_SHOWN} more` : shown;
}

function stepFor(finding: Finding, scope: CleanupScope, gate: CleanupGate | undefined): PlanStep {
  const { target } = finding;
  const shown = shownPath(target.file, scope.home);
  const rules = linkRules(target, scope);
  const id = `mcp-cleanup:${target.harness}:${target.project ? "project" : "user"}:${target.file}`;
  const detailText = target.format === "toml" ? `[${CODEX_TABLE}]` : describe(finding.present);
  const label = `Remove the jubarteai MCP entry from ${shown} (${detailText})`;
  const preview =
    target.format === "toml"
      ? `${shown}: remove the [${CODEX_TABLE}] table`
      : finding.present.map((e) => `${shown}: remove "${e.path.join(".")}"`).join("\n");

  return {
    id,
    label,
    files: [target.file],
    sensitive: true,
    preview,
    async apply(): Promise<StepResult> {
      const keep = gate === undefined ? null : await gate();
      if (keep !== null) return skippedResult({ id, label }, keep);
      let result: JsonEditResult;
      if (target.format === "toml") {
        try {
          result = editTomlFile(target.file, (text) => removeTomlTable(text, CODEX_TABLE), { createIfMissing: false, ...rules });
        } catch (e) {
          if (e instanceof TomlConflictError) return skippedResult({ id, label }, `it sets jubarteai inline or with dotted keys, remove it by hand: ${shown}`);
          throw e;
        }
      } else {
        const paths = finding.present.map((e) => e.path);
        result = editJsonFile(
          target.file,
          (doc) => {
            let changed = false;
            for (const p of paths) changed = removePath(doc, p) || changed;
            return changed;
          },
          { createIfMissing: false, ...rules },
        );
      }
      switch (result.status) {
        case "changed":
          return { id, label, status: "configured", detail: "removed the jubarteai entry" };
        case "unchanged":
        case "missing":
          return { id, label, status: "already configured", detail: "no jubarteai entry" };
        case "refused":
          return skippedResult({ id, label }, `${refusalText(result.reason)}, remove it by hand: ${shown}`);
      }
    },
  };
}

/**
 * Steps (and report-only instructions) that remove the jubarteai MCP entry from one harness' configs. A config that
 * holds no entry produces nothing, so a second run is empty. `gate` may keep the entry at apply time (Codex, D5);
 * `keepUser` reports every user-level entry as kept, with that reason, instead of removing it.
 */
export async function mcpCleanupFor(
  harness: CleanupHarness,
  scope: CleanupScope,
  opts: { gate?: CleanupGate; keepUser?: string } = {},
): Promise<Array<PlanStep | ManualInstructions>> {
  const out: Array<PlanStep | ManualInstructions> = [];
  for (const target of await targetsFor(harness, scope)) {
    const finding = examine(target, scope);
    if (!finding.holds) continue;
    if (opts.keepUser !== undefined && !target.project) out.push(kept(harness, target.file, scope.home, opts.keepUser));
    else if (finding.blocked !== null) out.push(manual(harness, target.file, scope.home, finding.blocked));
    else out.push(stepFor(finding, scope, opts.gate));
  }
  return out;
}
