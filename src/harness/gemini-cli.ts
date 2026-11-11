// Gemini CLI adapter (spec §9). Verified cells only: the `run_shell_command(jubarteai <command>)` allow entries and the
// SessionStart / BeforeAgent / SessionEnd hooks, both in ~/.gemini/settings.json. The allow list names the agent
// commands one by one (Gemini matches a shell command by prefix on word boundaries) and never the person commands
// (login, logout, link, init, update), so an agent can't run those without a prompt (spec I6, review R-M1); the exact
// bare entry `run_shell_command(jubarteai)` an earlier version wrote is removed. The Windows hook shell is
// unverified, so there the hooks are printed instructions (D25). install.sh never wrote a Gemini MCP entry,
// so there is nothing to clean. Every write goes through editJsonFile (I6); the reads here are read-only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_REGISTERED_TIMEOUT_S } from "../constants.js";
import { editJsonFile, readJsonObject, type JsonEditResult } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { AGENT_COMMANDS } from "./agent-commands.js";
import { hookCommand as commandFor, hooksPreview, inspectCommandHooks, mergeCommandHooks, type HookEventSpec, type HooksEditSpec } from "./claude-code.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "gemini-cli" as const;
const SETTINGS_FILE = "settings.json";
/** One allow entry per agent command; a person command is never listed. */
const SHELL_TOOL_ENTRIES: readonly string[] = AGENT_COMMANDS.map((command) => `run_shell_command(jubarteai ${command})`);
/** Written by an earlier unreleased version: it pre-approves every jubarteai command, the person commands included. */
const LEGACY_SHELL_TOOL_ENTRY = "run_shell_command(jubarteai)";
const PERMISSION_LABEL = "Gemini CLI: allow the jubarteai agent commands";
const HOOK_NAME = "jubarteai";
/** Gemini's `timeout` is in milliseconds. session-end is not awaited by Gemini, so it only needs to be quick. */
const REGISTERED_TIMEOUT_MS = HOOK_REGISTERED_TIMEOUT_S * 1000;
const SESSION_END_TIMEOUT_MS = 1_000;

/** Gemini's own event names (`name`), the CLI hook event each one runs (`arg`), and its timeout in milliseconds. */
const EVENTS: readonly HookEventSpec[] = [
  { name: "SessionStart", arg: "session-start", timeout: REGISTERED_TIMEOUT_MS },
  { name: "BeforeAgent", arg: "user-prompt-submit", timeout: REGISTERED_TIMEOUT_MS },
  { name: "SessionEnd", arg: "session-end", timeout: SESSION_END_TIMEOUT_MS },
];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function geminiDir(home: string): string {
  return join(home, ".gemini");
}

function settingsPath(home: string): string {
  return join(geminiDir(home), SETTINGS_FILE);
}

/**
 * The hook set for `program` (InitCtx.hookCommand ?? cliCommand): each entry named "jubarteai", each new event group
 * with an empty matcher. An entry of ours is found by its `hook <event> --harness gemini-cli` suffix, so another
 * program path updates it in place (mergeCommandHooks).
 */
function hooksSpec(ctx: Pick<InitCtx, "cliCommand" | "hookCommand">): HooksEditSpec {
  return { events: EVENTS, cliCommand: ctx.hookCommand ?? ctx.cliCommand, harness: HARNESS, extra: { name: HOOK_NAME }, group: { matcher: "" } };
}

/** What a failed edit says, in fixed words. */
function resultOf(id: string, label: string, edit: JsonEditResult, blocked: string | null): StepResult {
  if (blocked !== null) return { id, label, status: "skipped", detail: blocked };
  if (edit.status === "changed") return { id, label, status: "configured" };
  if (edit.status === "unchanged") return { id, label, status: "already configured" };
  return { id, label, status: "failed", detail: `could not write (${edit.reason ?? edit.status})` };
}

/** The settings file as read-only facts: absent, plain JSON, or something the CLI will not rewrite. */
function readSettings(file: string): { status: "missing" } | { status: "ok"; doc: Obj } | { status: "unwritable" } | { status: "unreadable" } {
  try {
    const read = readJsonObject(file);
    if (read.status === "missing") return { status: "missing" };
    if (read.status === "ok") return { status: "ok", doc: read.doc };
    return { status: "unwritable" };
  } catch {
    // No permission to read it (a root-owned file left by sudo): never mistaken for a missing file.
    return { status: "unreadable" };
  }
}

function manualUnreadable(file: string, title: string): ManualInstructions {
  return { kind: "manual", harness: HARNESS, title, lines: [`Couldn't read ${file}: fix its permissions, then run init again.`], reason: "the settings file is not readable by this user" };
}

function manualSettings(file: string, title: string, entryLines: string[], why: string): ManualInstructions {
  return {
    kind: "manual",
    harness: HARNESS,
    title,
    lines: [`Open ${file} and add:`, ...entryLines],
    reason: why,
  };
}

const UNWRITABLE = "settings.json has comments or is not plain JSON, so it is not rewritten";

function allowedList(doc: Obj): unknown[] | "absent" | "bad" {
  const tools = doc["tools"];
  if (tools === undefined) return "absent";
  if (!isObject(tools)) return "bad";
  const allowed = tools["allowed"];
  if (allowed === undefined) return "absent";
  return Array.isArray(allowed) ? allowed : "bad";
}

/** Whether `list` holds every allow entry we write. */
function hasAllEntries(list: unknown[]): boolean {
  return SHELL_TOOL_ENTRIES.every((entry) => list.includes(entry));
}

/**
 * Add the missing allow entries (never removing a user's own) and drop the legacy bare entry. Returns true when the
 * document changed; sets `blocked` when its shape is not one we can merge into.
 */
function addPermission(doc: Obj, blocked: { reason: string | null }): boolean {
  const list = allowedList(doc);
  if (list === "bad") {
    blocked.reason = "tools.allowed in settings.json is not a list; add the entries by hand";
    return false;
  }
  if (list !== "absent") {
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === LEGACY_SHELL_TOOL_ENTRY) {
        list.splice(i, 1);
        changed = true;
      }
    }
    for (const entry of SHELL_TOOL_ENTRIES) {
      if (list.includes(entry)) continue;
      list.push(entry);
      changed = true;
    }
    return changed;
  }
  const tools = isObject(doc["tools"]) ? doc["tools"] : {};
  tools["allowed"] = [...SHELL_TOOL_ENTRIES];
  doc["tools"] = tools;
  return true;
}

/** Add or update our three hooks, leaving every other key and every other hook alone. */
function addHooks(doc: Obj, spec: HooksEditSpec, blocked: { reason: string | null }): boolean {
  const merged = mergeCommandHooks(doc, spec);
  if (merged.conflict !== undefined) {
    blocked.reason = `${merged.conflict} in settings.json; add the entries by hand`;
    return false;
  }
  return merged.changed;
}

function hooksJson(spec: HooksEditSpec): string[] {
  return hooksPreview(spec).split("\n");
}

function permissionStep(file: string, done: boolean, legacy: boolean): PlanStep {
  const id = `${HARNESS}:permission`;
  const label = PERMISSION_LABEL;
  return {
    id,
    label,
    files: [file],
    sensitive: !done,
    preview: [
      file,
      `  tools.allowed += ${SHELL_TOOL_ENTRIES.map((e) => `"${e}"`).join(", ")}`,
      "  (login, logout, link, init and update are left out: they ask first)",
      ...(legacy ? [`  tools.allowed -= "${LEGACY_SHELL_TOOL_ENTRY}" (it also pre-approves those five)`] : []),
    ].join("\n"),
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const blocked: { reason: string | null } = { reason: null };
      const edit = editJsonFile(file, (doc) => addPermission(doc, blocked), { createIfMissing: true, withinHome: true });
      return resultOf(id, label, edit, blocked.reason);
    },
  };
}

function hooksStep(file: string, spec: HooksEditSpec, done: boolean): PlanStep {
  const id = `${HARNESS}:hooks`;
  const label = "Gemini CLI: session hooks";
  return {
    id,
    label,
    files: [file],
    sensitive: !done,
    preview: `${file}\n${EVENTS.map((e) => `  hooks.${e.name}: ${commandFor(spec.cliCommand, e.arg, HARNESS)}`).join("\n")}`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const blocked: { reason: string | null } = { reason: null };
      const edit = editJsonFile(file, (doc) => addHooks(doc, spec, blocked), { createIfMissing: true, withinHome: true });
      return resultOf(id, label, edit, blocked.reason);
    },
  };
}

export const geminiCliAdapter: HarnessAdapter = {
  id: HARNESS,
  label: "Gemini CLI",
  skillAgent: "gemini-cli",
  // Hooks get GEMINI_SESSION_ID, but the agent's shell commands do not: the identity line's --agent is the path.
  sessionVar: null,
  promptInjection: true,

  async detect(env: DetectEnv): Promise<boolean> {
    return env.which("gemini") !== null || existsSync(geminiDir(env.home));
  },

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    const file = settingsPath(ctx.home);
    const settings = readSettings(file);
    if (settings.status === "unreadable") return manualUnreadable(file, PERMISSION_LABEL);
    if (settings.status === "unwritable") {
      return manualSettings(
        file,
        PERMISSION_LABEL,
        [...JSON.stringify({ tools: { allowed: SHELL_TOOL_ENTRIES } }, null, 2).split("\n"), "(merge it into the existing tools.allowed list)", `(and remove "${LEGACY_SHELL_TOOL_ENTRY}" if it is there: it also pre-approves login, logout, link, init and update)`],
        UNWRITABLE,
      );
    }
    const list = settings.status === "ok" ? allowedList(settings.doc) : "absent";
    const legacy = Array.isArray(list) && list.includes(LEGACY_SHELL_TOOL_ENTRY);
    return permissionStep(file, Array.isArray(list) && hasAllEntries(list) && !legacy, legacy);
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    const file = settingsPath(ctx.home);
    const spec = hooksSpec(ctx);
    if (ctx.platform === "win32") {
      return manualSettings(file, "Gemini CLI: session hooks", [...hooksJson(spec), "(merge it into the existing hooks key)"], "the shell Gemini CLI runs hooks with on Windows is not verified (D25)");
    }
    const settings = readSettings(file);
    if (settings.status === "unreadable") return manualUnreadable(file, "Gemini CLI: session hooks");
    if (settings.status === "unwritable") {
      return manualSettings(file, "Gemini CLI: session hooks", [...hooksJson(spec), "(merge it into the existing hooks key)"], UNWRITABLE);
    }
    return [hooksStep(file, spec, settings.status === "ok" && inspectCommandHooks(settings.doc, spec) === "configured")];
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const read = readSettings(settingsPath(ctx.home));
    if (read.status === "unreadable") {
      return { permission: "manual", hooks: "manual", mcpEntries: [], notes: [`couldn't read ${settingsPath(ctx.home)}: fix its permissions`] };
    }
    if (read.status === "unwritable") {
      return { permission: "manual", hooks: "manual", mcpEntries: [], notes: ["settings.json has comments or is not plain JSON; check it by hand"] };
    }
    const doc: Obj = read.status === "ok" ? read.doc : {};
    const list = allowedList(doc);
    const permission = Array.isArray(list) && hasAllEntries(list) ? "configured" : "missing";
    const hooks = inspectCommandHooks(doc, hooksSpec(ctx));
    const notes: string[] = [];
    if (Array.isArray(list) && list.includes(LEGACY_SHELL_TOOL_ENTRY)) {
      notes.push(`tools.allowed holds "${LEGACY_SHELL_TOOL_ENTRY}", which also pre-approves login, logout, link, init and update; run init again to replace it`);
    }
    const config = doc["hooksConfig"];
    if (isObject(config) && config["enabled"] === false) notes.push("hooksConfig.enabled is false in settings.json, so Gemini CLI skips every hook");
    return { permission, hooks, mcpEntries: [], notes };
  },

  // install.sh never wrote a Gemini MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
