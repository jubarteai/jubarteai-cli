// Windsurf ("Devin Desktop (Windsurf)") adapter (spec §9). Only detection, the skill id and MCP cleanup are verified.
// The permission and hook formats that are documented belong to Devin Local, a different product surface the
// coordinator did not adopt for v1, and the legacy Cascade formats are undocumented, so both come back as printed
// instructions (D25). The permission lines write no rule for the bare program: Windsurf's allow list matches by prefix, so
// `jubarteai` would also pre-approve the person commands, and Windsurf sets no variable the CLI could use to refuse
// them (spec I6, review R-M3). They name agent commands only and put the person commands on the deny list. Cleanup touches install.sh's one path, ~/.codeium/windsurf/mcp_config.json (`mcpServers.jubarteai`).
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

const windsurfDir = (home: string): string => join(home, ".codeium", "windsurf");

export const windsurfAdapter: HarnessAdapter = {
  id: HARNESS,
  label: LABEL,
  skillAgent: "windsurf",
  sessionVar: null,
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    return existsSync(windsurfDir(env.home));
  },

  async permission(): Promise<PlanStep | ManualInstructions | null> {
    return manual(
      HARNESS,
      "Windsurf: approve jubarteai commands as Windsurf asks",
      [
        `Windsurf's terminal allow list matches by prefix, so an entry for jubarteai would also pre-approve ${PERSON_COMMAND_LIST}: the commands that change your saved account, the repo binding and your harness files.`,
        "The CLI therefore writes no Windsurf rule. Approve jubarteai commands when Windsurf asks.",
        `To skip some prompts, add agent commands one by one to the allow list (for example "jubarteai search-knowledge", "jubarteai inbox"), never jubarteai alone, and add ${DENY_ENTRIES} to the deny list. How Windsurf matches a chained command such as "jubarteai inbox && jubarteai login" is not verified, so approving as asked is the safe choice.`,
        "(Windsurf documents no settings file for these lists, so the CLI does not write one)",
      ],
      "Windsurf's permission format is not verified (D25); a whole-program entry would also pre-approve the person commands",
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
