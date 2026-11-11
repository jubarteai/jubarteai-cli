// The adapter interface every harness implements (spec §9). Adapters never write files directly (invariant I6):
// they return PlanSteps whose apply() goes through editJsonFile / editTomlFile.
import type { HarnessId } from "../session/harness-env.js";
import type { PlanStep } from "../safe-edit/plan.js";

export type ManualInstructions = {
  kind: "manual";
  harness: HarnessId;
  title: string;
  /** Exact text init prints. */
  lines: string[];
  /** Why this is manual, e.g. "not verified (D25)". */
  reason: string;
};

export type DetectEnv = {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  which(cmd: string): string | null;
};

export type InitCtx = DetectEnv & {
  /** Null when run from ~ or /. */
  projectRoot: string | null;
  /** "jubarteai" */
  cliCommand: string;
};

export type CleanupScope = {
  home: string;
  projectRoot: string | null;
  platform: NodeJS.Platform;
  /** The directory the command ran from (default: process.cwd()); project configs are walked from here up to the project root. */
  startDir?: string;
  /** The environment for CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, APPDATA (default: process.env). */
  env?: NodeJS.ProcessEnv;
};

export type AdapterState = {
  permission: "configured" | "missing" | "manual" | "n/a";
  hooks: "configured" | "missing" | "partial" | "manual" | "n/a";
  /** Paths still holding a jubarteai MCP entry. */
  mcpEntries: string[];
  notes: string[];
};

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  /** skills@1.7.4 -a id (spec §9). */
  skillAgent: string | null;
  /** Env var for shell commands, if verified. */
  sessionVar: string | null;
  /** Per-prompt injection supported (spec §9 notes). */
  promptInjection: boolean;
  detect(env: DetectEnv): Promise<boolean>;
  /** PlanStep.sensitive = true; the "--no-permissions" flag is honoured by the caller. */
  permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null>;
  /** Sensitive; hook command: `${ctx.cliCommand} hook <session-start|user-prompt-submit|session-end> --harness <id>`. */
  hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null>;
  /** Read-only, for doctor. */
  inspect(ctx: InitCtx): Promise<AdapterState>;
  /** Sensitive steps; report-only cases come back as ManualInstructions ("skipped: <reason>, remove it by hand: <path>"). */
  mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>>;
  /** Codex network opt-in (spec §6.1 step 7). */
  extras?(ctx: InitCtx): Promise<Array<PlanStep | ManualInstructions>>;
}
