// The only way the CLI writes harness and security files (invariant I6): every
// command that changes a config, hook, skill or instruction file builds a list of
// steps and hands it to applyPlan, which shows what will happen, asks once for the
// whole plan (a checklist or one question), and runs what was approved. Nothing else
// writes those files.
import { agentSessionVar } from "../agent-session.js";
import type { HarnessId } from "../session/harness-env.js";
import { homeDir } from "../paths.js";
import { checklist } from "../ui/checklist.js";
import type { ChecklistGroup, ChecklistResult } from "../ui/checklist.js";
import { choice } from "../ui/choice.js";
import type { Ui } from "../ui/index.js";
import type { Timeline } from "../ui/timeline.js";
import { SafeEditError } from "./atomic-write.js";
import { approvalGroups, checkedHarnesses, exactChanges, groupTitle, groupsOf, rowKey } from "./approval.js";
import { labelText, statusText } from "./result-text.js";

export type StepStatus = "configured" | "already configured" | "skipped" | "failed";

export type StepResult = {
  id: string;
  label: string;
  status: StepStatus;
  /** Fixed text, never file content. */
  detail?: string;
  /** The flag that would apply a skipped sensitive step, e.g. "--yes". */
  flag?: string;
  /** The last lines of a failed child's output, already redacted and made safe to print; only ever set on `failed`. */
  log?: string[];
};

/** Who a step is for, which is how the checklist groups it: a harness, this repo, or the machine as a whole. */
export type StepGroup = { kind: "harness"; id: HarnessId } | { kind: "repo"; root: string } | { kind: "machine" };

/** A choice a command asks before approval (never inside `apply()`): `set` receives the answer. */
export type StepQuestion = {
  id: "share-binding" | "share-codex";
  text: string;
  defaultYes: false;
  set(answer: boolean): void;
};

export const harnessGroup = (id: HarnessId): StepGroup => ({ kind: "harness", id });
export const repoGroup = (root: string): StepGroup => ({ kind: "repo", root });
export const MACHINE_GROUP: StepGroup = { kind: "machine" };

type PlanStepBase = {
  id: string;
  label: string;
  /**
   * "change" (the default) writes something; "info" is a finding whose apply() only returns its fixed result (already
   * current, a duplicate load, a tip), so a report-only run (update --check) may run it to print what it found.
   * applyPlan and summarize treat both alike.
   */
  kind?: "change" | "info";
  /** Required, so the compiler proves every builder says who its step is for. */
  group: StepGroup;
  /** A choice asked before approval; the checklist is shown only after it is answered. */
  question?: StepQuestion;
  files: string[];
  /** Sensitive steps (hooks, permission files) are approved by a person in the checklist and never run without a TTY or --yes. */
  sensitive: boolean;
  /** The exact entry shown behind `d` / "Show" in the approval, and with `--show-changes`. */
  preview?: string;
  flag?: string;
  apply(): Promise<StepResult>;
};

/**
 * A step shown under more than one harness must also say how to run it for fewer of them: the checklist lets a person
 * leave one harness out, and without `narrow` the step would run for all of them anyway. The type makes the two travel together.
 */
export type PlanStep = PlanStepBase &
  (
    | { alsoGroups?: undefined; narrow?: undefined }
    | {
        /** Other harnesses the same step serves (one `npx skills add -a a -a b` covers several): the step shows under `group` and these. */
        alsoGroups: HarnessId[];
        /** The same step limited to the harnesses still checked; null when none is left. Only ever removes harnesses. */
        narrow(keep: ReadonlySet<HarnessId>): PlanStep | null;
      }
  );

const DEFAULT_FLAG = "--yes";
const NEEDS_CONFIRMATION = "needs confirmation";
/** Why a step was left out: its row was unchecked in the checklist. */
export const NOT_SELECTED = "not selected";
/** Why nothing ran: the person closed the checklist or answered no. */
export const DECLINED = "declined";
/** Why a sensitive step was not applied on `--yes` inside an agent's shell: no flag can fix that, only the person can. */
export const NEEDS_PERSON = "needs your approval: an agent's --yes doesn't count; run the command yourself in a terminal";

/** A fixed, secret-free description of why a step threw: the guard's reason, a Node error code, or a generic line. */
function failureDetail(error: unknown): string {
  if (error instanceof SafeEditError) return `could not write (${error.reason})`;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(code)) return `could not write (${code})`;
  return "unexpected error";
}

function skipped(step: PlanStep, detail: string, flag?: string): StepResult {
  return flag === undefined ? { id: step.id, label: step.label, status: "skipped", detail } : { id: step.id, label: step.label, status: "skipped", detail, flag };
}

async function runStep(step: PlanStep): Promise<StepResult> {
  try {
    const result = await step.apply();
    return { ...result, id: step.id, label: step.label };
  } catch (error) {
    return { id: step.id, label: step.label, status: "failed", detail: failureDetail(error) };
  }
}

export type ApplyOptions = {
  tty: boolean;
  yes: boolean;
  ui: Ui;
  timeline: Timeline;
  /** "checklist": one grouped checklist (init, uninstall). "confirm": one Yes / No / Show question (update, login). */
  approval: "checklist" | "confirm";
  /** The checklist's title or the question. */
  title: string;
  /** The checklist's key hints (default: the standard line). */
  hint?: string;
  /** Print the exact entry of every step before asking (`--show-changes`). */
  showChanges?: boolean;
  /** Inside a coding agent's shell: the variable's name (default: detected). */
  agentSession?: string | null;
  /** Test seam: answers the checklist or the question without a terminal. */
  approve?: (groups: ChecklistGroup[], details: (checked: ReadonlySet<string>) => string[]) => Promise<ChecklistResult>;
};

const DEFAULT_HINT = "↑/↓ move · space toggle · d show the exact changes · enter apply";

/** The checked rows as the person left them, or null when they declined. */
async function approveInteractively(steps: PlanStep[], opts: ApplyOptions): Promise<ReadonlySet<string> | null> {
  const home = homeDir();
  const groups = approvalGroups(steps, home);
  // Only findings (kind "info"): nothing to approve, so nothing to ask, and declining isn't what happened.
  if (groups.length === 0) return new Set();
  const details = (checked: ReadonlySet<string>): string[] => exactChanges(steps, checked, home);
  if (opts.showChanges === true) for (const line of exactChanges(steps, new Set(groups.flatMap((g) => g.rows.map((r) => r.key))), home)) opts.ui.line(line);
  let result: ChecklistResult;
  if (opts.approve !== undefined) result = await opts.approve(groups, details);
  else if (opts.approval === "checklist") result = await checklist(opts.ui, { title: opts.title, hint: opts.hint ?? DEFAULT_HINT, groups, details });
  else {
    const all = new Set(groups.flatMap((g) => g.rows.map((r) => r.key)));
    const answer = await choice(opts.ui, { question: opts.title, options: ["yes", "no", "show"], defaultIndex: 0, details: () => details(all) });
    result = answer === "yes" ? { kind: "apply", checked: all } : { kind: "declined" };
  }
  return result.kind === "apply" ? result.checked : null;
}

/** The step to run given the rows left checked: itself, a narrowed copy, or null when none of its rows is checked. */
function selectedStep(step: PlanStep, checked: ReadonlySet<string>): PlanStep | null {
  if (step.kind === "info") return step;
  const rows = groupsOf(step).filter((group) => checked.has(rowKey(step, group)));
  if (rows.length === 0) return null;
  if (step.narrow === undefined || rows.length === groupsOf(step).length) return step;
  return step.narrow(checkedHarnesses(step, checked));
}

/**
 * The single gate for sensitive writes (invariant I6). On a person's terminal without `--yes`, one approval covers the
 * whole plan: a grouped checklist with every row checked (`approval: "checklist"`) or one Yes / No / Show question
 * (`"confirm"`). Approval binds to the very steps rendered: unchecked rows are skipped as "not selected", a step serving
 * several harnesses runs narrowed to the ones still checked, and a checked sensitive step runs with no further prompt.
 * Declined (nothing checked, No) applies nothing. Without a terminal the non-sensitive steps run and the sensitive ones are
 * skipped with the flag that applies them; `--yes` runs everything. Inside a coding agent's shell no checklist or question is
 * shown and `--yes` covers only the non-sensitive steps: every sensitive one is skipped as "needs your approval", terminal or
 * not (an agent can type the flag or answer a prompt in its own pseudo-terminal, R-M1).
 * Steps sharing an id are one step (the first wins). A step that throws is "failed" with a fixed detail and the others
 * still run. Results stream into `timeline` as each step finishes. A cancelled prompt (Ctrl-C) rejects before anything ran.
 */
export async function applyPlan(steps: PlanStep[], opts: ApplyOptions): Promise<StepResult[]> {
  // Two adapters may return the same shared step (one hooks file for VS Code and Copilot CLI): the first occurrence wins.
  const seen = new Set<string>();
  steps = steps.filter((step) => !seen.has(step.id) && seen.add(step.id) !== undefined);
  if (steps.length === 0) return [];
  const agent = opts.agentSession === undefined ? agentSessionVar() : opts.agentSession;
  /** Whether `yes` approves the sensitive steps: never from inside an agent's shell. */
  const sensitiveYes = opts.yes && agent === null;
  const prompting = opts.tty && !opts.yes && agent === null;
  if (!prompting && opts.showChanges === true) {
    const all = new Set(steps.flatMap((step) => groupsOf(step).map((group) => rowKey(step, group))));
    for (const line of exactChanges(steps, all, homeDir())) opts.ui.line(line);
  }

  let checked: ReadonlySet<string> | null = null;
  if (prompting) {
    checked = await approveInteractively(steps, opts);
    if (checked === null) {
      opts.timeline.abort("Aborted.");
      return steps.map((step) => skipped(step, DECLINED));
    }
  }

  const results: StepResult[] = [];
  for (const step of steps) {
    const title = groupTitle(step.group);
    let result: StepResult;
    if (checked !== null) {
      const run = selectedStep(step, checked);
      result = run === null ? skipped(step, NOT_SELECTED) : await opts.timeline.run(labelText(step.label), () => runStep(run));
    } else if (step.sensitive && !sensitiveYes) {
      // From an agent's shell no flag applies it, so none is offered (an agent would just add it and try again).
      result = agent !== null ? skipped(step, NEEDS_PERSON) : skipped(step, NEEDS_CONFIRMATION, step.flag ?? DEFAULT_FLAG);
    } else {
      result = await opts.timeline.run(labelText(step.label), () => runStep(step));
    }
    results.push(result);
    opts.timeline.result(result, title);
  }
  return results;
}

/** One line per step: "<label>: configured | already configured | skipped (<detail>; rerun with <flag>) | failed: <detail>". */
export function summarize(results: StepResult[]): string[] {
  return results.map((r) => `${labelText(r.label)}: ${statusText(r)}`);
}
