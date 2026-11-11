// Cursor adapter (spec §9). Verified cells only:
//   - permission: none written. Cursor's `Shell(<commandBase>)` rule (CLI: ~/.cursor/cli-config.json permissions.allow) matches
//     only the program name, so `Shell(jubarteai)` would also pre-approve login, logout, link, init and update, and no
//     entry can exclude them (spec I6, review R-M1). The person gets printed instructions that say so and approves
//     jubarteai commands as Cursor asks; the IDE's shell allowlist is unverified anyway (D25).
//   - hooks: ~/.cursor/hooks.json `sessionStart` / `sessionEnd` only. `beforeSubmitPrompt` has no context output,
//     so there is no per-prompt hook (promptInjection false).
//   - MCP cleanup: ~/.cursor/mcp.json and .cursor/mcp.json (`mcpServers.jubarteai`), install.sh's two paths, through
//     mcp-cleanup.ts (C6a).
// Every write goes through editJsonFile (I6). This file also holds the small JSON-config helpers the VS Code, Windsurf
// and Zed adapters share (jsonEditStep, readable, manual, hookCommand, mergeFlatHook), so the four stay one idiom.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_REGISTERED_TIMEOUT_S } from "../constants.js";
import { editJsonFile, readJsonObject } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import type { HarnessId } from "../session/harness-env.js";
import { isOurHookCommand } from "./claude-code.js";
import { findMcpEntries, mcpCleanupFor } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

export type Obj = Record<string, unknown>;
export type HookEvent = "session-start" | "user-prompt-submit" | "session-end";

export function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What an edit callback decided: it changed the document, found nothing to do, or cannot merge into the shape it found. */
export type EditOutcome = "changed" | "same" | { blocked: string };

/** Whether this config file is plain JSON the CLI may rewrite (or absent). A read that throws counts as not writable. */
export function readable(file: string): { status: "missing" } | { status: "ok"; doc: Obj } | { status: "unwritable" } {
  try {
    const read = readJsonObject(file);
    if (read.status === "missing") return { status: "missing" };
    if (read.status === "ok") return { status: "ok", doc: read.doc };
  } catch {
    // unreadable (permissions): not writable either
  }
  return { status: "unwritable" };
}

/** True when the file is plain JSON that `edit` would leave as it is (a dry run on a copy; nothing is written). */
function alreadyInPlace(file: string, edit: (doc: Obj) => EditOutcome): boolean {
  const current = readable(file);
  return current.status === "ok" && edit(structuredClone(current.doc)) === "same";
}

/**
 * A step that edits one JSON file through editJsonFile. `edit` mutates the document and says what it did.
 * The step is sensitive (asks first) only while there is something to write: when the entry is already in place it is
 * non-sensitive and reports "already configured", so re-running init never prompts (spec §6.1).
 */
export function jsonEditStep(o: {
  id: string;
  label: string;
  file: string;
  preview: string;
  createIfMissing: boolean;
  edit: (doc: Obj) => EditOutcome;
}): PlanStep {
  return {
    id: o.id,
    label: o.label,
    files: [o.file],
    sensitive: !alreadyInPlace(o.file, o.edit),
    preview: `${o.file}\n${o.preview}`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const decided: { outcome: EditOutcome } = { outcome: "same" };
      const edit = editJsonFile(
        o.file,
        (doc) => {
          decided.outcome = o.edit(doc);
          return decided.outcome === "changed";
        },
        { createIfMissing: o.createIfMissing, withinHome: true },
      );
      if (typeof decided.outcome === "object") return { id: o.id, label: o.label, status: "skipped", detail: decided.outcome.blocked };
      if (edit.status === "changed") return { id: o.id, label: o.label, status: "configured" };
      if (edit.status === "unchanged") return { id: o.id, label: o.label, status: "already configured" };
      return { id: o.id, label: o.label, status: "failed", detail: `could not write (${edit.reason ?? edit.status})` };
    },
  };
}

/** The cleanup scope an inspect() call reads from: the same home, project root and environment init uses. */
export function cleanupScopeOf(ctx: InitCtx): CleanupScope {
  return { home: ctx.home, projectRoot: ctx.projectRoot, platform: ctx.platform, env: ctx.env };
}

export function manual(harness: HarnessId, title: string, lines: string[], reason: string): ManualInstructions {
  return { kind: "manual", harness, title, lines, reason };
}

/** The `hook` command a harness runs for one event. */
export function hookCommand(cliCommand: string, event: HookEvent, harness: HarnessId): string {
  return `${cliCommand} hook ${event} --harness ${harness}`;
}

/** The program part of a registered hook: the absolute command init resolved, else the bare name. Never for a permission rule or prose. */
export function hookProgram(ctx: Pick<InitCtx, "cliCommand" | "hookCommand">): string {
  return ctx.hookCommand ?? ctx.cliCommand;
}

/** The entries of a flat hook list (Cursor's, Copilot's: `[{ command, … }]`) that are ours for this event and harness. */
function oursIn(entries: unknown[], event: HookEvent, harness: HarnessId): Obj[] {
  return entries.filter((e): e is Obj => isObject(e) && typeof e["command"] === "string" && isOurHookCommand(e["command"], event, harness));
}

/**
 * Put `wanted` into a flat hook list for one event: appended when none of ours is there, else written over our first
 * entry (another program path after a Node upgrade, another timeout) with any further copies of ours dropped. Other
 * tools' entries stay as they are. Returns whether the list changed.
 */
export function mergeFlatHook(entries: unknown[], wanted: Obj, event: HookEvent, harness: HarnessId): boolean {
  const ours = oursIn(entries, event, harness);
  const first = ours[0];
  if (first === undefined) {
    entries.push(wanted);
    return true;
  }
  let changed = false;
  for (const [key, value] of Object.entries(wanted)) {
    if (first[key] !== value) {
      first[key] = value;
      changed = true;
    }
  }
  const dupes = new Set<unknown>(ours.slice(1));
  if (dupes.size > 0) {
    const kept = entries.filter((e) => !dupes.has(e));
    entries.splice(0, entries.length, ...kept);
    changed = true;
  }
  return changed;
}

/** Whether a flat hook list holds exactly `wanted` as our one entry ("exact"), some other entry of ours ("stale"), or none. */
export function flatHookState(entries: unknown, wanted: Obj, event: HookEvent, harness: HarnessId): "exact" | "stale" | "none" {
  if (!Array.isArray(entries)) return "none";
  const ours = oursIn(entries, event, harness);
  const first = ours[0];
  if (first === undefined) return "none";
  return ours.length === 1 && Object.entries(wanted).every(([key, value]) => first[key] === value) ? "exact" : "stale";
}

/** "configured" when every event holds exactly our entry, "missing" when none holds one of ours, else "partial". */
export function hooksStateOf(states: ReadonlyArray<"exact" | "stale" | "none">): "configured" | "partial" | "missing" {
  if (states.every((s) => s === "exact")) return "configured";
  return states.every((s) => s === "none") ? "missing" : "partial";
}

// ---------------------------------------------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------------------------------------------

const HARNESS = "cursor" as const;
const LABEL = "Cursor";
/** The one rule Cursor's syntax offers for this program. Never written: it also covers the person commands. */
const SHELL_ENTRY = "Shell(jubarteai)";
const PERSON_COMMAND_LIST = "login, logout, link, init and update";
/** Cursor's hook timeout is in seconds. sessionEnd is fire-and-forget, so it only needs to be quick. */
const START_TIMEOUT_S = HOOK_REGISTERED_TIMEOUT_S;
const END_TIMEOUT_S = 3;
const EVENTS: ReadonlyArray<{ cursor: string; event: HookEvent; timeoutS: number }> = [
  { cursor: "sessionStart", event: "session-start", timeoutS: START_TIMEOUT_S },
  { cursor: "sessionEnd", event: "session-end", timeoutS: END_TIMEOUT_S },
];

const cursorDir = (home: string): string => join(home, ".cursor");
const cliConfigPath = (home: string): string => join(cursorDir(home), "cli-config.json");
const hooksPath = (home: string): string => join(cursorDir(home), "hooks.json");

function hasCli(env: DetectEnv): boolean {
  return env.which("agent") !== null || env.which("cursor-agent") !== null;
}

function cliPresent(ctx: DetectEnv): boolean {
  return existsSync(cliConfigPath(ctx.home)) || hasCli(ctx);
}

/** Printed, never written: what Cursor's program-wide rule would approve, and the two ways forward. */
function permissionInstructions(): ManualInstructions {
  return manual(
    HARNESS,
    "Cursor: approve jubarteai commands as Cursor asks",
    [
      `Cursor's allow rule names only the program, so \`${SHELL_ENTRY}\` would also pre-approve ${PERSON_COMMAND_LIST}: the commands that change your saved account, the repo binding and your harness files.`,
      "The CLI therefore writes no Cursor allow rule. Approve jubarteai commands when Cursor asks (in the IDE and in the Agent CLI).",
      `If you accept that trade-off, add "${SHELL_ENTRY}" to permissions.allow in ~/.cursor/cli-config.json yourself (the CLI refuses those five commands inside a Cursor agent shell only when CURSOR_AGENT is set).`,
    ],
    "Cursor's shell rule cannot exclude subcommands; the person commands stay behind a prompt (spec I6, review R-M1)",
  );
}

function allowList(doc: Obj): unknown[] | "absent" | "bad" {
  const permissions = doc["permissions"];
  if (permissions === undefined) return "absent";
  if (!isObject(permissions)) return "bad";
  const allow = permissions["allow"];
  if (allow === undefined) return "absent";
  return Array.isArray(allow) ? allow : "bad";
}

function wantedHook(program: string, event: HookEvent, timeoutS: number): Obj {
  return { command: hookCommand(program, event, HARNESS), timeout: timeoutS };
}

function addHooks(doc: Obj, program: string): EditOutcome {
  const hooksValue = doc["hooks"];
  if (hooksValue !== undefined && !isObject(hooksValue)) return { blocked: "hooks in hooks.json is not an object; add the entries by hand" };
  const hooks: Obj = hooksValue ?? {};
  for (const { cursor } of EVENTS) {
    if (hooks[cursor] !== undefined && !Array.isArray(hooks[cursor])) return { blocked: `hooks.${cursor} in hooks.json is not a list; add the entry by hand` };
  }
  let changed = false;
  for (const { cursor, event, timeoutS } of EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[cursor]) ? hooks[cursor] : [];
    if (!mergeFlatHook(entries, wantedHook(program, event, timeoutS), event, HARNESS)) continue;
    hooks[cursor] = entries;
    changed = true;
  }
  if (!changed) return "same";
  doc["hooks"] = hooks;
  if (doc["version"] === undefined) doc["version"] = 1;
  return "changed";
}

function hooksJson(program: string): string[] {
  const hooks: Obj = {};
  for (const { cursor, event, timeoutS } of EVENTS) hooks[cursor] = [wantedHook(program, event, timeoutS)];
  return JSON.stringify({ version: 1, hooks }, null, 2).split("\n");
}

export const cursorAdapter: HarnessAdapter = {
  id: HARNESS,
  label: LABEL,
  skillAgent: "cursor",
  // Hook processes get no variable that names the session, and a sessionStart `env` reaches later hooks only, not shell commands.
  sessionVar: null,
  // beforeSubmitPrompt cannot add context, so only session-start injects.
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    return existsSync(cursorDir(env.home)) || hasCli(env);
  },

  async permission(): Promise<PlanStep | ManualInstructions | null> {
    return permissionInstructions();
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    const file = hooksPath(ctx.home);
    const program = hookProgram(ctx);
    if (readable(file).status === "unwritable") {
      return manual(
        HARNESS,
        "Cursor: session hooks",
        [`Open ${file} and add:`, ...hooksJson(program), "(merge it into the existing hooks key)"],
        "hooks.json has comments or is not plain JSON, so it is not rewritten",
      );
    }
    return [
      jsonEditStep({
        id: `${HARNESS}:hooks`,
        label: "Cursor: session hooks",
        file,
        preview: EVENTS.map((e) => `  hooks.${e.cursor}: ${hookCommand(program, e.event, HARNESS)}`).join("\n"),
        createIfMissing: true,
        edit: (doc) => addHooks(doc, program),
      }),
    ];
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const notes = [`the CLI writes no Cursor allow rule (it would also pre-approve ${PERSON_COMMAND_LIST}); approve jubarteai commands when Cursor asks`];
    if (cliPresent(ctx)) {
      const cli = readable(cliConfigPath(ctx.home));
      if (cli.status === "ok") {
        const list = allowList(cli.doc);
        if (Array.isArray(list) && list.includes(SHELL_ENTRY)) {
          notes.push(`${SHELL_ENTRY} is in permissions.allow in cli-config.json, which also pre-approves ${PERSON_COMMAND_LIST} (the CLI refuses them inside a Cursor agent shell only when CURSOR_AGENT is set)`);
        }
      }
    }
    const hooksFile = readable(hooksPath(ctx.home));
    let hooks: AdapterState["hooks"];
    if (hooksFile.status === "unwritable") hooks = "manual";
    else {
      const section = hooksFile.status === "ok" ? hooksFile.doc["hooks"] : undefined;
      const program = hookProgram(ctx);
      hooks = hooksStateOf(EVENTS.map(({ cursor, event, timeoutS }) => flatHookState(isObject(section) ? section[cursor] : undefined, wantedHook(program, event, timeoutS), event, HARNESS)));
    }
    notes.push("Cursor has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill");
    return { permission: "manual", hooks, mcpEntries: await findMcpEntries(HARNESS, cleanupScopeOf(ctx)), notes };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },
};
