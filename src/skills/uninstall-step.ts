// The uninstall step for company skills this CLI synced into a repository. Never removes a folder without our marker.
import { join } from "node:path";
import { gitTop } from "../git/layout.js";
import { confirm } from "../prompt.js";
import { repoGroup } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { writeExcludeBlock } from "./exclude.js";
import { deleteState } from "./state.js";
import { syncTargets } from "./targets.js";
import { listManaged, removeManaged } from "./writer.js";

export const KEEP_HINT = "Synced company skills were kept in this repo. To remove them: jubarteai skills clean";

export type SkillsRemoval = { step: PlanStep | null; keptHint: string | null };

export async function companySkillsRemoval(
  cwd: string,
  opts: { yes: boolean; tty: boolean; projectRoot: string },
): Promise<SkillsRemoval> {
  const top = gitTop(cwd) ?? opts.projectRoot;
  const targets = syncTargets(top);
  const found = targets.flatMap((target) => [...listManaged(join(top, target)).keys()].map((name) => ({ name, target })));
  if (found.length === 0) return { step: null, keptHint: null };

  let approved = opts.yes;
  if (!approved) {
    if (!opts.tty) return { step: null, keptHint: KEEP_HINT };
    approved = await confirm(`Remove ${found.length} synced company skill folder${found.length === 1 ? "" : "s"} from this repo?`, { defaultYes: false });
    if (!approved) return { step: null, keptHint: KEEP_HINT };
  }

  const id = "uninstall-company-skills";
  const label = `Company skills synced into this repo (${found.length})`;
  return {
    keptHint: null,
    step: {
      id,
      label,
      group: repoGroup(top),
      files: found.map((f) => `${f.target}/${f.name}`),
      sensitive: false,
      async apply(): Promise<StepResult> {
        let removed = 0;
        for (const { name, target } of found) if (removeManaged(join(top, target), name)) removed += 1;
        writeExcludeBlock(top, []);
        deleteState(top);
        return { id, label, status: removed > 0 ? "configured" : "already configured", detail: `removed ${removed} folder${removed === 1 ? "" : "s"}` };
      },
    },
  };
}
