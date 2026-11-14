import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallOutcome } from "../mcp/client.js";
import { runSync } from "./sync.js";
import type { SyncDeps } from "./sync.js";
import { acquireLock } from "./lock.js";
import { inBackoff, lockPath, readState, shouldSync, statePath } from "./state.js";
import { listManaged, readMarker } from "./writer.js";
import { EXCLUDE_BEGIN } from "./exclude.js";

const ORIGIN = "https://app.test";
const WS = "ws-1";
const AGENT = "aaaaaaaa-0000-4000-8000-00000000000a";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const HEX = (c: string) => c.repeat(64);

type FakeSkill = { name: string; digest: string; files: { path: string; bytes: Buffer; executable?: boolean }[]; revision_id?: string };

let root: string;
let top: string;
let skills: FakeSkill[];
let revision: number;
let listError: string | null;
let calls: { tool: string; args: Record<string, unknown> }[];
let downloads: Map<string, Buffer>;
let tamper: ((url: string) => Buffer | null) | null;

function ok(result: unknown): CallOutcome {
  return { envelope: { messages: [], result }, exitCode: 0 };
}

const call: SyncDeps["call"] = async (_seat, tool, args) => {
  calls.push({ tool, args });
  if (tool === "list_skills") {
    if (listError) return { envelope: { messages: [], error: listError }, exitCode: 1 };
    return ok({ skills_revision: revision, skills: skills.map((s) => ({ name: s.name, revision_id: s.revision_id ?? `rev-${s.name}`, digest: s.digest })) });
  }
  const skill = skills.find((s) => s.name === args["name"]);
  if (!skill) return { envelope: { messages: [], error: `No enabled company skill named \`${String(args["name"])}\`.` }, exitCode: 1 };
  return ok({
    name: skill.name,
    revision_id: skill.revision_id ?? `rev-${skill.name}`,
    digest: skill.digest,
    files: skill.files.map((f) => {
      const url = `https://storage.test/${skill.name}/${f.path}`;
      downloads.set(url, f.bytes);
      return { path: f.path, size: f.bytes.length, sha256: sha(f.bytes), executable: f.executable === true, url };
    }),
  });
};

const download: SyncDeps["download"] = async (url, opts) => {
  const bytes = tamper?.(url) ?? downloads.get(url);
  if (!bytes) throw new Error("missing");
  if (bytes.length !== opts.size || sha(bytes) !== opts.sha256) {
    const { DownloadError } = await import("./download.js");
    throw new DownloadError("digest");
  }
  return bytes;
};

function opts(extra: Partial<Parameters<typeof runSync>[0]> = {}) {
  return { seat: { origin: ORIGIN, token: "jba_x" }, agentId: AGENT, top, workspaceId: WS, background: false, deps: { call, download, now: () => 1_000_000 }, ...extra };
}

function skillMd(name: string) {
  return Buffer.from(`---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

const alpha = (digest = HEX("a")): FakeSkill => ({
  name: "alpha",
  digest,
  files: [{ path: "SKILL.md", bytes: skillMd("alpha") }, { path: "scripts/run.sh", bytes: Buffer.from("#!/bin/sh\n"), executable: true }],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jb-skills-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  top = join(root, "repo");
  mkdirSync(top);
  execFileSync("git", ["init", "-q"], { cwd: top });
  skills = [];
  revision = 1;
  listError = null;
  calls = [];
  downloads = new Map();
  tamper = null;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("runSync", () => {
  it("writes both target folders with markers, exec bits and one exclude block", async () => {
    skills = [alpha()];
    const r = await runSync(opts());
    expect(r).toMatchObject({ status: "synced", added: ["alpha"], updated: [], removed: [], skills: 1, revision: 1, createdFolder: true });
    for (const t of [".claude/skills", ".agents/skills"]) {
      expect(readFileSync(join(top, t, "alpha/SKILL.md"), "utf8")).toContain("name: alpha");
      expect(readMarker(join(top, t, "alpha"))).toMatchObject({ name: "alpha", digest: HEX("a"), workspace_id: WS });
      if (process.platform !== "win32") expect(statSync(join(top, t, "alpha/scripts/run.sh")).mode & 0o111).not.toBe(0);
    }
    const exclude = readFileSync(join(top, ".git/info/exclude"), "utf8");
    expect(exclude).toContain(EXCLUDE_BEGIN);
    expect(exclude).toContain("/.claude/skills/alpha/");
    expect(exclude).toContain("/.agents/skills/alpha/");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: top, encoding: "utf8" })).toBe("");
  });

  it("is a no-op with no network when nothing changed, and re-downloads only a changed skill", async () => {
    skills = [alpha()];
    await runSync(opts());
    calls = [];
    const again = await runSync(opts());
    expect(again).toMatchObject({ status: "synced", added: [], updated: [], removed: [] });
    expect(calls.map((c) => c.tool)).toEqual(["list_skills"]);
    const skipped = await runSync(opts({ ifChanged: 1 }));
    expect(skipped.status).toBe("unchanged");

    skills = [alpha(HEX("b"))];
    revision = 2;
    calls = [];
    const r = await runSync(opts());
    expect(r.updated).toEqual(["alpha"]);
    expect(calls.map((c) => c.tool)).toEqual(["list_skills", "get_skill"]);
    expect(readMarker(join(top, ".claude/skills/alpha"))?.digest).toBe(HEX("b"));
  });

  it("never touches an unmanaged folder of the same name and reports the clash", async () => {
    mkdirSync(join(top, ".claude/skills/alpha"), { recursive: true });
    writeFileSync(join(top, ".claude/skills/alpha/SKILL.md"), "mine");
    skills = [alpha()];
    const r = await runSync(opts());
    expect(r.clashes).toEqual([{ name: "alpha", dir: ".claude/skills" }]);
    expect(readFileSync(join(top, ".claude/skills/alpha/SKILL.md"), "utf8")).toBe("mine");
    expect(readMarker(join(top, ".agents/skills/alpha"))).not.toBeNull();
    expect(readState(top, ORIGIN).clashes["alpha"]).toEqual({ reported: false, dir: ".claude/skills" });
  });

  it("removes managed folders when a skill is disabled, and the exclude lines with them", async () => {
    skills = [alpha()];
    await runSync(opts());
    skills = [];
    revision = 2;
    const r = await runSync(opts());
    expect(r.removed).toEqual(["alpha"]);
    expect(existsSync(join(top, ".claude/skills/alpha"))).toBe(false);
    expect(readFileSync(join(top, ".git/info/exclude"), "utf8")).not.toContain("alpha");
  });

  it("removes the old workspace's folders on a workspace switch", async () => {
    skills = [alpha()];
    await runSync(opts());
    skills = [];
    const r = await runSync(opts({ workspaceId: "ws-2" }));
    expect(r.removed).toEqual(["alpha"]);
    expect(listManaged(join(top, ".claude/skills")).size).toBe(0);
  });

  it("keeps the old folder when a download fails verification, and holds retries off for 10 minutes", async () => {
    skills = [alpha()];
    await runSync(opts());
    skills = [alpha(HEX("c"))];
    revision = 2;
    tamper = () => Buffer.from("corrupt");
    const r = await runSync(opts());
    expect(r.status).toBe("failed");
    expect(readMarker(join(top, ".claude/skills/alpha"))?.digest).toBe(HEX("a"));
    expect(readFileSync(join(top, ".claude/skills/alpha/SKILL.md"), "utf8")).toContain("name: alpha");
    const state = readState(top, ORIGIN);
    expect(state.revision).toBe(1);
    expect(inBackoff(state, 1_000_000 + 60_000)).toBe(true);
    expect(shouldSync(state, 2, 1_000_000 + 60_000)).toBe(false);
    expect(shouldSync(state, 2, 1_000_000 + 11 * 60_000)).toBe(true);
    expect((await runSync(opts({ background: true }))).status).toBe("backoff");
  });

  it("refuses a manifest path that would leave the skill folder", async () => {
    skills = [{ name: "evil", digest: HEX("e"), files: [{ path: "SKILL.md", bytes: skillMd("evil") }, { path: "../escape.txt", bytes: Buffer.from("x") }] }];
    const r = await runSync(opts());
    expect(r.status).toBe("failed");
    expect(existsSync(join(top, ".claude/skills/evil"))).toBe(false);
    expect(existsSync(join(top, ".claude/escape.txt"))).toBe(false);
    expect(existsSync(join(top, "escape.txt"))).toBe(false);
  });

  it("treats an older server without the tool as zero skills", async () => {
    skills = [alpha()];
    await runSync(opts());
    listError = "Unknown tool: list_skills";
    const r = await runSync(opts());
    expect(r.status).toBe("synced");
    expect(r.removed).toEqual(["alpha"]);
  });

  it("forgets the revision after an older server answered, so the same revision syncs again when it returns", async () => {
    skills = [alpha()];
    revision = 7;
    await runSync(opts());
    expect(readState(top, ORIGIN).revision).toBe(7);
    listError = "Unknown tool: list_skills";
    await runSync(opts());
    expect(readState(top, ORIGIN).revision).toBeNull();
    listError = null;
    const r = await runSync(opts({ ifChanged: 7 }));
    expect(r.status).toBe("synced");
    expect(r.added).toEqual(["alpha"]);
  });

  it("leaves a symlinked skills folder alone instead of writing through it", async () => {
    if (process.platform === "win32") return;
    skills = [alpha()];
    const outside = join(root, "shared-skills");
    mkdirSync(outside);
    mkdirSync(join(top, ".claude"), { recursive: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(top, ".claude/skills"));
    const r = await runSync(opts());
    expect(r.status).toBe("synced");
    expect(readdirSync(outside)).toEqual([]);
    expect(readMarker(join(top, ".agents/skills/alpha"))).not.toBeNull();
  });

  it("fails without changing anything on a transport error", async () => {
    skills = [alpha()];
    await runSync(opts());
    const down: SyncDeps["call"] = async () => ({ envelope: { messages: [], error: "x", code: "network_error" }, exitCode: 4 });
    const r = await runSync(opts({ deps: { call: down, download, now: () => 2_000_000 } }));
    expect(r.status).toBe("failed");
    expect(readMarker(join(top, ".claude/skills/alpha"))).not.toBeNull();
  });

  it("targets .windsurf/skills only when init set it up", async () => {
    skills = [alpha()];
    await runSync(opts());
    expect(existsSync(join(top, ".windsurf"))).toBe(false);
    mkdirSync(join(top, ".windsurf/skills/jubarteai"), { recursive: true });
    writeFileSync(join(top, ".windsurf/skills/jubarteai/SKILL.md"), "x");
    revision = 2;
    await runSync(opts());
    expect(readMarker(join(top, ".windsurf/skills/alpha"))).not.toBeNull();
  });

  it("cleans temp folders a crashed sync left behind and ignores symlinked skill folders", async () => {
    skills = [alpha()];
    mkdirSync(join(top, ".claude/skills/.jubarteai-tmp-alpha-dead"), { recursive: true });
    await runSync(opts());
    expect(readdirSync(join(top, ".claude/skills")).filter((n) => n.startsWith(".jubarteai-tmp-"))).toEqual([]);
    if (process.platform !== "win32") {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, ".jubarteai-skill.json"), JSON.stringify({ v: 1, name: "beta", revision_id: "r", digest: HEX("d"), workspace_id: WS, synced_at: "" }));
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(top, ".claude/skills/beta"));
      expect(readMarker(join(top, ".claude/skills/beta"))).toBeNull();
      skills = [alpha()];
      revision = 2;
      await runSync(opts());
      expect(lstatSync(join(top, ".claude/skills/beta")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, ".jubarteai-skill.json"))).toBe(true);
    }
  });

  it("leaves a background notice for the next hook", async () => {
    skills = [alpha()];
    await runSync(opts({ background: true }));
    const state = readState(top, ORIGIN);
    expect(state.pending_notice).toEqual([
      "Company skills synced: 1 added, 0 updated, 0 removed.",
      "New company skills folder created — start a new session (or /reload-skills in Claude Code) to load them.",
    ]);
  });

  it("runs one sync at a time: a second concurrent run exits as locked", async () => {
    skills = [alpha()];
    const held = acquireLock(lockPath(top));
    expect(held).not.toBeNull();
    expect((await runSync(opts())).status).toBe("locked");
    held!.release();
    expect((await runSync(opts())).status).toBe("synced");
  });

  it("takes over a stale lock", async () => {
    mkdirSync(join(root, "config/jubarteai/company-skills"), { recursive: true });
    const stale = acquireLock(lockPath(top))!;
    expect(stale).not.toBeNull();
    expect(acquireLock(lockPath(top), () => Date.now() + 6 * 60_000)).not.toBeNull();
    void statePath;
    void vi;
  });
});
