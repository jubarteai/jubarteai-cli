import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skippedTargets, syncTargets } from "./targets.js";

const itPosix = process.platform === "win32" ? it.skip : it;
let top: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "jba-targets-")));
  top = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(top);
  mkdirSync(outside);
});
afterEach(() => rmSync(join(top, ".."), { recursive: true, force: true }));

describe("syncTargets / skippedTargets", () => {
  it("syncs the two common folders and skips nothing in a plain repo", () => {
    expect(syncTargets(top)).toEqual([".agents/skills", ".claude/skills"]);
    expect(skippedTargets(top)).toEqual([]);
  });

  itPosix("reports a symlinked target as skipped instead of dropping it silently", () => {
    mkdirSync(join(top, ".claude"));
    symlinkSync(outside, join(top, ".claude/skills"));
    expect(syncTargets(top)).toEqual([".agents/skills"]);
    expect(skippedTargets(top)).toEqual([".claude/skills"]);
  });

  itPosix("treats a symlinked parent folder as a skipped target too", () => {
    symlinkSync(outside, join(top, ".agents"));
    expect(syncTargets(top)).toEqual([".claude/skills"]);
    expect(skippedTargets(top)).toEqual([".agents/skills"]);
  });
});
