import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsHookLines } from "./background.js";
import { emptyState, lockPath, readState, writeState } from "./state.js";
import { runSync } from "./sync.js";
import type { SyncDeps } from "./sync.js";

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

// Review R-S1: a background sync can't print, so a skills folder it skipped because it is a symlink (a shared
// `.claude/skills`, say) must reach the agent through the next hook — once — instead of a bare "synced" line
// that leaves a Claude Code user without their company skills and without knowing why.
describe("a background sync that skipped a symlinked skills folder", () => {
  const SKILL_MD = Buffer.from("---\nname: alpha\ndescription: d\n---\nbody\n");
  const DIGEST = "a".repeat(64);
  const call: SyncDeps["call"] = async (_seat, tool) =>
    tool === "list_skills"
      ? { exitCode: 0, envelope: { messages: [], result: { skills_revision: 3, skills: [{ name: "alpha", revision_id: "r", digest: DIGEST }] } } }
      : {
          exitCode: 0,
          envelope: {
            messages: [],
            result: {
              name: "alpha",
              revision_id: "r",
              digest: DIGEST,
              files: [{ path: "SKILL.md", size: SKILL_MD.length, sha256: createHash("sha256").update(SKILL_MD).digest("hex"), executable: false, url: "https://storage.test/a" }],
            },
          },
        };
  const download: SyncDeps["download"] = async () => SKILL_MD;

  it.skipIf(process.platform === "win32")("tells the agent once, naming the folder, on the next hook", async () => {
    const outside = join(root, "shared-skills");
    mkdirSync(outside);
    mkdirSync(join(top, ".claude"));
    symlinkSync(outside, join(top, ".claude/skills"));

    const r = await runSync({ seat: { origin: ORIGIN, token: "jba_x" }, agentId: "aaaaaaaa-0000-4000-8000-00000000000a", top, workspaceId: "ws-1", background: true, deps: { call, download, now: () => 1 } });
    expect(r.status).toBe("synced");
    expect(readdirSync(outside)).toEqual([]);

    const first = skillsHookLines(input(), { spawnSync: vi.fn() });
    const skipLines = first.filter((line) => line.includes(".claude/skills"));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toMatch(/symlink/i);

    const second = skillsHookLines(input(), { spawnSync: vi.fn() });
    expect(second.filter((line) => line.includes(".claude/skills"))).toEqual([]);
  });

  // Review CR-7: a folder that becomes a symlink after the last sync (no new skills_revision, so no new sync) must
  // still reach the agent, and a folder that stops and starts being one again is told again.
  it.skipIf(process.platform === "win32")("tells the agent when a folder becomes a symlink after the last sync, and again after it comes back", async () => {
    const seat = { origin: ORIGIN, token: "jba_x" };
    const agentId = "aaaaaaaa-0000-4000-8000-00000000000a";
    await runSync({ seat, agentId, top, workspaceId: "ws-1", background: false, deps: { call, download, now: () => 1 } });
    const skipLines = () => skillsHookLines(input(), { spawnSync: vi.fn() }).filter((line) => line.includes(".claude/skills"));
    expect(skipLines()).toEqual([]);

    const outside = join(root, "shared-skills");
    mkdirSync(outside);
    rmSync(join(top, ".claude/skills"), { recursive: true, force: true });
    symlinkSync(outside, join(top, ".claude/skills"));
    const told = skipLines();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/symlink/i);
    expect(skipLines()).toEqual([]);

    rmSync(join(top, ".claude/skills"));
    expect(skipLines()).toEqual([]);
    symlinkSync(outside, join(top, ".claude/skills"));
    expect(skipLines()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("stays quiet in a repo that never synced company skills", () => {
    mkdirSync(join(top, ".claude"));
    const outside = join(root, "shared-skills");
    mkdirSync(outside);
    symlinkSync(outside, join(top, ".claude/skills"));
    expect(skillsHookLines(input(), { spawnSync: vi.fn() })).toEqual([]);
  });
});
