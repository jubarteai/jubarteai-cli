// Windsurf ("Devin Desktop (Windsurf)") adapter (spec §9). Only detection, the skill id and MCP cleanup are verified.
// The permission and hook formats that are documented belong to Devin Local, a different product surface the
// coordinator did not adopt for v1, and the legacy Cascade formats are undocumented, so both come back as printed
// instructions (D25). Cleanup touches install.sh's one path, ~/.codeium/windsurf/mcp_config.json (`mcpServers.jubarteai`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import { cleanupScopeOf, manual } from "./cursor.js";
import { findMcpEntries, mcpCleanupFor } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "windsurf" as const;
const LABEL = "Windsurf";

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
      "Windsurf: allow the jubarteai command",
      ["In Windsurf, add the command jubarteai to the terminal command allow list in its settings.", "(Windsurf documents no settings file for it, so the CLI does not write one)"],
      "Windsurf's permission format is not verified (D25)",
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
      notes: ["Windsurf's permission and hook formats are not verified; add jubarteai to its terminal allow list by hand"],
    };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },
};
