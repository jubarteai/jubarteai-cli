// Codex adapter (spec §6.1 step 7, §6.3, §9). Codex has no permission rule to write. It gets the three session hooks
// in ~/.codex/hooks.json (the user trusts them once in /hooks), the network opt-in for its sandboxed shell in the
// project's .codex/config.toml (D4–D6, only when it can work, never user-level, never a [permissions.*] table),
// and, only once that opt-in is in place, the removal of install.sh's MCP entries (D5: otherwise Codex keeps its
// entry, because without network access its shell can't reach the CLI).
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureIgnoreBlock } from "../binding/gitignore.js";
import { runCommand } from "../install/run.js";
import { confirm } from "../prompt.js";
import { safeForDisplay } from "../output.js";
import { editTomlFile, readTomlKey, setTomlKey } from "../safe-edit/toml-edit.js";
import { readConfigText } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { HOOK_EVENTS, hooksPreview, readSettings, hooksStep, inspectCommandHooks, mergeCommandHooks, unreadableInstructions, type HookEventSpec, type HooksEditSpec } from "./claude-code.js";
import { codexHome, findMcpEntries, mcpCleanupFor, shownPath, type CleanupGate } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const ID = "codex";
/** The Codex version that honours `[sandbox_workspace_write] network_access` in a project config (proof P1, spec §6.1). */
export const CODEX_NETWORK_MIN_VERSION = "0.162.1";
const VERSION_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
const NETWORK_TABLE = "sandbox_workspace_write";
const NETWORK_KEY = "network_access";
const TRUST_INSTRUCTION = "Trust the new hooks once in Codex: run /hooks";

/**
 * Machine-readable codes on Codex's instructions (ManualInstructions.code), so init and update act on them without
 * matching their text.
 */
export const CODEX_CODES = {
  /** The user-level MCP entry is kept although this project's network opt-in makes it redundant here. */
  keptUser: "codex-mcp-kept-user",
  /** This project's MCP entry is kept until its network opt-in is in place (update's explanation). */
  keptProject: "codex-mcp-kept-project",
  /** Trust the hooks being written once, in Codex's /hooks. */
  trustHooks: "codex-trust-hooks",
  /** The network opt-in can't be written here; says why, and that Codex keeps its MCP entry until it is. */
  networkManual: "codex-network-manual",
} as const;
/** SessionEnd gets one second from Codex by default and three at most. */
const SESSION_END_TIMEOUT_SECONDS = 3;
const IGNORE_BLOCK: readonly string[] = ["# jubarteai: private Codex network setting", "/.codex/config.toml"];

/** The hook events with Codex's SessionEnd limit. */
const CODEX_EVENTS: readonly HookEventSpec[] = HOOK_EVENTS.map((e) => (e.name === "SessionEnd" ? { ...e, timeout: SESSION_END_TIMEOUT_SECONDS } : e));

/** What Codex's own version command is asked and how its answer is read; injectable for tests. */
export type CodexDeps = {
  /** The text `codex --version` prints, or null when Codex can't be run. */
  codexVersion(env: DetectEnv): Promise<string | null>;
  /** The "share it?" question of D6; default answer is no (private). */
  ask(question: string): Promise<boolean>;
  /** Whether git tracks `rel` in `cwd`. */
  isTracked(cwd: string, rel: string): Promise<boolean>;
};

const defaultDeps: CodexDeps = {
  async codexVersion(env) {
    if (env.which("codex") === null) return null;
    const result = await runCommand("codex", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : null;
  },
  ask: (question) => confirm(question, { defaultYes: false }),
  async isTracked(cwd, rel) {
    const result = await runCommand("git", ["ls-files", "--error-unmatch", "--", rel], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    return result.code === 0;
  },
};

function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(v: [number, number, number], min: string): boolean {
  const need = parseVersion(min) as [number, number, number];
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== (need[i] as number)) return (v[i] as number) > (need[i] as number);
  }
  return true;
}

function readText(file: string): string | null {
  try {
    const read = readConfigText(file);
    return read.status === "ok" ? read.text : null;
  } catch {
    return null;
  }
}

const DEFAULT_PERMISSIONS = /^[ \t]*default_permissions[ \t]*=/m;

/** A TOML basic string for a table key such as projects."/a/b". */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** Whether the user's Codex config trusts `projectRoot` (as written, or by its real path). */
function projectTrusted(userConfig: string, projectRoot: string): boolean {
  const roots = new Set([projectRoot, path.resolve(projectRoot)]);
  try {
    roots.add(fs.realpathSync(projectRoot));
  } catch {
    // a missing root is not trusted anyway
  }
  for (const root of roots) {
    try {
      if (readTomlKey(userConfig, `projects.${quote(root)}`, "trust_level") === "trusted") return true;
    } catch {
      // a table name TOML can't spell is not in the file
    }
  }
  return false;
}

type OptIn =
  | { ok: true; alreadySet: boolean }
  | { ok: false; manual: Omit<ManualInstructions, "kind" | "harness"> };

function blocked(title: string, lines: string[], reason: string): OptIn {
  return { ok: false, manual: { title, lines, reason } };
}

/**
 * Whether the network opt-in can work here, and whether it is already set: the project is trusted in the user's
 * Codex config, Codex is new enough, and neither config sets `default_permissions` (the profile form ignores
 * `[sandbox_workspace_write]`). Reads only.
 */
async function evaluateOptIn(env: DetectEnv, projectRoot: string | null, deps: CodexDeps): Promise<OptIn> {
  const title = "Codex network access for jubarteai";
  if (projectRoot === null) {
    return blocked(
      title,
      ["Codex's network setting is written per project: run jubarteai init inside a trusted project folder.", "Until then Codex keeps its jubarteai MCP entry."],
      "run from ~ or /",
    );
  }
  const version = await deps.codexVersion(env);
  const parsed = version === null ? null : parseVersion(version);
  if (parsed === null) {
    return blocked(
      title,
      ["Could not run `codex --version`. Install or upgrade Codex to " + CODEX_NETWORK_MIN_VERSION + " or later, then run jubarteai init again.", "Until then Codex keeps its jubarteai MCP entry."],
      "Codex version unknown",
    );
  }
  if (!atLeast(parsed, CODEX_NETWORK_MIN_VERSION)) {
    return blocked(
      title,
      [`Codex ${parsed.join(".")} is older than ${CODEX_NETWORK_MIN_VERSION}: upgrade Codex, then run jubarteai init again.`, "Until then Codex keeps its jubarteai MCP entry."],
      "Codex too old",
    );
  }
  const home = codexHome(env.home, env.env);
  const userConfig = readText(path.join(home, "config.toml"));
  const projectConfig = readText(path.join(projectRoot, ".codex", "config.toml"));
  if ((userConfig !== null && DEFAULT_PERMISSIONS.test(userConfig)) || (projectConfig !== null && DEFAULT_PERMISSIONS.test(projectConfig))) {
    return blocked(
      title,
      ["A Codex config sets default_permissions, which ignores [sandbox_workspace_write], so the network setting would have no effect.", "Allow network access in your permission profile instead. Until then Codex keeps its jubarteai MCP entry."],
      "default_permissions is set",
    );
  }
  // Another sandbox mode ("read-only", "danger-full-access") makes [sandbox_workspace_write] moot.
  for (const config of [userConfig, projectConfig]) {
    const mode = config === null ? null : readTomlKeySafe(config, "", "sandbox_mode");
    if (typeof mode === "string" && mode !== "workspace-write") {
      return blocked(
        title,
        [`A Codex config sets sandbox_mode = "${safeForDisplay(mode, 40)}", so [sandbox_workspace_write] would have no effect. Until then Codex keeps its jubarteai MCP entry.`],
        "sandbox_mode is not workspace-write",
      );
    }
  }
  // Trust comes first: a key that is already set (in either file) opens the network only for a project Codex trusts (P1).
  if (userConfig === null || !projectTrusted(userConfig, projectRoot)) {
    return blocked(
      title,
      [
        `Trust this project in Codex: open ${shownPath(projectRoot, env.home)} in Codex and accept the trust prompt (or set [projects.${quote(projectRoot)}] trust_level = "trusted" in ${shownPath(path.join(home, "config.toml"), env.home)}), then run jubarteai init again.`,
        "Until then Codex keeps its jubarteai MCP entry.",
      ],
      "project not trusted in Codex",
    );
  }
  const userSet = readTomlKeySafe(userConfig, NETWORK_TABLE, NETWORK_KEY) === true;
  const projectSet = projectConfig !== null && readTomlKeySafe(projectConfig, NETWORK_TABLE, NETWORK_KEY) === true;
  return { ok: true, alreadySet: userSet || projectSet };
}

function readTomlKeySafe(text: string, table: string, key: string): string | boolean | number | null {
  try {
    return readTomlKey(text, table, key);
  } catch {
    return null;
  }
}

function hooksFile(env: DetectEnv | InitCtx): string {
  return path.join(codexHome(env.home, env.env), "hooks.json");
}

/** The hook entries use the hook command (absolute when init resolved one). */
function hooksSpec(ctx: Pick<InitCtx, "cliCommand" | "hookCommand">): HooksEditSpec {
  return { events: CODEX_EVENTS, cliCommand: ctx.hookCommand ?? ctx.cliCommand, harness: ID };
}

function manual(title: string, lines: string[], reason: string, code?: string): ManualInstructions {
  return code === undefined ? { kind: "manual", harness: ID, title, lines, reason } : { kind: "manual", harness: ID, title, lines, reason, code };
}

/**
 * What hooks() makes of ~/.codex/hooks.json: a step that is already configured, a step with something to write
 * ("pending"), or instructions (a file it can't read or won't rewrite). Reads only.
 */
type HooksPlan = { kind: "configured" | "pending" } | { kind: "unreadable" } | { kind: "by-hand"; reason: string };

function hooksPlan(ctx: InitCtx): HooksPlan {
  const current = readSettings(hooksFile(ctx));
  if (current.status === "unreadable") return { kind: "unreadable" };
  if (current.status === "bad") return { kind: "by-hand", reason: current.reason };
  if (current.status === "missing") return { kind: "pending" };
  const spec = hooksSpec(ctx);
  if (mergeCommandHooks(structuredClone(current.doc), spec).conflict !== undefined) return { kind: "by-hand", reason: "hooks has an unexpected shape" };
  return { kind: inspectCommandHooks(current.doc, spec) === "configured" ? "configured" : "pending" };
}


async function detect(env: DetectEnv): Promise<boolean> {
  if (env.which("codex") !== null) return true;
  return fs.existsSync(codexHome(env.home, env.env));
}

async function hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
  const file = hooksFile(ctx);
  const spec = hooksSpec(ctx);
  const shown = shownPath(file, ctx.home);
  const plan = hooksPlan(ctx);
  if (plan.kind === "unreadable") return unreadableInstructions(ID, file, ctx.home, "Codex hooks");
  if (plan.kind === "by-hand") {
    return manual("Codex hooks", [`Edit ${shown} by hand and add these hooks:`, ...hooksPreview(spec).split("\n"), TRUST_INSTRUCTION], `${shown}: ${plan.reason}`);
  }
  return [hooksStep({ id: `${ID}:hooks`, label: `Add the JubarteAI session hooks to ${shown}`, file, home: ctx.home, spec, alreadyDone: plan.kind === "configured" })];
}

/**
 * The step that writes the network key into the project's config, with D6's commit-or-ignore choice. The choice is part
 * of the plan: with --yes or without a TTY nothing is asked and the file stays private (added to .gitignore); only an
 * interactive run asks "share it?" (default no). A file git already tracks has nothing to ignore and is not asked about.
 */
async function optInStep(ctx: InitCtx, projectRoot: string, alreadySet: boolean, deps: CodexDeps): Promise<PlanStep> {
  const file = path.join(projectRoot, ".codex", "config.toml");
  const gitignore = path.join(projectRoot, ".gitignore");
  const shown = shownPath(file, ctx.home);
  const id = `${ID}:network-optin`;
  const label = `Allow network access for jubarteai in Codex's sandbox (${shown})`;
  const tracked = alreadySet ? true : await deps.isTracked(projectRoot, ".codex/config.toml");
  const interactive = ctx.tty === true && ctx.yes !== true;
  const lines = [`${shown} (this project only):`, `[${NETWORK_TABLE}]`, `${NETWORK_KEY} = true`];
  if (!tracked) {
    lines.push(interactive ? "You will be asked whether to share this file with the repo; if not, it is added to .gitignore." : "Kept private: /.codex/config.toml is added to .gitignore.");
  }
  return {
    id,
    label,
    files: tracked ? [file] : [file, gitignore],
    sensitive: !alreadySet,
    preview: lines.join("\n"),
    flag: "--yes",
    async apply(): Promise<StepResult> {
      if (alreadySet) return { id, label, status: "already configured" };
      const share = tracked || (interactive && (await deps.ask("Share the Codex network setting with everyone who clones the repo?")));
      // The repo's own contents steer this path: a link out of the project (.codex -> ../.codex) is never followed.
      const result = editTomlFile(file, (text) => setTomlKey(text, NETWORK_TABLE, NETWORK_KEY, true), { createIfMissing: true, withinRoot: projectRoot });
      if (result.status === "refused") return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
      if (result.status === "missing") return { id, label, status: "failed", detail: "the file is missing" };
      if (!share) {
        try {
          ensureIgnoreBlock(gitignore, IGNORE_BLOCK);
        } catch {
          return { id, label, status: "failed", detail: "could not update .gitignore; add /.codex/config.toml to it, or commit the file" };
        }
      }
      return { id, label, status: result.status === "changed" ? "configured" : "already configured" };
    },
  };
}

async function extras(ctx: InitCtx, deps: CodexDeps): Promise<Array<PlanStep | ManualInstructions>> {
  const out: Array<PlanStep | ManualInstructions> = [];
  const optIn = await evaluateOptIn(ctx, ctx.projectRoot, deps);
  if (optIn.ok && ctx.projectRoot !== null) out.push(await optInStep(ctx, ctx.projectRoot, optIn.alreadySet, deps));
  else if (!optIn.ok) out.push(manual(optIn.manual.title, optIn.manual.lines, optIn.manual.reason, CODEX_CODES.networkManual));
  // Codex runs a hook only after the user trusts it once; there is no way to pre-trust. Said only when hooks() has
  // something to write (its instructions for a file it won't rewrite already carry the line; a configured one was trusted before).
  if (hooksPlan(ctx).kind === "pending") {
    out.push(manual("Trust the Codex hooks", [TRUST_INSTRUCTION], "Codex runs a new or changed hook only after you trust it (no way to pre-trust)", CODEX_CODES.trustHooks));
  }
  return out;
}

async function inspect(ctx: InitCtx, deps: CodexDeps): Promise<AdapterState> {
  const found = await findMcpEntries(ID, { home: ctx.home, projectRoot: ctx.projectRoot, platform: ctx.platform, env: ctx.env });
  const optIn = await evaluateOptIn(ctx, ctx.projectRoot, deps);
  // The user-level entry is a leftover only where this project's opt-in is in effect (mcpCleanup's keepUser rule);
  // anywhere else it is the entry Codex uses on purpose (D5), which init never removes.
  const userFile = path.resolve(path.join(codexHome(ctx.home, ctx.env), "config.toml"));
  const mcpEntries = optIn.ok && optIn.alreadySet ? found : found.filter((file) => path.resolve(file) !== userFile);
  const notes: string[] = [];
  const file = hooksFile(ctx);
  const current = readSettings(file);
  let hooksState: AdapterState["hooks"] = "missing";
  if (current.status === "unreadable") {
    notes.push(`${shownPath(file, ctx.home)} could not be read: fix its permissions`);
    hooksState = "manual";
  } else if (current.status === "bad") {
    notes.push(`${shownPath(file, ctx.home)}: ${current.reason}; edit it by hand`);
    hooksState = "manual";
  } else if (current.status === "ok") {
    hooksState = inspectCommandHooks(current.doc, hooksSpec(ctx));
  }
  if (hooksState === "configured" || hooksState === "partial") notes.push(TRUST_INSTRUCTION);
  const userConfig = readText(path.join(codexHome(ctx.home, ctx.env), "config.toml"));
  if (userConfig !== null && readTomlKeySafe(userConfig, "features", "hooks") === false) notes.push("Codex hooks are turned off ([features] hooks = false)");
  if (optIn.ok) {
    if (!optIn.alreadySet) notes.push("the network opt-in is not written yet: run jubarteai init");
  } else {
    notes.push(`network opt-in: ${optIn.manual.reason}; Codex keeps its jubarteai MCP entry`);
  }
  return { permission: "n/a", hooks: hooksState, mcpEntries, notes };
}

/** What is printed for the user-level entry: one project's opt-in must not break every other Codex project (D5). */
const KEEP_USER_ENTRY = "other Codex projects still use it; remove it by hand once every project you use has the network opt-in";

/** Whether this project's network opt-in is in place and effective (D5), read now. */
async function optInInEffect(scope: CleanupScope, deps: CodexDeps): Promise<boolean> {
  const env: DetectEnv = {
    home: scope.home,
    env: scope.env ?? process.env,
    platform: scope.platform,
    which: (cmd) => (cmd === "codex" ? "codex" : null),
  };
  const optIn = await evaluateOptIn(env, scope.projectRoot, deps);
  return optIn.ok && optIn.alreadySet;
}

/**
 * A project's own Codex entry goes only once that project's network opt-in is in place (D5): until then its shell can't
 * reach the CLI. The user-level entry is never removed because of one project's opt-in; see mcpCleanup.
 */
function cleanupGate(scope: CleanupScope, deps: CodexDeps): CleanupGate {
  return async () => ((await optInInEffect(scope, deps)) ? null : "kept: Codex keeps its jubarteai MCP entry until its network opt-in is in place");
}

function isKeptUserEntry(item: PlanStep | ManualInstructions): item is ManualInstructions {
  return "kind" in item && item.kind === "manual" && item.reason === KEEP_USER_ENTRY;
}

/**
 * The cleanup steps, with the user-level entry never offered for removal. It is reported (KEEP_USER_ENTRY, code
 * keptUser) only where this project's network opt-in is in effect, so the entry is redundant here; anywhere else it is
 * the entry Codex uses (init's D5 fallback writes it on purpose), and saying so on every run would only nag.
 */
async function mcpCleanup(scope: CleanupScope, deps: CodexDeps): Promise<Array<PlanStep | ManualInstructions>> {
  const items = await mcpCleanupFor(ID, scope, { gate: cleanupGate(scope, deps), keepUser: KEEP_USER_ENTRY });
  if (!items.some(isKeptUserEntry)) return items;
  const inEffect = await optInInEffect(scope, deps);
  return items.flatMap((item): Array<PlanStep | ManualInstructions> => (isKeptUserEntry(item) ? (inEffect ? [{ ...item, code: CODEX_CODES.keptUser }] : []) : [item]));
}

/** A Codex adapter with its machine-facing parts injected (tests); `codexAdapter` is the production one. */
export function createCodexAdapter(overrides: Partial<CodexDeps> = {}): HarnessAdapter {
  const deps: CodexDeps = { ...defaultDeps, ...overrides };
  return {
    id: ID,
    label: "Codex CLI",
    skillAgent: "codex",
    sessionVar: null,
    promptInjection: true,
    detect,
    async permission() {
      return null;
    },
    hooks,
    inspect: (ctx) => inspect(ctx, deps),
    mcpCleanup: (scope) => mcpCleanup(scope, deps),
    extras: (ctx) => extras(ctx, deps),
  };
}

export const codexAdapter: HarnessAdapter = createCodexAdapter();
