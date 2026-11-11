// Gemini CLI adapter (spec §9). Verified cells only: the `run_shell_command(jubarteai)` allow entry and the
// SessionStart / BeforeAgent / SessionEnd hooks, both in ~/.gemini/settings.json. The Windows hook shell is
// unverified, so there the hooks are printed instructions (D25). install.sh never wrote a Gemini MCP entry,
// so there is nothing to clean. Every write goes through editJsonFile (I6); the reads here are read-only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_TOTAL_BUDGET_MS } from "../constants.js";
import { editJsonFile, readJsonObject, type JsonEditResult } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "gemini-cli" as const;
const SETTINGS_FILE = "settings.json";
const SHELL_TOOL_ENTRY = "run_shell_command(jubarteai)";
const HOOK_NAME = "jubarteai";
/** Gemini's `timeout` is in milliseconds. session-end is not awaited by Gemini, so it only needs to be quick. */
const SESSION_END_TIMEOUT_MS = 1_000;

/** Gemini's own event names, and the CLI hook event each one runs. */
const EVENTS: ReadonlyArray<{ gemini: string; event: HookEvent; timeoutMs: number }> = [
  { gemini: "SessionStart", event: "session-start", timeoutMs: HOOK_TOTAL_BUDGET_MS },
  { gemini: "BeforeAgent", event: "user-prompt-submit", timeoutMs: HOOK_TOTAL_BUDGET_MS },
  { gemini: "SessionEnd", event: "session-end", timeoutMs: SESSION_END_TIMEOUT_MS },
];

type HookEvent = "session-start" | "user-prompt-submit" | "session-end";
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

function hookCommand(cliCommand: string, event: HookEvent): string {
  return `${cliCommand} hook ${event} --harness ${HARNESS}`;
}

function hookEntry(cliCommand: string, event: HookEvent, timeoutMs: number): Obj {
  return { name: HOOK_NAME, type: "command", command: hookCommand(cliCommand, event), timeout: timeoutMs };
}

/** What a failed edit says, in fixed words. */
function resultOf(id: string, label: string, edit: JsonEditResult, blocked: string | null): StepResult {
  if (blocked !== null) return { id, label, status: "skipped", detail: blocked };
  if (edit.status === "changed") return { id, label, status: "configured" };
  if (edit.status === "unchanged") return { id, label, status: "already configured" };
  return { id, label, status: "failed", detail: `could not write (${edit.reason ?? edit.status})` };
}

/** The settings file as read-only facts: absent, plain JSON, or something the CLI will not rewrite. */
function readSettings(file: string): { status: "missing" } | { status: "ok"; doc: Obj } | { status: "unwritable" } {
  const read = readJsonObject(file);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "ok") return { status: "ok", doc: read.doc };
  return { status: "unwritable" };
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

/** Add the allow entry. Returns true when the document changed; sets `blocked` when its shape is not one we can merge into. */
function addPermission(doc: Obj, blocked: { reason: string | null }): boolean {
  const list = allowedList(doc);
  if (list === "bad") {
    blocked.reason = "tools.allowed in settings.json is not a list; add the entry by hand";
    return false;
  }
  if (list !== "absent") {
    if (list.includes(SHELL_TOOL_ENTRY)) return false;
    list.push(SHELL_TOOL_ENTRY);
    return true;
  }
  const tools = isObject(doc["tools"]) ? doc["tools"] : {};
  tools["allowed"] = [SHELL_TOOL_ENTRY];
  doc["tools"] = tools;
  return true;
}

/** True when this event's groups already hold exactly our command. */
function hasHook(groups: unknown, command: string): boolean {
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => {
    if (!isObject(group) || !Array.isArray(group["hooks"])) return false;
    return group["hooks"].some((h) => isObject(h) && h["command"] === command);
  });
}

/** Add our three hooks, leaving every other key and every other hook alone. */
function addHooks(doc: Obj, cliCommand: string, blocked: { reason: string | null }): boolean {
  const hooksValue = doc["hooks"];
  if (hooksValue !== undefined && !isObject(hooksValue)) {
    blocked.reason = "hooks in settings.json is not an object; add the entries by hand";
    return false;
  }
  const hooks: Obj = hooksValue ?? {};
  for (const { gemini } of EVENTS) {
    const groups = hooks[gemini];
    if (groups !== undefined && !Array.isArray(groups)) {
      blocked.reason = `hooks.${gemini} in settings.json is not a list; add the entries by hand`;
      return false;
    }
  }
  let changed = false;
  for (const { gemini, event, timeoutMs } of EVENTS) {
    const existing = hooks[gemini];
    const groups: unknown[] = Array.isArray(existing) ? existing : [];
    if (hasHook(groups, hookCommand(cliCommand, event))) continue;
    groups.push({ matcher: "", hooks: [hookEntry(cliCommand, event, timeoutMs)] });
    hooks[gemini] = groups;
    changed = true;
  }
  if (changed) doc["hooks"] = hooks;
  return changed;
}

function hooksJson(cliCommand: string): string[] {
  const hooks: Obj = {};
  for (const { gemini, event, timeoutMs } of EVENTS) hooks[gemini] = [{ matcher: "", hooks: [hookEntry(cliCommand, event, timeoutMs)] }];
  return JSON.stringify({ hooks }, null, 2).split("\n");
}

function permissionStep(file: string): PlanStep {
  const id = `${HARNESS}:permission`;
  const label = "Gemini CLI: allow the jubarteai command";
  return {
    id,
    label,
    files: [file],
    sensitive: true,
    preview: `${file}\n  tools.allowed += "${SHELL_TOOL_ENTRY}"`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const blocked: { reason: string | null } = { reason: null };
      const edit = editJsonFile(file, (doc) => addPermission(doc, blocked), { createIfMissing: true, withinHome: true });
      return resultOf(id, label, edit, blocked.reason);
    },
  };
}

function hooksStep(file: string, cliCommand: string): PlanStep {
  const id = `${HARNESS}:hooks`;
  const label = "Gemini CLI: session hooks";
  return {
    id,
    label,
    files: [file],
    sensitive: true,
    preview: `${file}\n${EVENTS.map((e) => `  hooks.${e.gemini}: ${hookCommand(cliCommand, e.event)}`).join("\n")}`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const blocked: { reason: string | null } = { reason: null };
      const edit = editJsonFile(file, (doc) => addHooks(doc, cliCommand, blocked), { createIfMissing: true, withinHome: true });
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
    if (readSettings(file).status === "unwritable") {
      return manualSettings(file, "Gemini CLI: allow the jubarteai command", ['  "tools": { "allowed": ["' + SHELL_TOOL_ENTRY + '"] }', "(merge it into the existing tools.allowed list)"], UNWRITABLE);
    }
    return permissionStep(file);
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    const file = settingsPath(ctx.home);
    if (ctx.platform === "win32") {
      return manualSettings(file, "Gemini CLI: session hooks", [...hooksJson(ctx.cliCommand), "(merge it into the existing hooks key)"], "the shell Gemini CLI runs hooks with on Windows is not verified (D25)");
    }
    if (readSettings(file).status === "unwritable") {
      return manualSettings(file, "Gemini CLI: session hooks", [...hooksJson(ctx.cliCommand), "(merge it into the existing hooks key)"], UNWRITABLE);
    }
    return [hooksStep(file, ctx.cliCommand)];
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const read = readSettings(settingsPath(ctx.home));
    if (read.status === "unwritable") {
      return { permission: "manual", hooks: "manual", mcpEntries: [], notes: ["settings.json has comments or is not plain JSON; check it by hand"] };
    }
    const doc: Obj = read.status === "ok" ? read.doc : {};
    const list = allowedList(doc);
    const permission = Array.isArray(list) && list.includes(SHELL_TOOL_ENTRY) ? "configured" : "missing";
    const hooksValue = doc["hooks"];
    const present = EVENTS.filter(({ gemini, event }) => isObject(hooksValue) && hasHook(hooksValue[gemini], hookCommand(ctx.cliCommand, event))).length;
    const hooks = present === EVENTS.length ? "configured" : present === 0 ? "missing" : "partial";
    const notes: string[] = [];
    const config = doc["hooksConfig"];
    if (isObject(config) && config["enabled"] === false) notes.push("hooksConfig.enabled is false in settings.json, so Gemini CLI skips every hook");
    return { permission, hooks, mcpEntries: [], notes };
  },

  // install.sh never wrote a Gemini MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
