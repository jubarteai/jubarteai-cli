// GitHub Copilot CLI adapter (spec §9). The persistent permission rule is unverified (the only documented ways are the
// `--allow-tool` flag and CLI-managed per-project approvals), so it is printed instructions (D25). Hooks are session start
// and end only, in the same ~/.copilot/hooks/jubarteai.json that VS Code uses: the shared writer in vscode.ts does the
// write (through editJsonFile, I6), so this module writes nothing itself. Per-prompt injection is unsupported (the
// `userPromptSubmitted` output is dropped). install.sh never wrote a Copilot CLI MCP entry, so there is nothing to clean.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import { copilotHooksPlan, copilotHooksState } from "./vscode.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "copilot-cli" as const;
const ALLOW_TOOL_FLAG = "--allow-tool='shell(jubarteai:*)'";

/** `$COPILOT_HOME` when it is an absolute path, else `~/.copilot`. */
function copilotDir(home: string, env: NodeJS.ProcessEnv): string {
  const custom = env["COPILOT_HOME"];
  return custom !== undefined && custom !== "" && isAbsolute(custom) ? custom : join(home, ".copilot");
}

export const copilotCliAdapter: HarnessAdapter = {
  id: HARNESS,
  label: "GitHub Copilot CLI",
  // The same skills id as VS Code.
  skillAgent: "github-copilot",
  // The documented environment variables list no session id.
  sessionVar: null,
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    return env.which("copilot") !== null || existsSync(copilotDir(env.home, env.env));
  },

  async permission(): Promise<PlanStep | ManualInstructions | null> {
    return {
      kind: "manual",
      harness: HARNESS,
      title: "GitHub Copilot CLI: allow the jubarteai command",
      lines: [
        `Start Copilot CLI with ${ALLOW_TOOL_FLAG} so it stops asking before each jubarteai command.`,
        `To make that the default, add this to your shell profile: alias copilot="copilot ${ALLOW_TOOL_FLAG}"`,
      ],
      reason: "Copilot CLI has no documented user-wide allow setting, and its saved approvals are managed per project (not verified, D25)",
    };
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    return copilotHooksPlan(ctx, HARNESS);
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    return {
      permission: "manual",
      hooks: copilotHooksState(ctx),
      mcpEntries: [],
      notes: ["Copilot CLI has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill"],
    };
  },

  // install.sh never wrote a Copilot CLI MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
