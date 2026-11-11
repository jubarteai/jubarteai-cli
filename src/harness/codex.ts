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
import { editTomlFile, readTomlKey, setTomlKey } from "../safe-edit/toml-edit.js";
import { readConfigText } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { HOOK_EVENTS, hooksPreview, readSettings, hooksStep, inspectCommandHooks, mergeCommandHooks, type HookEventSpec, type HooksEditSpec } from "./claude-code.js";
import { codexHome, findMcpEntries, isUnderHome, mcpCleanupFor, shownPath, type CleanupGate } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const ID = "codex";
/** The Codex version that honours `[sandbox_workspace_write] network_access` in a project config (proof P1, spec §6.1). */
export const CODEX_NETWORK_MIN_VERSION = "0.162.1";
const VERSION_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
const NETWORK_TABLE = "sandbox_workspace_write";
const NETWORK_KEY = "network_access";
const TRUST_INSTRUCTION = "Trust the new hooks once in Codex: run /hooks";
/** SessionEnd gets one second from Codex by default and three at most. */
const SESSION_END_TIMEOUT_SECONDS = 3;
const IGNORE_BLOCK: readonly string[] = ["# jubarteai: private Codex network setting", "/.codex/config.toml"];

/** The hook events with Codex's SessionEnd limit. */
const CODEX_EVENTS: readonly HookEventSpec[] = HOOK_EVENTS.map((e) => (e.name === "SessionEnd" ? { ...e, timeoutSeconds: SESSION_END_TIMEOUT_SECONDS } : e));

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
  if (userConfig !== null && readTomlKeySafe(userConfig, NETWORK_TABLE, NETWORK_KEY) === true) return { ok: true, alreadySet: true };
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
  const set = projectConfig !== null && readTomlKeySafe(projectConfig, NETWORK_TABLE, NETWORK_KEY) === true;
  return { ok: true, alreadySet: set };
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

function hooksSpec(ctx: { cliCommand: string }): HooksEditSpec {
  return { events: CODEX_EVENTS, cliCommand: ctx.cliCommand, harness: ID };
}

function manual(title: string, lines: string[], reason: string): ManualInstructions {
  return { kind: "manual", harness: ID, title, lines, reason };
}


async function detect(env: DetectEnv): Promise<boolean> {
  if (env.which("codex") !== null) return true;
  return fs.existsSync(codexHome(env.home, env.env));
}

async function hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
  const file = hooksFile(ctx);
  const spec = hooksSpec(ctx);
  const shown = shownPath(file, ctx.home);
  const current = readSettings(file);
  const byHand = (reason: string): ManualInstructions =>
    manual("Codex hooks", [`Edit ${shown} by hand and add these hooks:`, ...hooksPreview(spec).split("\n"), TRUST_INSTRUCTION], `${shown}: ${reason}`);
  if (current.status === "bad") return byHand(current.reason);
  if (current.status === "ok" && mergeCommandHooks(structuredClone(current.doc), spec).conflict !== undefined) return byHand("hooks has an unexpected shape");
  const done = current.status === "ok" && inspectCommandHooks(current.doc, spec) === "configured";
  return [hooksStep({ id: `${ID}:hooks`, label: `Add the JubarteAI session hooks to ${shown}`, file, home: ctx.home, spec, alreadyDone: done })];
}

/** The step that writes the network key into the project's config, with D6's commit-or-ignore choice. */
function optInStep(ctx: InitCtx, projectRoot: string, alreadySet: boolean, deps: CodexDeps): PlanStep {
  const file = path.join(projectRoot, ".codex", "config.toml");
  const shown = shownPath(file, ctx.home);
  const id = `${ID}:network-optin`;
  const label = `Allow network access for jubarteai in Codex's sandbox (${shown})`;
  const withinHome = isUnderHome(file, ctx.home);
  return {
    id,
    label,
    files: [file],
    sensitive: !alreadySet,
    preview: `${shown} (this project only):\n[${NETWORK_TABLE}]\n${NETWORK_KEY} = true`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      if (alreadySet) return { id, label, status: "already configured" };
      // D6: committed or gitignored, asked like the binding; private unless the answer is yes (and when git already tracks the file there is nothing to ask).
      const tracked = await deps.isTracked(projectRoot, ".codex/config.toml");
      const share = tracked || (await deps.ask("Share the Codex network setting with everyone who clones the repo?"));
      const result = editTomlFile(file, (text) => setTomlKey(text, NETWORK_TABLE, NETWORK_KEY, true), { createIfMissing: true, withinHome });
      if (result.status === "refused") return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
      if (result.status === "missing") return { id, label, status: "failed", detail: "the file is missing" };
      if (!share) {
        try {
          ensureIgnoreBlock(path.join(projectRoot, ".gitignore"), IGNORE_BLOCK);
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
  if (optIn.ok && ctx.projectRoot !== null) out.push(optInStep(ctx, ctx.projectRoot, optIn.alreadySet, deps));
  else if (!optIn.ok) out.push({ kind: "manual", harness: ID, ...optIn.manual });
  // Codex runs a hook only after the user trusts it once; there is no way to pre-trust.
  const current = readSettings(hooksFile(ctx));
  const trusted = current.status === "ok" && inspectCommandHooks(current.doc, hooksSpec(ctx)) === "configured";
  if (!trusted) out.push(manual("Trust the Codex hooks", [TRUST_INSTRUCTION], "Codex runs a new or changed hook only after you trust it (no way to pre-trust)"));
  return out;
}

async function inspect(ctx: InitCtx, deps: CodexDeps): Promise<AdapterState> {
  const mcpEntries = await findMcpEntries(ID, { home: ctx.home, projectRoot: ctx.projectRoot, platform: ctx.platform, env: ctx.env });
  const notes: string[] = [];
  const file = hooksFile(ctx);
  const current = readSettings(file);
  let hooksState: AdapterState["hooks"] = "missing";
  if (current.status === "bad") {
    notes.push(`${shownPath(file, ctx.home)}: ${current.reason}; edit it by hand`);
    hooksState = "manual";
  } else if (current.status === "ok") {
    hooksState = inspectCommandHooks(current.doc, hooksSpec(ctx));
  }
  if (hooksState === "configured" || hooksState === "partial") notes.push(TRUST_INSTRUCTION);
  const userConfig = readText(path.join(codexHome(ctx.home, ctx.env), "config.toml"));
  if (userConfig !== null && readTomlKeySafe(userConfig, "features", "hooks") === false) notes.push("Codex hooks are turned off ([features] hooks = false)");
  const optIn = await evaluateOptIn(ctx, ctx.projectRoot, deps);
  if (optIn.ok) {
    if (!optIn.alreadySet) notes.push("the network opt-in is not written yet: run jubarteai init");
  } else {
    notes.push(`network opt-in: ${optIn.manual.reason}; Codex keeps its jubarteai MCP entry`);
  }
  return { permission: "n/a", hooks: hooksState, mcpEntries, notes };
}

/** Codex's entry goes only once the network opt-in is in place (D5): until then its shell can't reach the CLI. */
function cleanupGate(scope: CleanupScope, deps: CodexDeps): CleanupGate {
  return async () => {
    const env: DetectEnv = {
      home: scope.home,
      env: scope.env ?? process.env,
      platform: scope.platform,
      which: (cmd) => (cmd === "codex" ? "codex" : null),
    };
    const optIn = await evaluateOptIn(env, scope.projectRoot, deps);
    return optIn.ok && optIn.alreadySet ? null : "kept: Codex keeps its jubarteai MCP entry until its network opt-in is in place";
  };
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
    mcpCleanup: (scope) => mcpCleanupFor(ID, scope, { gate: cleanupGate(scope, deps) }),
    extras: (ctx) => extras(ctx, deps),
  };
}

export const codexAdapter: HarnessAdapter = createCodexAdapter();
