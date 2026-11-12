// What the person approves, built from the very PlanStep objects that will run: the checklist's groups and rows
// (one row per step per group it serves) and the exact entries shown behind `d`. Pure; applyPlan owns the rest.
import { HARNESS_LABELS } from "../harness/labels.js";
import { redactSecrets, safeForDisplay } from "../output.js";
import type { ChecklistGroup } from "../ui/checklist.js";
import { displayPath } from "../ui/display.js";
import type { PlanStep, StepGroup } from "./plan.js";

const LABEL_LIMIT = 200;
const SEP = "\u0000";

/** One group per repo root: in a linked worktree the binding goes to the main checkout and the instruction files stay here. */
export function groupKey(group: StepGroup): string {
  return group.kind === "harness" ? `harness:${group.id}` : group.kind === "repo" ? `repo:${group.root}` : "machine";
}

export function groupTitle(group: StepGroup): string {
  return group.kind === "harness" ? HARNESS_LABELS[group.id] : group.kind === "repo" ? "Repo" : "This machine";
}

/** Row key of `step` under `group`; checked rows come back as a set of these. */
export function rowKey(step: PlanStep, group: StepGroup): string {
  return `${step.id}${SEP}${groupKey(group)}`;
}

/** Every group a step shows under: its own, then the other harnesses it serves. */
export function groupsOf(step: PlanStep): StepGroup[] {
  return [step.group, ...(step.alsoGroups ?? []).map((id): StepGroup => ({ kind: "harness", id }))];
}

const ORDER: Readonly<Record<StepGroup["kind"], number>> = { harness: 0, repo: 1, machine: 2 };

/** A preview as printed: secrets redacted, control characters other than newlines replaced, tabs flattened. */
export function printable(preview: string): string {
  return redactSecrets(preview)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => (c === "\n" ? c : "?"));
}

/**
 * The checklist's groups, in the order the steps first appear (harness groups first, then the repo, then the
 * machine), every row checked. Steps that only report (`kind: "info"`) have nothing to approve and get no row.
 */
export function approvalGroups(steps: PlanStep[], home: string): ChecklistGroup[] {
  const groups = new Map<string, ChecklistGroup & { order: number; first: number }>();
  steps.forEach((step, index) => {
    if (step.kind === "info") return;
    for (const group of groupsOf(step)) {
      const key = groupKey(group);
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = {
          key,
          title: groupTitle(group),
          ...(group.kind === "repo" ? { note: displayPath(group.root, { home }) } : {}),
          rows: [],
          order: ORDER[group.kind],
          first: index,
        };
        groups.set(key, entry);
      }
      entry.rows.push({ key: rowKey(step, group), label: safeForDisplay(step.label, LABEL_LIMIT), checked: true });
    }
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.first - b.first)
    .map(({ key, title, note, rows }) => ({ key, title, ...(note === undefined ? {} : { note }), rows }));
}

/**
 * The exact entry of every checked step, once per step (a skill step shown under two harnesses prints once), redacted
 * and with control characters replaced. A step with no preview shows its files.
 */
export function exactChanges(steps: PlanStep[], checked: ReadonlySet<string>, home: string): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.kind === "info") continue;
    if (!groupsOf(step).some((group) => checked.has(rowKey(step, group)))) continue;
    out.push(safeForDisplay(step.label, LABEL_LIMIT));
    if (step.preview !== undefined) {
      for (const line of printable(step.preview).split("\n")) out.push(`      ${line}`);
    } else {
      for (const file of step.files) out.push(`      ${displayPath(file, { home })}`);
    }
  }
  return out;
}

/** The harnesses with at least one checked row for `step`. */
export function checkedHarnesses(step: PlanStep, checked: ReadonlySet<string>): Set<NonNullable<ReturnType<typeof harnessOf>>> {
  const out = new Set<NonNullable<ReturnType<typeof harnessOf>>>();
  for (const group of groupsOf(step)) {
    const id = harnessOf(group);
    if (id !== null && checked.has(rowKey(step, group))) out.add(id);
  }
  return out;
}

function harnessOf(group: StepGroup) {
  return group.kind === "harness" ? group.id : null;
}
