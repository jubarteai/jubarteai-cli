// Cursor adapter (spec §9). Verified cells only:
//   - permission: the Agent CLI's ~/.cursor/cli-config.json `permissions.allow` `Shell(jubarteai)` (merged, never replaced:
//     the CLI manages that file). The IDE's shell allowlist is unverified, so it is printed instead (D25).
//   - hooks: ~/.cursor/hooks.json `sessionStart` / `sessionEnd` only. `beforeSubmitPrompt` has no context output,
//     so there is no per-prompt hook (promptInjection false).
//   - MCP cleanup: ~/.cursor/mcp.json and .cursor/mcp.json (`mcpServers.jubarteai`), install.sh's two paths, through
//     mcp-cleanup.ts (C6a).
// Every write goes through editJsonFile (I6). This file also holds the small JSON-config helpers the VS Code, Windsurf
// and Zed adapters share (jsonEditStep, readable, manual, hookCommand), so the four stay one idiom.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_TOTAL_BUDGET_MS } from "../constants.js";
import { editJsonFile, readJsonObject } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import type { HarnessId } from "../session/harness-env.js";
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

/** A step that edits one JSON file through editJsonFile. `edit` mutates the document and says what it did. */
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
    sensitive: true,
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

// ---------------------------------------------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------------------------------------------

const HARNESS = "cursor" as const;
const LABEL = "Cursor";
const SHELL_ENTRY = "Shell(jubarteai)";
/** Cursor's hook timeout is in seconds. sessionEnd is fire-and-forget, so it only needs to be quick. */
const START_TIMEOUT_S = HOOK_TOTAL_BUDGET_MS / 1000;
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

function ideAllowlistInstructions(): ManualInstructions {
  return manual(
    HARNESS,
    "Cursor IDE: allow the jubarteai command",
    ["Open Cursor Settings, find the agent terminal command allowlist and add: jubarteai", "(Cursor documents no settings file for it, so the CLI does not write one)"],
    "the IDE's shell allowlist is not verified (D25)",
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

function addPermission(doc: Obj): EditOutcome {
  const list = allowList(doc);
  if (list === "bad") return { blocked: "permissions.allow in cli-config.json is not a list; add the entry by hand" };
  if (list !== "absent") {
    if (list.includes(SHELL_ENTRY)) return "same";
    list.push(SHELL_ENTRY);
    return "changed";
  }
  const permissions = isObject(doc["permissions"]) ? doc["permissions"] : {};
  permissions["allow"] = [SHELL_ENTRY];
  doc["permissions"] = permissions;
  return "changed";
}

function hasHook(entries: unknown, command: string): boolean {
  return Array.isArray(entries) && entries.some((e) => isObject(e) && e["command"] === command);
}

function addHooks(doc: Obj, cliCommand: string): EditOutcome {
  const hooksValue = doc["hooks"];
  if (hooksValue !== undefined && !isObject(hooksValue)) return { blocked: "hooks in hooks.json is not an object; add the entries by hand" };
  const hooks: Obj = hooksValue ?? {};
  for (const { cursor } of EVENTS) {
    if (hooks[cursor] !== undefined && !Array.isArray(hooks[cursor])) return { blocked: `hooks.${cursor} in hooks.json is not a list; add the entry by hand` };
  }
  let changed = false;
  for (const { cursor, event, timeoutS } of EVENTS) {
    const command = hookCommand(cliCommand, event, HARNESS);
    const entries: unknown[] = Array.isArray(hooks[cursor]) ? hooks[cursor] : [];
    if (hasHook(entries, command)) continue;
    entries.push({ command, timeout: timeoutS });
    hooks[cursor] = entries;
    changed = true;
  }
  if (!changed) return "same";
  doc["hooks"] = hooks;
  if (doc["version"] === undefined) doc["version"] = 1;
  return "changed";
}

function hooksJson(cliCommand: string): string[] {
  const hooks: Obj = {};
  for (const { cursor, event, timeoutS } of EVENTS) hooks[cursor] = [{ command: hookCommand(cliCommand, event, HARNESS), timeout: timeoutS }];
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

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    if (!cliPresent(ctx)) return ideAllowlistInstructions();
    const file = cliConfigPath(ctx.home);
    if (readable(file).status === "unwritable") {
      return manual(
        HARNESS,
        "Cursor CLI: allow the jubarteai command",
        [`Open ${file} and add "${SHELL_ENTRY}" to permissions.allow:`, `  "permissions": { "allow": ["${SHELL_ENTRY}"] }`, "(merge it into the existing list)"],
        "cli-config.json has comments or is not plain JSON, so it is not rewritten",
      );
    }
    return jsonEditStep({
      id: `${HARNESS}:permission`,
      label: "Cursor CLI: allow the jubarteai command",
      file,
      preview: `  permissions.allow += "${SHELL_ENTRY}"`,
      createIfMissing: true,
      edit: addPermission,
    });
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    const file = hooksPath(ctx.home);
    if (readable(file).status === "unwritable") {
      return manual(
        HARNESS,
        "Cursor: session hooks",
        [`Open ${file} and add:`, ...hooksJson(ctx.cliCommand), "(merge it into the existing hooks key)"],
        "hooks.json has comments or is not plain JSON, so it is not rewritten",
      );
    }
    return [
      jsonEditStep({
        id: `${HARNESS}:hooks`,
        label: "Cursor: session hooks",
        file,
        preview: EVENTS.map((e) => `  hooks.${e.cursor}: ${hookCommand(ctx.cliCommand, e.event, HARNESS)}`).join("\n"),
        createIfMissing: true,
        edit: (doc) => addHooks(doc, ctx.cliCommand),
      }),
    ];
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const notes = ["the Cursor IDE's shell allowlist is not verified; add jubarteai to it in Cursor Settings by hand"];
    let permission: AdapterState["permission"] = "manual";
    if (cliPresent(ctx)) {
      const cli = readable(cliConfigPath(ctx.home));
      if (cli.status === "missing") permission = "missing";
      else if (cli.status === "ok") {
        const list = allowList(cli.doc);
        permission = Array.isArray(list) && list.includes(SHELL_ENTRY) ? "configured" : "missing";
      }
    }
    const hooksFile = readable(hooksPath(ctx.home));
    let hooks: AdapterState["hooks"];
    if (hooksFile.status === "unwritable") hooks = "manual";
    else {
      const section = hooksFile.status === "ok" ? hooksFile.doc["hooks"] : undefined;
      const present = EVENTS.filter(({ cursor, event }) => isObject(section) && hasHook(section[cursor], hookCommand(ctx.cliCommand, event, HARNESS))).length;
      hooks = present === EVENTS.length ? "configured" : present === 0 ? "missing" : "partial";
    }
    notes.push("Cursor has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill");
    return { permission, hooks, mcpEntries: await findMcpEntries(HARNESS, cleanupScopeOf(ctx)), notes };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },

  // The IDE half of the permission cell: the CLI's rule is the step above, the IDE's allowlist can only be printed.
  async extras(ctx: InitCtx): Promise<Array<PlanStep | ManualInstructions>> {
    return cliPresent(ctx) ? [ideAllowlistInstructions()] : [];
  },
};
