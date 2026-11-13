import { existsSync, lstatSync } from "node:fs";
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
  return [...targets].filter((t) => !leavesRepository(top, t)).sort();
}

/**
 * True when `<top>/<target>` or one of its parents is a symlink. The sync creates folders, writes files and
 * deletes under a target, so a symlinked `.claude` or `.claude/skills` (a shared skills folder, or a planted
 * link) would send those writes outside the repository. Such a target is left entirely alone.
 */
export function leavesRepository(top: string, target: string): boolean {
  let current = top;
  for (const part of target.split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false; // not there yet: nothing to follow
    }
  }
  return false;
}
