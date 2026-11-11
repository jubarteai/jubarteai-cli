// OpenCode adapter (spec §9). The shell permission is verified but written per installed version: V2 keeps a
// `permissions` array in opencode.jsonc, V1 a `permission.bash` map. The version comes from `opencode --version`
// (runCommand: no shell, short timeout); anything else is printed instructions. Hooks are unverified (OpenCode only
// has in-process plugins, and V1 and V2 differ), so they are printed too (D25). install.sh never wrote an OpenCode
// MCP entry, so there is nothing to clean. Every write goes through editJsonFile (I6); the reads here are read-only.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runCommand } from "../install/run.js";
import { editJsonFile, readJsonObject, type JsonEditResult } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "opencode" as const;
const LABEL = "OpenCode: allow the jubarteai command";
const VERSION_TIMEOUT_MS = 5_000;
/** Only the start of the version output is read. */
const VERSION_HEAD_CHARS = 200;
const COMMAND_PATTERN = "jubarteai *";
const V2_FILES: readonly string[] = ["opencode.jsonc", "opencode.json"];
const V1_FILES: readonly string[] = ["opencode.json", "opencode.jsonc"];

type Obj = Record<string, unknown>;
type Major = 1 | 2;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `$XDG_CONFIG_HOME/opencode` when that is an absolute path, else `~/.config/opencode`. */
function opencodeDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "opencode");
}

/** The major version in `opencode --version` output ("2.1.3", "v1.19.5", "opencode 2.0.0"); null for anything else. */
function parseMajor(output: string): Major | null {
  const m = /(?:^|[^0-9.])v?(\d{1,3})\.\d{1,5}\.\d{1,5}(?![0-9])/.exec(output.slice(0, VERSION_HEAD_CHARS));
  if (m === null) return null;
  const major = Number(m[1]);
  return major === 1 || major === 2 ? major : null;
}

async function installedMajor(ctx: InitCtx): Promise<Major | null> {
  if (ctx.which("opencode") === null) return null;
  const run = await runCommand("opencode", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (run.notFound || run.timedOut || run.code !== 0) return null;
  return parseMajor(run.stdout);
}

/** The config file to edit: the first of `names` that exists, else the first name (created). */
function configFile(dir: string, names: readonly string[]): string {
  for (const name of names) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return join(dir, names[0] ?? "opencode.json");
}

const V2_RULE = { action: "shell", resource: COMMAND_PATTERN, effect: "allow" } as const;

type Blocked = { reason: string | null };

function sameTarget(rule: unknown): rule is Obj {
  return isObject(rule) && rule["action"] === V2_RULE.action && rule["resource"] === V2_RULE.resource;
}

/** V2: append the rule to `permissions` ("the last matching rule wins"). A rule for the same command that does not allow is the user's choice and is never overridden. */
function addV2(doc: Obj, blocked: Blocked): boolean {
  const existing = doc["permissions"];
  if (existing === undefined) {
    doc["permissions"] = [{ ...V2_RULE }];
    return true;
  }
  if (!Array.isArray(existing)) {
    blocked.reason = "permissions in the config is not a list; add the rule by hand";
    return false;
  }
  const same = existing.filter(sameTarget);
  if (same.some((rule) => rule["effect"] !== "allow")) {
    blocked.reason = `the config already has a ${COMMAND_PATTERN} rule that does not allow it; left as is`;
    return false;
  }
  if (same.length > 0) return false;
  existing.push({ ...V2_RULE });
  return true;
}

/** V1: set `permission.bash["jubarteai *"] = "allow"`. A string `permission`/`bash` of "allow" already covers it; any other string, or a different value for the key, is left alone. */
function addV1(doc: Obj, blocked: Blocked): boolean {
  const permission = doc["permission"];
  if (permission === undefined) {
    doc["permission"] = { bash: { [COMMAND_PATTERN]: "allow" } };
    return true;
  }
  if (typeof permission === "string") {
    if (permission !== "allow") blocked.reason = "permission in the config is set to a single value; add the rule by hand";
    return false;
  }
  if (!isObject(permission)) {
    blocked.reason = "permission in the config has an unexpected shape; add the rule by hand";
    return false;
  }
  const bash = permission["bash"];
  if (bash === undefined) {
    permission["bash"] = { [COMMAND_PATTERN]: "allow" };
    return true;
  }
  if (typeof bash === "string") {
    if (bash !== "allow") blocked.reason = "permission.bash in the config is set to a single value; add the rule by hand";
    return false;
  }
  if (!isObject(bash)) {
    blocked.reason = "permission.bash in the config has an unexpected shape; add the rule by hand";
    return false;
  }
  const current = bash[COMMAND_PATTERN];
  if (current === undefined) {
    bash[COMMAND_PATTERN] = "allow";
    return true;
  }
  if (current !== "allow") blocked.reason = `the config already has a ${COMMAND_PATTERN} rule that does not allow it; left as is`;
  return false;
}

function resultOf(id: string, edit: JsonEditResult, blocked: string | null): StepResult {
  if (blocked !== null) return { id, label: LABEL, status: "skipped", detail: blocked };
  if (edit.status === "changed") return { id, label: LABEL, status: "configured" };
  if (edit.status === "unchanged") return { id, label: LABEL, status: "already configured" };
  return { id, label: LABEL, status: "failed", detail: `could not write (${edit.reason ?? edit.status})` };
}

function v2Lines(): string[] {
  return JSON.stringify({ permissions: [V2_RULE] }, null, 2).split("\n");
}

function v1Lines(): string[] {
  return JSON.stringify({ permission: { bash: { [COMMAND_PATTERN]: "allow" } } }, null, 2).split("\n");
}

function manualPermission(file: string, major: Major, why: string): ManualInstructions {
  return {
    kind: "manual",
    harness: HARNESS,
    title: LABEL,
    lines: [`Open ${file} and merge in:`, ...(major === 2 ? v2Lines() : v1Lines())],
    reason: why,
  };
}

function manualUnknownVersion(dir: string): ManualInstructions {
  return {
    kind: "manual",
    harness: HARNESS,
    title: LABEL,
    lines: [
      `Add the rule for your OpenCode version to the config in ${dir}.`,
      "OpenCode 2.x, in opencode.jsonc:",
      ...v2Lines(),
      "OpenCode 1.x, in opencode.json:",
      ...v1Lines(),
    ],
    reason: "could not read the OpenCode version (`opencode --version`), and the two versions use different rule syntax",
  };
}

function permissionStep(file: string, major: Major, done: boolean): PlanStep {
  const id = `${HARNESS}:permission`;
  return {
    id,
    label: LABEL,
    files: [file],
    sensitive: !done,
    preview: `${file}\n${(major === 2 ? v2Lines() : v1Lines()).map((l) => `  ${l}`).join("\n")}`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const blocked: Blocked = { reason: null };
      const edit = editJsonFile(file, (doc) => (major === 2 ? addV2(doc, blocked) : addV1(doc, blocked)), { createIfMissing: true, withinHome: true });
      return resultOf(id, edit, blocked.reason);
    },
  };
}

/** A read that never throws: no permission to read the file (a root-owned config left by sudo) is "unreadable", not "missing". */
function readConfig(file: string): ReturnType<typeof readJsonObject> | { status: "unreadable" } {
  try {
    return readJsonObject(file);
  } catch {
    return { status: "unreadable" };
  }
}

/** Whether a parsed config already allows the command, in `major`'s syntax (any version's when null). */
function allowsCommand(doc: Obj, major: Major | null = null): boolean {
  const permissions = doc["permissions"];
  if (major !== 1 && Array.isArray(permissions) && permissions.some((r) => sameTarget(r) && r["effect"] === "allow")) return true;
  if (major === 2) return false;
  const permission = doc["permission"];
  if (permission === "allow") return true;
  if (!isObject(permission)) return false;
  const bash = permission["bash"];
  if (bash === "allow") return true;
  return isObject(bash) && bash[COMMAND_PATTERN] === "allow";
}

export const opencodeAdapter: HarnessAdapter = {
  id: HARNESS,
  label: "OpenCode",
  skillAgent: "opencode",
  sessionVar: null,
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    return env.which("opencode") !== null || existsSync(opencodeDir(env.env, env.home));
  },

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    const dir = opencodeDir(ctx.env, ctx.home);
    const major = await installedMajor(ctx);
    if (major === null) return manualUnknownVersion(dir);
    const file = configFile(dir, major === 2 ? V2_FILES : V1_FILES);
    const read = readConfig(file);
    if (read.status === "unreadable") {
      return { kind: "manual", harness: HARNESS, title: LABEL, lines: [`Couldn't read ${file}: fix its permissions, then run init again.`], reason: "the config file is not readable by this user" };
    }
    if (read.status !== "ok" && read.status !== "missing") {
      return manualPermission(file, major, "the config has comments or is not plain JSON, so it is not rewritten");
    }
    return permissionStep(file, major, read.status === "ok" && allowsCommand(read.doc, major));
  },

  // Prose only, so it names ctx.cliCommand (what agents type), never ctx.hookCommand.
  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    return {
      kind: "manual",
      harness: HARNESS,
      title: "OpenCode: session hooks",
      lines: [
        `OpenCode has no shell-command hooks (it runs lifecycle code as plugins in ${join(opencodeDir(ctx.env, ctx.home), "plugins")}), so ${ctx.cliCommand} does not write any.`,
        `Without hooks your agent still works: the skill and the AGENTS.md section tell it to run \`${ctx.cliCommand} connect\` at the start of a session and \`${ctx.cliCommand} inbox\` each turn.`,
      ],
      reason: "OpenCode's plugin API differs between 1.x and 2.x and is not verified (D25)",
    };
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const dir = opencodeDir(ctx.env, ctx.home);
    let unreadable = false;
    let allowed = false;
    for (const name of V2_FILES) {
      const read = readConfig(join(dir, name));
      if (read.status === "ok") allowed = allowed || allowsCommand(read.doc);
      else if (read.status !== "missing") unreadable = true;
    }
    const permission = allowed ? "configured" : unreadable ? "manual" : "missing";
    const notes = unreadable && !allowed ? ["an OpenCode config has comments, is not plain JSON or is not readable; check it by hand"] : [];
    return { permission, hooks: "manual", mcpEntries: [], notes };
  },

  // install.sh never wrote an OpenCode MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
