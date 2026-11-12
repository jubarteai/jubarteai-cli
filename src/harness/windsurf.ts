// Windsurf ("Devin Desktop (Windsurf)") adapter (spec §9). Only detection, the skill id and MCP cleanup are verified.
// The permission and hook formats that are documented belong to Devin Local, a different product surface the
// coordinator did not adopt for v1, and the legacy Cascade formats are undocumented, so both come back as printed
// instructions (D25). The permission lines write no rule for the bare program: Windsurf's allow list matches by prefix, so
// `jubarteai` would also pre-approve the person commands, and Windsurf sets no variable the CLI could use to refuse
// them (spec I6, review R-M3). They put the person commands on the deny list first (review R-N11): the current Devin
// Local terminal docs say "Deny rules have the highest priority"; how the legacy Cascade lists rank against its Turbo
// level is not documented (review R-N15). The agent commands appear only in the optional allow entries. Cleanup touches install.sh's one path, ~/.codeium/windsurf/mcp_config.json (`mcpServers.jubarteai`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import { PERSON_COMMANDS, PERSON_COMMAND_LIST } from "./agent-commands.js";
import { cleanupScopeOf, manual } from "./cursor.js";
import { findMcpEntries, mcpCleanupFor } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "windsurf" as const;
const LABEL = "Windsurf";

/** The deny-list entries for the person commands, quoted for prose. */
const DENY_ENTRIES = PERSON_COMMANDS.map((command) => `"jubarteai ${command}"`).join(", ");
/** The agent-command allow entries the printed lines give as examples. */
const EXAMPLE_ALLOW = ["jubarteai search-knowledge", "jubarteai inbox"] as const;

const windsurfDir = (home: string): string => join(home, ".codeium", "windsurf");

export const windsurfAdapter: HarnessAdapter = {
  id: HARNESS,
  label: LABEL,
  skillAgent: "windsurf",
  sessionVar: null,
  promptInjection: false,

  /** The CLI never wrote a Windsurf rule or hook (they are printed), so there is nothing to remove. */
  async uninstall(): Promise<Array<PlanStep | ManualInstructions>> {
    return [];
  },

  async detect(env: DetectEnv): Promise<boolean> {
    return existsSync(windsurfDir(env.home));
  },

  async permission(): Promise<PlanStep | ManualInstructions | null> {
    return manual(
      HARNESS,
      "Windsurf: approve jubarteai commands as Windsurf asks",
      [
        `First, add ${DENY_ENTRIES} to Windsurf's terminal deny list: these five change your saved account, the repo binding and your harness files. Windsurf's current terminal docs say deny rules have the highest priority; how an older Windsurf's auto-execution levels treat the lists is not documented, so put the deny entries in before anything else.`,
        `Windsurf's terminal allow list matches by prefix, so an entry for jubarteai would also pre-approve ${PERSON_COMMAND_LIST}. The CLI therefore writes no Windsurf rule. Approve jubarteai commands when Windsurf asks.`,
        `To skip some prompts, add agent commands one by one to the allow list (for example ${EXAMPLE_ALLOW.map((entry) => `"${entry}"`).join(", ")}), never jubarteai alone. How Windsurf matches a chained command such as "jubarteai inbox && jubarteai login" is not verified, so approving as asked is the safe choice.`,
        "(Windsurf documents no settings file for these lists, so the CLI does not write one)",
      ],
      "Windsurf's permission format is not verified (D25); a whole-program entry would also pre-approve the person commands",
      [...PERSON_COMMANDS.map((command) => ({ effect: "deny" as const, entry: `jubarteai ${command}` })), ...EXAMPLE_ALLOW.map((entry) => ({ effect: "allow" as const, entry }))],
    );
  },

  async hooks(): Promise<PlanStep[] | ManualInstructions | null> {
    return manual(
      HARNESS,
      "Windsurf: session hooks",
      [
        "The CLI does not register session hooks in Windsurf.",
        "Run `jubarteai connect` at the start of a session and pass --agent <id> on every jubarteai command; the skill and the AGENTS.md section say the same.",
      ],
      "Windsurf's hook format is not verified (D25)",
    );
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    return {
      permission: "manual",
      hooks: "manual",
      mcpEntries: await findMcpEntries(HARNESS, cleanupScopeOf(ctx)),
      notes: [`Windsurf's permission and hook formats are not verified; approve jubarteai commands as Windsurf asks, and never allow jubarteai alone (it would also pre-approve ${PERSON_COMMAND_LIST})`],
    };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },
};
