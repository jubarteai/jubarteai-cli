// GitHub Copilot CLI adapter (spec §9). The persistent permission rule is unverified (the only documented ways are the
// `--allow-tool` flag and CLI-managed per-project approvals), so it is printed instructions (D25). The printed flags
// allow each agent command by name (`shell(jubarteai search-knowledge)`: Copilot approves shell commands by first-level
// subcommand) and deny each person command (`--deny-tool` always wins over `--allow-tool`, `--allow-all-tools` and
// saved approvals, per GitHub's "Allowing tools" page). Copilot CLI sets no environment variable the CLI could detect,
// so these flags are the only guard against an agent running login, link, init, update or logout (spec I6, review R-M3):
// a whole-program `shell(jubarteai:*)` is never printed as something to use. Hooks are session start
// and end only, in the same ~/.copilot/hooks/jubarteai.json that VS Code uses: the shared writer in vscode.ts does the
// write (through editJsonFile, I6), so this module writes nothing itself. Per-prompt injection is unsupported (the
// `userPromptSubmitted` output is dropped). install.sh never wrote a Copilot CLI MCP entry, so there is nothing to clean.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import { AGENT_RULE_WORDS, PERSON_COMMANDS, PERSON_COMMAND_LIST } from "./agent-commands.js";
import { copilotHooksPlan, copilotHooksState } from "./vscode.js";
import type { AdapterState, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "copilot-cli" as const;
/** One allow flag per agent command (and --help/--version), then one deny flag per person command. */
export const COPILOT_PERMISSION_FLAGS = [
  ...AGENT_RULE_WORDS.map((word) => `--allow-tool='shell(jubarteai ${word})'`),
  ...PERSON_COMMANDS.map((command) => `--deny-tool='shell(jubarteai ${command})'`),
].join(" ");

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
      title: "GitHub Copilot CLI: allow the jubarteai agent commands",
      lines: [
        "To stop Copilot CLI asking before each jubarteai agent command, start it with these flags. They allow the agent commands by name and deny " +
          `${PERSON_COMMAND_LIST} (a deny always wins), so the agent can't change your saved account, the repo binding or your harness files; run those yourself in a terminal:`,
        `copilot ${COPILOT_PERMISSION_FLAGS}`,
        `To make that the default, add this to your shell profile: alias copilot="copilot ${COPILOT_PERMISSION_FLAGS}"`,
        `Don't use --allow-tool='shell(jubarteai:*)', --allow-all-tools or a saved approval for every jubarteai command without those --deny-tool flags: each also pre-approves ${PERSON_COMMAND_LIST}, and Copilot CLI sets no variable the CLI can use to refuse them.`,
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
      notes: [
        "Copilot CLI has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill",
        `the permission is printed, not written: start Copilot CLI with the --allow-tool flags for the agent commands and the --deny-tool flags for ${PERSON_COMMAND_LIST} (\`jubarteai init\` prints them)`,
      ],
    };
  },

  // install.sh never wrote a Copilot CLI MCP entry.
  async mcpCleanup(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },
};
