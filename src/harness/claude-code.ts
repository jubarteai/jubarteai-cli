// Claude Code adapter (spec §6.1 step 7, §6.3, §9): the `Bash(jubarteai *)` permission rule and the three session
// hooks in ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json), and the removal of install.sh's MCP
// entries. Everything is a PlanStep that edits through editJsonFile (I6); other keys and other tools' hooks stay.
import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_REGISTERED_TIMEOUT_S } from "../constants.js";
import { editJsonFile, readJsonObject } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { findMcpEntries, isUnderHome, mcpCleanupFor, shownPath } from "./mcp-cleanup.js";
import type { HarnessId } from "../session/harness-env.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";
import { PERSON_COMMANDS } from "./agent-commands.js";

const ID = "claude-code";

/**
 * The three hook events, in the order they are registered. `name` is the harness' event key, `arg` the CLI's, `timeout`
 * in seconds (spec §6.3: SessionStart and UserPromptSubmit get HOOK_REGISTERED_TIMEOUT_S).
 */
export const HOOK_EVENTS = [
  { name: "SessionStart", arg: "session-start", timeout: HOOK_REGISTERED_TIMEOUT_S },
  { name: "UserPromptSubmit", arg: "user-prompt-submit", timeout: HOOK_REGISTERED_TIMEOUT_S },
  // The harness gives SessionEnd about a second and a half unless the hook asks for more.
  { name: "SessionEnd", arg: "session-end", timeout: 5 },
] as const;

/** One registered event; `timeout` is in the harness's own unit (seconds for Claude Code and Codex, milliseconds for Gemini CLI). */
export type HookEventSpec = { name: string; arg: string; timeout: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absoluteEnvDir(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== "" && path.isAbsolute(value) ? value : null;
}

/** Claude Code's user config directory: $CLAUDE_CONFIG_DIR when absolute, else ~/.claude. */
export function claudeDir(home: string, env: NodeJS.ProcessEnv): string {
  return absoluteEnvDir(env, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude");
}

export function settingsPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(claudeDir(home, env), "settings.json");
}

// ---- command hooks: the shape Claude Code and Codex share -------------------------------------------------

/** The command a hook runs: `<cli> hook <event> --harness <id>`. */
export function hookCommand(cliCommand: string, arg: string, harness: string): string {
  return `${cliCommand} hook ${arg} --harness ${harness}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a registered hook command is ours for this event and harness: `<program> hook <event> --harness <id>` with any
 * non-empty program (init's absolute `"<node>" "<bin>"`, a bare `jubarteai`, an older install's path). Matching on the
 * suffix, not the whole command, lets a re-run after a Node upgrade or a move update the entry instead of adding a
 * second one, and lets doctor recognize what init wrote.
 */
export function isOurHookCommand(command: string, arg: string, harness: string): boolean {
  const tail = new RegExp(`\\s+hook\\s+${escapeRegExp(arg)}\\s+--harness\\s+${escapeRegExp(harness)}\\s*$`).exec(command);
  return tail !== null && command.slice(0, tail.index).trim() !== "";
}

/**
 * Whether a hook command is one of ours for this event: the `--harness <id>` suffix (isOurHookCommand), the configured
 * command followed by `hook <event>`, or an older `jubarteai hook <event> …` under any path or extension.
 */
function isOurs(command: string, cliCommand: string, arg: string, harness: string): boolean {
  if (isOurHookCommand(command, arg, harness)) return true;
  if (command.startsWith(`${cliCommand} hook ${arg}`) && /^(\s|$)/.test(command.slice(`${cliCommand} hook ${arg}`.length))) return true;
  return new RegExp(`^\\s*(?:\\S*[\\\\/])?jubarteai(?:\\.(?:cmd|exe))?\\s+hook\\s+${arg}(?:\\s|$)`, "i").test(command);
}

type HookRef = { group: Record<string, unknown>; hooks: unknown[]; index: number };

function findOurs(groups: unknown[], spec: HooksEditSpec, arg: string): HookRef[] {
  const found: HookRef[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group["hooks"])) continue;
    const hooks = group["hooks"];
    hooks.forEach((hook, index) => {
      if (isObject(hook) && typeof hook["command"] === "string" && isOurs(hook["command"], spec.cliCommand, arg, spec.harness)) found.push({ group, hooks, index });
    });
  }
  return found;
}

/**
 * What to register: `cliCommand` is the program part of the hook command (InitCtx.hookCommand ?? cliCommand), `extra`
 * keys go on each entry, `group` keys on a new event group (Gemini CLI's `matcher`).
 */
export type HooksEditSpec = {
  events: readonly HookEventSpec[];
  cliCommand: string;
  harness: string;
  extra?: Record<string, unknown>;
  group?: Record<string, unknown>;
};

function wantedEntry(spec: HooksEditSpec, event: HookEventSpec): Record<string, unknown> {
  return { type: "command", command: hookCommand(spec.cliCommand, event.arg, spec.harness), timeout: event.timeout, ...(spec.extra ?? {}) };
}

/**
 * Merge our command hooks into `doc.hooks`: a missing event gets a new group, an entry of ours with another command
 * or timeout is updated in place (duplicates of ours are dropped), everything else stays. Returns whether anything
 * changed, or a conflict (hooks or an event is not the expected shape) with nothing to write.
 */
export function mergeCommandHooks(doc: Record<string, unknown>, spec: HooksEditSpec): { changed: boolean; conflict?: string } {
  const existing = doc["hooks"];
  if (existing !== undefined && !isObject(existing)) return { changed: false, conflict: "hooks is not an object" };
  for (const event of spec.events) {
    if (isObject(existing) && existing[event.name] !== undefined && !Array.isArray(existing[event.name])) {
      return { changed: false, conflict: `hooks.${event.name} is not a list` };
    }
  }
  const hooks: Record<string, unknown> = isObject(existing) ? existing : {};
  let changed = !isObject(existing);
  for (const event of spec.events) {
    const wanted = wantedEntry(spec, event);
    const groups = Array.isArray(hooks[event.name]) ? (hooks[event.name] as unknown[]) : [];
    const ours = findOurs(groups, spec, event.arg);
    const first = ours[0];
    if (first === undefined) {
      hooks[event.name] = [...groups, { ...(spec.group ?? {}), hooks: [wanted] }];
      changed = true;
      continue;
    }
    const entry = first.hooks[first.index] as Record<string, unknown>;
    for (const [key, value] of Object.entries(wanted)) {
      if (entry[key] !== value) {
        entry[key] = value;
        changed = true;
      }
    }
    // Duplicates of ours (an older entry beside the updated one) go, found by identity (never by a shifting index, which
    // could delete another tool's hook); a group they leave empty goes with them.
    const dupes = new Set<unknown>(ours.slice(1).map((o) => o.hooks[o.index]));
    if (dupes.size > 0) {
      const touched = new Set<Record<string, unknown>>(ours.map((o) => o.group));
      for (const group of touched) group["hooks"] = (group["hooks"] as unknown[]).filter((h) => !dupes.has(h));
      hooks[event.name] = groups.filter((g) => !(isObject(g) && touched.has(g) && Array.isArray(g["hooks"]) && g["hooks"].length === 0));
      changed = true;
    }
  }
  if (changed) doc["hooks"] = hooks;
  return { changed };
}

/** How much of our hook set a parsed config holds: every event with exactly our command and timeout ("configured"), some, or none. */
export function inspectCommandHooks(doc: Record<string, unknown>, spec: HooksEditSpec): "configured" | "partial" | "missing" {
  const hooks = doc["hooks"];
  let exact = 0;
  let any = 0;
  for (const event of spec.events) {
    const groups = isObject(hooks) && Array.isArray(hooks[event.name]) ? (hooks[event.name] as unknown[]) : [];
    const ours = findOurs(groups, spec, event.arg);
    if (ours.length > 0) any++;
    const first = ours[0];
    const entry = first === undefined ? undefined : (first.hooks[first.index] as Record<string, unknown>);
    if (entry !== undefined && ours.length === 1 && entry["command"] === hookCommand(spec.cliCommand, event.arg, spec.harness) && entry["timeout"] === event.timeout) exact++;
  }
  if (exact === spec.events.length) return "configured";
  return any > 0 ? "partial" : "missing";
}

/** The exact JSON a hook prompt shows. */
export function hooksPreview(spec: HooksEditSpec): string {
  const hooks: Record<string, unknown> = {};
  for (const event of spec.events) {
    hooks[event.name] = [{ ...(spec.group ?? {}), hooks: [wantedEntry(spec, event)] }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** The plan step that writes `spec`'s hooks into `file`; non-sensitive (nothing to ask) when they are all there already. */
export function hooksStep(args: { id: string; label: string; file: string; home: string; spec: HooksEditSpec; alreadyDone: boolean }): PlanStep {
  const { id, label, file, home, spec } = args;
  return {
    id,
    label,
    files: [file],
    sensitive: !args.alreadyDone,
    preview: hooksPreview(spec),
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const found: { conflict?: string } = {};
      const result = editJsonFile(
        file,
        (doc) => {
          const merged = mergeCommandHooks(doc, spec);
          if (merged.conflict !== undefined) found.conflict = merged.conflict;
          return merged.changed;
        },
        { createIfMissing: true, withinHome: isUnderHome(file, home) },
      );
      if (found.conflict !== undefined) return { id, label, status: "failed", detail: `${shownPath(file, home)}: ${found.conflict}` };
      return editResult(id, label, result);
    },
  };
}

/** A JSON edit's outcome as a step result with fixed text. */
export function editResult(id: string, label: string, result: ReturnType<typeof editJsonFile>): StepResult {
  switch (result.status) {
    case "changed":
      return { id, label, status: "configured" };
    case "unchanged":
      return { id, label, status: "already configured" };
    case "missing":
      return { id, label, status: "failed", detail: "the file is missing" };
    case "refused":
      return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
  }
}

// ---- Claude Code --------------------------------------------------------------------------------------------

/**
 * The subcommands that change the saved account, the repo binding or harness files. The allow rule would pre-approve
 * them too, letting an agent pass `--yes` or pipe a key on its own (spec I6, review R-M1), so each gets an ask rule:
 * in Claude Code ask beats allow, and the person sees the command before it runs. The tool commands stay pre-approved.
 */
export const ASK_SUBCOMMANDS = PERSON_COMMANDS;

type PermissionRules = { allow: string[]; ask: string[] };

function permissionRules(ctx: { cliCommand: string; platform: NodeJS.Platform }): PermissionRules {
  const tools = ctx.platform === "win32" ? ["Bash", "PowerShell"] : ["Bash"];
  const allow = tools.map((tool) => `${tool}(${ctx.cliCommand} *)`);
  const ask = tools.flatMap((tool) => [
    // The router refuses a flag before the command name (`jubarteai --yes init` exits 2), so these cover every way to
    // run one of them; no rule for a leading flag is needed, and `jubarteai --help` stays pre-approved (review R-S8).
    ...ASK_SUBCOMMANDS.flatMap((sub) => [`${tool}(${ctx.cliCommand} ${sub})`, `${tool}(${ctx.cliCommand} ${sub} *)`]),
  ]);
  return { allow, ask };
}

/** `Bash(jubarteai *)` and `Bash(jubarteai:*)` are the same rule to Claude Code. */
function hasRule(list: unknown[], rule: string): boolean {
  const colon = rule.replace(/ \*\)$/, ":*)");
  return list.some((r) => r === rule || r === colon);
}

function ruleList(permissions: unknown, key: "allow" | "ask"): unknown[] | undefined {
  if (!isObject(permissions)) return undefined;
  const list = permissions[key];
  return Array.isArray(list) ? (list as unknown[]) : undefined;
}

/** Every allow and every ask rule is in place. */
function hasRules(permissions: unknown, rules: PermissionRules): boolean {
  const allow = ruleList(permissions, "allow") ?? [];
  const ask = ruleList(permissions, "ask") ?? [];
  return rules.allow.every((r) => hasRule(allow, r)) && rules.ask.every((r) => hasRule(ask, r));
}

function permissionConflict(doc: Record<string, unknown>): string | null {
  const permissions = doc["permissions"];
  if (permissions === undefined) return null;
  if (!isObject(permissions)) return "permissions is not an object";
  for (const key of ["allow", "ask"] as const) {
    if (permissions[key] !== undefined && !Array.isArray(permissions[key])) return `permissions.${key} is not a list`;
  }
  return null;
}

function addRules(doc: Record<string, unknown>, rules: PermissionRules): boolean {
  const permissions = isObject(doc["permissions"]) ? doc["permissions"] : {};
  let changed = !isObject(doc["permissions"]);
  for (const key of ["allow", "ask"] as const) {
    const list = Array.isArray(permissions[key]) ? (permissions[key] as unknown[]) : [];
    let listChanged = !Array.isArray(permissions[key]);
    for (const rule of rules[key]) {
      if (!hasRule(list, rule)) {
        list.push(rule);
        listChanged = true;
      }
    }
    if (listChanged) {
      permissions[key] = list;
      changed = true;
    }
  }
  if (changed) doc["permissions"] = permissions;
  return changed;
}

/** The instruction for a config that exists but can't be read (no permission): fix that, nothing was written. */
export function unreadableInstructions(harness: HarnessId, file: string, home: string, title: string): ManualInstructions {
  const shown = shownPath(file, home);
  return { kind: "manual", harness, title, lines: [`couldn't read ${shown}: fix its permissions, then run jubarteai init again`], reason: `${shown} could not be read` };
}

function manualSettings(ctx: InitCtx, file: string, title: string, lines: string[], reason: string): ManualInstructions {
  return { kind: "manual", harness: ID, title, lines: [`Edit ${shownPath(file, ctx.home)} by hand:`, ...lines], reason };
}

export type JsonSettings =
  | { status: "ok"; doc: Record<string, unknown> }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "bad"; reason: string };

/** A JSON config as read for planning: parsed, missing, unreadable (no permission…), or unusable with a fixed reason. */
export function readSettings(file: string): JsonSettings {
  let read: ReturnType<typeof readJsonObject>;
  try {
    read = readJsonObject(file);
  } catch {
    return { status: "unreadable" };
  }
  if (read.status === "ok") return { status: "ok", doc: read.doc };
  if (read.status === "missing") return { status: "missing" };
  return { status: "bad", reason: read.status === "jsonc" ? "it has comments or trailing commas" : read.status === "not-object" ? "it is not a JSON object" : "it is not valid JSON" };
}

/** The hook entries use the hook command (absolute when init resolved one); the permission rule keeps the bare name. */
function hooksSpec(ctx: Pick<InitCtx, "cliCommand" | "hookCommand">): HooksEditSpec {
  return { events: HOOK_EVENTS, cliCommand: ctx.hookCommand ?? ctx.cliCommand, harness: ID };
}

async function detect(env: DetectEnv): Promise<boolean> {
  if (env.which("claude") !== null) return true;
  return fs.existsSync(claudeDir(env.home, env.env));
}

async function permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
  const file = settingsPath(ctx.home, ctx.env);
  const rules = permissionRules(ctx);
  const settings = readSettings(file);
  const id = `${ID}:permission`;
  const label = `Allow ${rules.allow.join(" and ")} in ${shownPath(file, ctx.home)}, asking first for ${ASK_SUBCOMMANDS.join(", ")}`;
  const entries = JSON.stringify({ permissions: { allow: rules.allow, ask: rules.ask } }, null, 2);
  const addLine = `add ${rules.allow.map((r) => `"${r}"`).join(", ")} to permissions.allow and ${rules.ask.map((r) => `"${r}"`).join(", ")} to permissions.ask`;
  if (settings.status === "unreadable") return unreadableInstructions(ID, file, ctx.home, "Claude Code permission");
  if (settings.status === "bad") {
    return manualSettings(ctx, file, "Claude Code permission", [`${addLine}:`, ...entries.split("\n")], `${shownPath(file, ctx.home)}: ${settings.reason}`);
  }
  if (settings.status === "ok") {
    const conflict = permissionConflict(settings.doc);
    if (conflict !== null) return manualSettings(ctx, file, "Claude Code permission", [addLine], `${shownPath(file, ctx.home)}: ${conflict}`);
  }
  const done = settings.status === "ok" && hasRules(settings.doc["permissions"], rules);
  return {
    id,
    label,
    files: [file],
    sensitive: !done,
    preview: entries,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const found: { conflict: string | null } = { conflict: null };
      const result = editJsonFile(
        file,
        (doc) => {
          found.conflict = permissionConflict(doc);
          return found.conflict === null && addRules(doc, rules);
        },
        { createIfMissing: true, withinHome: isUnderHome(file, ctx.home) },
      );
      if (found.conflict !== null) return { id, label, status: "failed", detail: `${shownPath(file, ctx.home)}: ${found.conflict}` };
      return editResult(id, label, result);
    },
  };
}

async function hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
  const file = settingsPath(ctx.home, ctx.env);
  const spec = hooksSpec(ctx);
  const settings = readSettings(file);
  if (settings.status === "unreadable") return unreadableInstructions(ID, file, ctx.home, "Claude Code hooks");
  if (settings.status === "bad") {
    return manualSettings(ctx, file, "Claude Code hooks", ["add these hooks:", ...hooksPreview(spec).split("\n")], `${shownPath(file, ctx.home)}: ${settings.reason}`);
  }
  if (settings.status === "ok" && mergeCommandHooks(structuredClone(settings.doc), spec).conflict !== undefined) {
    return manualSettings(ctx, file, "Claude Code hooks", ["add these hooks:", ...hooksPreview(spec).split("\n")], `${shownPath(file, ctx.home)}: hooks has an unexpected shape`);
  }
  const done = settings.status === "ok" && inspectCommandHooks(settings.doc, spec) === "configured";
  return [hooksStep({ id: `${ID}:hooks`, label: `Add the JubarteAI session hooks to ${shownPath(file, ctx.home)}`, file, home: ctx.home, spec, alreadyDone: done })];
}

async function inspect(ctx: InitCtx): Promise<AdapterState> {
  const file = settingsPath(ctx.home, ctx.env);
  const settings = readSettings(file);
  const mcpEntries = await findMcpEntries(ID, { home: ctx.home, projectRoot: ctx.projectRoot, platform: ctx.platform, env: ctx.env });
  const notes: string[] = [];
  if (settings.status === "unreadable") {
    notes.push(`${shownPath(file, ctx.home)} could not be read: fix its permissions`);
    return { permission: "manual", hooks: "manual", mcpEntries, notes };
  }
  if (settings.status === "bad") {
    notes.push(`${shownPath(file, ctx.home)}: ${settings.reason}; edit it by hand`);
    return { permission: "manual", hooks: "manual", mcpEntries, notes };
  }
  if (settings.status === "missing") return { permission: "missing", hooks: "missing", mcpEntries, notes };
  const permissions = settings.doc["permissions"];
  const configured = hasRules(permissions, permissionRules(ctx));
  if (isObject(permissions) && Array.isArray(permissions["deny"]) && permissions["deny"].some((r) => typeof r === "string" && /^Bash\(\s*jubarteai\b/.test(r))) {
    notes.push("a deny rule for jubarteai overrides the allow rule");
  }
  return { permission: configured ? "configured" : "missing", hooks: inspectCommandHooks(settings.doc, hooksSpec(ctx)), mcpEntries, notes };
}

async function mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
  return mcpCleanupFor(ID, scope);
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: ID,
  label: "Claude Code",
  skillAgent: "claude-code",
  sessionVar: "CLAUDE_CODE_SESSION_ID",
  promptInjection: true,
  detect,
  permission,
  hooks,
  inspect,
  mcpCleanup,
};
