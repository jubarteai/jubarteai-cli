import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsHookLines } from "./background.js";
import { emptyState, lockPath, readState, writeState } from "./state.js";

const ORIGIN = "https://app.test";
let root: string;
let top: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jb-skills-hook-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  top = join(root, "repo");
  mkdirSync(top);
  execFileSync("git", ["init", "-q"], { cwd: top });
});
afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(root, { recursive: true, force: true });
});

const seat = { origin: ORIGIN, seatId: "seat-1", token: "jba_x" };
const input = (extra: Partial<Parameters<typeof skillsHookLines>[0]> = {}) => ({
  cwd: top,
  bindingRoot: top,
  seat,
  agentId: "aaaaaaaa-0000-4000-8000-00000000000a",
  revision: 3 as number | undefined,
  ...extra,
});

describe("skillsHookLines", () => {
  it("starts one detached sync when the server revision differs, and never waits for it", () => {
    const spawnSync = vi.fn();
    expect(skillsHookLines(input(), { spawnSync, now: () => 1 })).toEqual([]);
    expect(spawnSync).toHaveBeenCalledWith(expect.stringContaining("repo"), "aaaaaaaa-0000-4000-8000-00000000000a", 3);
  });
  it("does nothing when the revision matches, is unknown (an older server), or after a recent failure", () => {
    const spawnSync = vi.fn();
    writeState(top, { ...emptyState(ORIGIN), revision: 3 });
    skillsHookLines(input(), { spawnSync, now: () => 1 });
    skillsHookLines(input({ revision: undefined }), { spawnSync, now: () => 1 });
    writeState(top, { ...emptyState(ORIGIN), revision: 1, last_failure_at: 1_000_000 });
    skillsHookLines(input(), { spawnSync, now: () => 1_000_000 + 60_000 });
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("does not spawn on a resume (no agent), for an environment key, or while a sync holds the lock", () => {
    const spawnSync = vi.fn();
    skillsHookLines(input({ agentId: null }), { spawnSync });
    skillsHookLines(input({ seat: { ...seat, seatId: null } }), { spawnSync });
    mkdirSync(join(root, "config/jubarteai/company-skills"), { recursive: true });
    writeFileSync(lockPath(top), "1\n");
    skillsHookLines(input(), { spawnSync, now: () => Date.now() });
    expect(spawnSync).not.toHaveBeenCalled();
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath(top), old, old);
    skillsHookLines(input(), { spawnSync, now: () => Date.now() });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  it("injects pending notices and unreported clashes once", () => {
    writeState(top, {
      ...emptyState(ORIGIN),
      revision: 3,
      pending_notice: ["Company skills synced: 1 added, 0 updated, 0 removed."],
      clashes: { alpha: { reported: false, dir: ".claude/skills" }, beta: { reported: true, dir: ".claude/skills" } },
    });
    const first = skillsHookLines(input(), { spawnSync: vi.fn() });
    expect(first).toEqual([
      "Company skills synced: 1 added, 0 updated, 0 removed.",
      "Company skill `alpha` was not synced: .claude/skills/alpha already exists and isn't managed by JubarteAI (jubarteai skills status).",
    ]);
    expect(readState(top, ORIGIN).pending_notice).toEqual([]);
    expect(skillsHookLines(input(), { spawnSync: vi.fn() })).toEqual([]);
  });
  it("never throws, and keeps the injected text short", () => {
    writeState(top, { ...emptyState(ORIGIN), revision: 3, pending_notice: ["x".repeat(5000)] });
    const lines = skillsHookLines(input(), { spawnSync: vi.fn() });
    expect(lines[0]?.length).toBeLessThanOrEqual(400);
    expect(() => skillsHookLines(input({ cwd: "/definitely/not/here", bindingRoot: "/definitely/not/here" }), { spawnSync: vi.fn() })).not.toThrow();
  });
});
