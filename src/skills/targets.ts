import { existsSync } from "node:fs";
import { join } from "node:path";
import { SKILL_AGENT_DIRS } from "../install/constants.js";

/** The skill folders every repo gets. Claude Code reads .claude/skills; every other harness the CLI knows reads .agents/skills. */
export const ALWAYS_TARGETS: readonly string[] = [".claude/skills", ".agents/skills"];

/**
 * Where company skills are written in the repo at `top`: the two common folders, plus any other harness
 * folder `init` set up here (it holds jubarteai/SKILL.md) — that is how `.windsurf/skills` is detected.
 */
export function syncTargets(top: string): string[] {
  const targets = new Set<string>(ALWAYS_TARGETS);
  for (const dirs of Object.values(SKILL_AGENT_DIRS)) {
    if (existsSync(join(top, dirs.project, "jubarteai", "SKILL.md"))) targets.add(dirs.project);
  }
  return [...targets].sort();
}
