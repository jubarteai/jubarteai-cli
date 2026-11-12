// GitHub Copilot CLI adapter (spec §9). The CLI writes and prints no Copilot CLI permission rule (D25, review R-M4).
// GitHub documents first-level subcommand matching for `shell(...)` rules only for git and gh ("Configure Copilot
// CLI"; `copilot help permissions`: "In most cases, this will be an exact match against the command name"), and a
// session approval of one command approves every command with that name. So `--allow-tool='shell(jubarteai
// search-knowledge)'` most likely matches nothing, and a `--deny-tool='shell(jubarteai login)'` can't be trusted to keep
// login out of a session or repository approval of jubarteai. Copilot CLI sets no environment variable the CLI could
// detect, so the `jubarteai` commands themselves can't refuse login, link, init, update or logout either (spec I6).
// The guard is the deny-only `preToolUse` hook the shared hooks step registers (review R-S12): GitHub documents that
// a hook's deny blocks the call whatever was approved, so a session or repository approval, a whole-program
// `shell(jubarteai:*)`, `--allow-all-tools` or `--yolo` no longer lets an agent run the five. It is best effort (a
// script file or a variable hides a command), so the printed lines still say to approve each jubarteai command once.
// Unverified on a real Copilot CLI; if subcommand matching is confirmed for any program, per-command flags can come back.
// Hooks are session start, session end and the guard, in the same ~/.copilot/hooks/jubarteai.json that VS Code uses:
// the shared writer in vscode.ts does the write (through editJsonFile, I6), so this module writes nothing itself.
// Per-prompt injection is unsupported (the `userPromptSubmitted` output is dropped). install.sh never wrote a Copilot
// CLI MCP entry, so there is nothing to clean.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import { PERSON_COMMAND_LIST } from "./agent-commands.js";
import { copilotGuardMissingNote, copilotHooksFile, copilotHooksPlan, copilotHooksRemoval, copilotHooksState } from "./vscode.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "copilot-cli" as const;

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

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    return {
      kind: "manual",
      harness: HARNESS,
      title: "GitHub Copilot CLI: approve jubarteai commands one at a time",
      lines: [
        `Copilot CLI approves programs other than git and gh by name, so approving any jubarteai command for the session or for this repository also approves ${PERSON_COMMAND_LIST}: the commands that change your saved account, the repo binding and your harness files.`,
        `The session hooks step also registers a preToolUse guard in ${copilotHooksFile(ctx)} that denies an agent's shell call naming ${PERSON_COMMAND_LIST}, whatever was approved. It approves nothing, and it is best effort: a command hidden in a script file or a variable gets past it.`,
        "The CLI therefore prints no Copilot CLI allow flags. When Copilot CLI asks before a jubarteai command, approve that one command, not every jubarteai command for the session or the repository.",
        `--allow-tool='shell(jubarteai)', --allow-tool='shell(jubarteai:*)', --allow-all-tools and --yolo also pre-approve ${PERSON_COMMAND_LIST}, leaving only the guard in the way: run those five yourself in a terminal.`,
      ],
      reason: "Copilot CLI matches a shell rule by subcommand only for git and gh, so no rule can approve the agent commands without the person commands (D25, review R-M4)",
      rules: [],
    };
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    return copilotHooksPlan(ctx, HARNESS);
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const notes = [
      "Copilot CLI has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill",
      `no permission rule is written or printed: approve each jubarteai command once when Copilot CLI asks; a session or repository approval of jubarteai also approves ${PERSON_COMMAND_LIST}, which only the preToolUse guard then denies`,
    ];
    const guardNote = copilotGuardMissingNote(ctx);
    if (guardNote !== null) notes.push(guardNote);
    return { permission: "manual", hooks: copilotHooksState(ctx), mcpEntries: [], notes };
  },

  /** The shared hook file, the same step VS Code returns (the caller runs it once). */
  async uninstall(ctx: InitCtx): Promise<Array<PlanStep | ManualInstructions>> {
    const step = copilotHooksRemoval(ctx);
    return step === null ? [] : [step];
  },

  // install.sh never wrote a Copilot CLI MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
