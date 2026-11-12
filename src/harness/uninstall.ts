// The inverse of what init writes, for the adapters' `uninstall()`: remove only the entries that are ours (matched the
// way init and doctor recognise them), leave every other key and every other tool's entry, tidy the empty containers
// we leave behind, and report through the same single approval gate (these are sensitive steps like their writers).
import { readFileSync } from "node:fs";

import { removeFileSafely } from "../binding/gitignore.js";
import { harnessGroup } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { editJsonFile, readJsonObject } from "../safe-edit/json-edit.js";
import type { HarnessId } from "../session/harness-env.js";
import { isOurHookCommand } from "./claude-code.js";
import { isUnderHome, shownPath } from "./mcp-cleanup.js";
import type { ManualInstructions } from "./types.js";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** `Bash(jubarteai *)` and `Bash(jubarteai:*)` are the same rule to Claude Code. */
export function sameRule(entry: unknown, rule: string): boolean {
  return entry === rule || entry === rule.replace(/ \*\)$/, ":*)");
}

/**
 * Whether a nested-hook command is ours for `harness`: init's `<program> hook <event> --harness <id>` suffix with any
 * non-empty program, or an older bare `jubarteai hook <event>`.
 */
export function isOurNestedCommand(command: string, arg: string, harness: string): boolean {
  if (isOurHookCommand(command, arg, harness)) return true;
  return new RegExp(`^\\s*(?:\\S*[\\\\/])?jubarteai(?:\\.(?:cmd|exe))?\\s+hook\\s+${arg}(?:\\s|$)`, "i").test(command);
}

/** Removes our hook entries from `doc.hooks[event][].hooks[]` (Claude Code, Codex, Gemini CLI); true when anything went. */
export function removeNestedHooks(doc: Obj, events: ReadonlyArray<{ name: string; arg: string }>, harness: string): boolean {
  const hooks = doc["hooks"];
  if (!isObject(hooks)) return false;
  let changed = false;
  for (const event of events) {
    const groups = hooks[event.name];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group["hooks"])) {
        kept.push(group);
        continue;
      }
      const remaining = group["hooks"].filter((hook) => !(isObject(hook) && typeof hook["command"] === "string" && isOurNestedCommand(hook["command"], event.arg, harness)));
      if (remaining.length === group["hooks"].length) {
        kept.push(group);
        continue;
      }
      changed = true;
      group["hooks"] = remaining;
      if (remaining.length > 0) kept.push(group);
    }
    if (kept.length === 0) delete hooks[event.name];
    else hooks[event.name] = kept;
  }
  if (changed && Object.keys(hooks).length === 0) delete doc["hooks"];
  return changed;
}

/** Removes our entries from flat hook lists (`hooks[key] = [{ command, … }]`: Cursor, Copilot); true when anything went. */
export function removeFlatHooks(doc: Obj, keys: ReadonlyArray<{ key: string; arg: string }>, harness: string, extra: (entry: Obj) => boolean = () => false): boolean {
  const hooks = doc["hooks"];
  if (!isObject(hooks)) return false;
  let changed = false;
  for (const { key, arg } of keys) {
    const list = hooks[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !(isObject(entry) && typeof entry["command"] === "string" && (isOurNestedCommand(entry["command"], arg, harness) || extra(entry))));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length === 0) delete hooks[key];
    else hooks[key] = kept;
  }
  if (changed && Object.keys(hooks).length === 0) delete doc["hooks"];
  return changed;
}

/** Removes `rules` from the string list at `doc[path…][key]`, deleting the emptied list and containers; true when anything went. */
export function removeFromStringList(doc: Obj, path: readonly string[], rules: readonly string[], match: (entry: unknown, rule: string) => boolean = (a, b) => a === b): boolean {
  const trail: Array<{ node: Obj; key: string }> = [];
  let node: unknown = doc;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node)) return false;
    trail.push({ node, key });
    node = node[key];
  }
  const last = path[path.length - 1];
  if (!isObject(node) || last === undefined) return false;
  const list = node[last];
  if (!Array.isArray(list)) return false;
  const kept = list.filter((entry) => !rules.some((rule) => match(entry, rule)));
  if (kept.length === list.length) return false;
  if (kept.length > 0) {
    node[last] = kept;
    return true;
  }
  delete node[last];
  let child: Obj = node;
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const step = trail[i] as { node: Obj; key: string };
    if (Object.keys(child).length > 0) break;
    delete step.node[step.key];
    child = step.node;
  }
  return true;
}

/** Whether the file's text mentions us, for a config the CLI can't rewrite: only then is "remove it by hand" worth saying. */
function mentionsUs(file: string): boolean {
  try {
    return /jubarteai/i.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export type RemovalSpec = {
  harness: HarnessId;
  id: string;
  label: string;
  file: string;
  home: string;
  /** What will be removed, shown behind `d`. */
  preview: string;
  /** Mutates the document, returning whether it removed anything. Must be a pure function of the document. */
  edit: (doc: Obj) => boolean;
  /** Lines telling the person what to remove by hand when the file can't be rewritten. */
  byHand: string[];
};

/**
 * A sensitive step that removes our entries from one JSON file; null when the file has none of ours (nothing to
 * offer) and printed instructions when the file mentions us but can't be rewritten (comments, unreadable).
 */
export function jsonRemovalStep(spec: RemovalSpec): PlanStep | ManualInstructions | null {
  let read: ReturnType<typeof readJsonObject>;
  try {
    read = readJsonObject(spec.file);
  } catch {
    return mentionsUs(spec.file) ? manualRemoval(spec, "the file can't be read by this user") : null;
  }
  if (read.status === "missing") return null;
  if (read.status !== "ok") return mentionsUs(spec.file) ? manualRemoval(spec, "the file has comments or is not plain JSON, so it is not rewritten") : null;
  if (!spec.edit(structuredClone(read.doc))) return null;
  const { id, label, file, home } = spec;
  return {
    id,
    label,
    group: harnessGroup(spec.harness),
    files: [file],
    sensitive: true,
    preview: spec.preview,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      const result = editJsonFile(file, (doc) => spec.edit(doc), { createIfMissing: false, withinHome: isUnderHome(file, home) });
      switch (result.status) {
        case "changed": {
          // A file that held only our entries (init made it) goes with them; an other-tool key or any content keeps it.
          const left = readJsonObject(file);
          if (left.status === "ok" && Object.keys(left.doc).every((key) => key === "version") && isUnderHome(file, home)) removeFileSafely(file);
          return { id, label, status: "configured", detail: "removed" };
        }
        case "unchanged":
        case "missing":
          return { id, label, status: "already configured", detail: "nothing to remove" };
        case "refused":
          return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
      }
    },
  };
}

function manualRemoval(spec: RemovalSpec, reason: string): ManualInstructions {
  return { kind: "manual", harness: spec.harness, title: spec.label, lines: [`Open ${shownPath(spec.file, spec.home)} and remove:`, ...spec.byHand], reason };
}
