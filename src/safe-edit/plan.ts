// The only way the CLI writes harness and security files (invariant I6): every
// command that changes a config, hook, skill or instruction file builds a list of
// steps and hands it to applyPlan, which shows what will happen, asks once, asks
// again before each sensitive step, and runs the rest. Nothing else writes those files.
import { agentSessionVar } from "../agent-session.js";
import { confirm } from "../prompt.js";
import { redactSecrets, safeForDisplay } from "../output.js";
import { SafeEditError } from "./atomic-write.js";

export type StepStatus = "configured" | "already configured" | "skipped" | "failed";

export type StepResult = {
  id: string;
  label: string;
  status: StepStatus;
  /** Fixed text, never file content. */
  detail?: string;
  /** The flag that would apply a skipped sensitive step, e.g. "--yes". */
  flag?: string;
};

export type PlanStep = {
  id: string;
  label: string;
  /**
   * "change" (the default) writes something; "info" is a finding whose apply() only returns its fixed result (already
   * current, a duplicate load, a tip), so a report-only run (update --check) may run it to print what it found.
   * applyPlan and summarize treat both alike.
   */
  kind?: "change" | "info";
  files: string[];
  /** Sensitive steps (hooks, permission files) get their own prompt and never run without a TTY or --yes. */
  sensitive: boolean;
  /** The exact entry shown in the per-step prompt. */
  preview?: string;
  flag?: string;
  apply(): Promise<StepResult>;
};

const DEFAULT_FLAG = "--yes";
const LABEL_LIMIT = 200;
const PATH_LIMIT = 400;
const NEEDS_CONFIRMATION = "needs confirmation";
const DECLINED = "declined";
/** Why a sensitive step was not applied on `--yes` inside an agent's shell: no flag can fix that, only the person can. */
export const NEEDS_PERSON = "needs your approval: an agent's --yes doesn't count; run the command yourself in a terminal";

/** A fixed, secret-free description of why a step threw: the guard's reason, a Node error code, or a generic line. */
function failureDetail(error: unknown): string {
  if (error instanceof SafeEditError) return `could not write (${error.reason})`;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(code)) return `could not write (${code})`;
  return "unexpected error";
}

/** The preview as printed: secrets redacted, control characters other than newlines replaced, indented. */
function printable(preview: string): string {
  return redactSecrets(preview)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => (c === "\n" ? c : "?"))
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

function skipped(step: PlanStep, detail: string, flag?: string): StepResult {
  return flag === undefined ? { id: step.id, label: step.label, status: "skipped", detail } : { id: step.id, label: step.label, status: "skipped", detail, flag };
}

function printPlan(steps: PlanStep[], out: NodeJS.WritableStream): void {
  out.write("This will make these changes:\n");
  for (const step of steps) {
    out.write(`  - ${safeForDisplay(step.label, LABEL_LIMIT)}${step.sensitive ? " (asks first)" : ""}\n`);
    for (const file of step.files) out.write(`      ${safeForDisplay(file, PATH_LIMIT)}\n`);
  }
}

async function runStep(step: PlanStep): Promise<StepResult> {
  try {
    const result = await step.apply();
    return { ...result, id: step.id, label: step.label };
  } catch (error) {
    return { id: step.id, label: step.label, status: "failed", detail: failureDetail(error) };
  }
}

/**
 * Show the plan, then run it. On a TTY (without `yes`) one "Proceed? [Y/n]" covers the whole plan and each sensitive
 * step asks again with its exact entry. Without a TTY the non-sensitive steps run and the sensitive ones are skipped
 * (they need confirmation; their flag says how to apply them) unless `yes`. `yes` runs everything without a prompt.
 * Inside a coding agent's shell (`agentSession`, detected by default) `yes` covers only the non-sensitive steps and every
 * sensitive one is skipped as "needs your approval", TTY or not: the agent can pass the flag itself, and an IDE agent's
 * terminal is a real pseudo-terminal it can answer a prompt in (I6, R-M1).
 * Steps sharing an id are one step (the first wins). A step that throws is "failed" with a fixed detail and the others still run. A cancelled prompt (Ctrl-C) rejects.
 */
export async function applyPlan(
  steps: PlanStep[],
  opts: { tty: boolean; yes: boolean; out: NodeJS.WritableStream; confirmFn?: typeof confirm; agentSession?: string | null },
): Promise<StepResult[]> {
  // Two adapters may return the same shared step (one hooks file for VS Code and Copilot CLI): the first occurrence wins.
  const seen = new Set<string>();
  steps = steps.filter((step) => !seen.has(step.id) && seen.add(step.id) !== undefined);
  if (steps.length === 0) return [];
  const ask = opts.confirmFn ?? confirm;
  const agent = opts.agentSession === undefined ? agentSessionVar() : opts.agentSession;
  const prompting = opts.tty && !opts.yes;
  /** Whether `yes` approves the sensitive steps: never from inside an agent's shell. */
  const sensitiveYes = opts.yes && agent === null;
  printPlan(steps, opts.out);

  if (prompting && !(await ask("Proceed?", { defaultYes: true }))) {
    return steps.map((step) => skipped(step, DECLINED));
  }

  const results: StepResult[] = [];
  for (const step of steps) {
    if (step.sensitive && !sensitiveYes) {
      // From an agent's shell no flag applies it, so none is offered (an agent would just add it and try again), and
      // no prompt is shown either: whoever answers it there may be the agent.
      if (agent !== null) {
        results.push(skipped(step, NEEDS_PERSON));
        continue;
      }
      if (!opts.tty) {
        results.push(skipped(step, NEEDS_CONFIRMATION, step.flag ?? DEFAULT_FLAG));
        continue;
      }
      opts.out.write(`${safeForDisplay(step.label, LABEL_LIMIT)}\n`);
      if (step.preview !== undefined) opts.out.write(`${printable(step.preview)}\n`);
      if (!(await ask(`Apply "${safeForDisplay(step.label, LABEL_LIMIT)}"?`, { defaultYes: true }))) {
        results.push(skipped(step, DECLINED));
        continue;
      }
    }
    results.push(await runStep(step));
  }
  return results;
}

/** One line per step: "<label>: configured | already configured | skipped (<detail>; rerun with <flag>) | failed: <detail>". */
export function summarize(results: StepResult[]): string[] {
  return results.map((r) => {
    const label = safeForDisplay(r.label, LABEL_LIMIT);
    const detail = r.detail === undefined ? undefined : safeForDisplay(r.detail, LABEL_LIMIT);
    const flag = r.flag === undefined ? undefined : safeForDisplay(r.flag, LABEL_LIMIT);
    if (r.status === "skipped") {
      const why = [detail, flag === undefined ? undefined : `rerun with ${flag}`].filter((p) => p !== undefined);
      return why.length === 0 ? `${label}: skipped` : `${label}: skipped (${why.join("; ")})`;
    }
    if (r.status === "failed") return detail === undefined ? `${label}: failed` : `${label}: failed: ${detail}`;
    return `${label}: ${r.status}`;
  });
}
