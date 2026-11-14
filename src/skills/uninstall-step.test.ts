import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("../prompt.js", () => ({ confirm: confirmMock, isInteractive: () => true }));

import { companySkillsRemoval, KEEP_HINT } from "./uninstall-step.js";
import { installSkill } from "./writer.js";

let root: string;
const marker = { v: 1 as const, workspace_id: "ws", revision_id: "r", digest: "d".repeat(64), synced_at: "" };
const files = [{ path: "SKILL.md", bytes: Buffer.from("x"), executable: false }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jb-un-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  execFileSync("git", ["init", "-q"], { cwd: root });
  installSkill(join(root, ".claude/skills"), "alpha", files, marker);
  mkdirSync(join(root, ".claude/skills/mine"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/mine/SKILL.md"), "mine");
  confirmMock.mockReset();
});
afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("companySkillsRemoval", () => {
  it("offers nothing when no synced skills exist", async () => {
    rmSync(join(root, ".claude"), { recursive: true });
    expect(await companySkillsRemoval(root, { yes: true, tty: true, projectRoot: root })).toEqual({ step: null, keptHint: null });
  });
  it("keeps them without a terminal and without --yes, and says how to remove them", async () => {
    expect(await companySkillsRemoval(root, { yes: false, tty: false, projectRoot: root })).toEqual({ step: null, keptHint: KEEP_HINT });
    expect(confirmMock).not.toHaveBeenCalled();
  });
  it("asks on a terminal with default No, and keeps them on No", async () => {
    confirmMock.mockResolvedValue(false);
    const r = await companySkillsRemoval(root, { yes: false, tty: true, projectRoot: root });
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Remove 1 synced company skill folder"), { defaultYes: false });
    expect(r).toEqual({ step: null, keptHint: KEEP_HINT });
  });
  it("removes only managed folders on yes, never an unmanaged one", async () => {
    const r = await companySkillsRemoval(root, { yes: true, tty: false, projectRoot: root });
    expect(r.step).not.toBeNull();
    const result = await r.step!.apply();
    expect(result.status).toBe("configured");
    expect(existsSync(join(root, ".claude/skills/alpha"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/mine/SKILL.md"))).toBe(true);
  });
});
