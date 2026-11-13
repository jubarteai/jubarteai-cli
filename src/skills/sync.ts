// The company-skills sync: makes `<repo>/.claude/skills`, `<repo>/.agents/skills` (and any other harness folder
// `init` set up) match the skills the workspace has enabled. Skills are fetched with the MCP tools `list_skills`
// and `get_skill({ manifest: true })`, downloaded through the signed URLs the manifest carries, verified, staged
// and swapped in with renames. It never writes outside `<top>/<target>/<name>/`, never touches a folder it
// doesn't own (no valid marker), and records its state last.
import { existsSync as existsAny } from "node:fs";
import { basename, join } from "node:path";
import { SKILLS_MAX_FILES, SKILLS_MAX_TOTAL_BYTES, SKILLS_SYNC_TIMEOUT_MS } from "../constants.js";
import { linkedWorktree } from "../git/layout.js";
import { originSlug } from "../git/layout.js";
import { callTool } from "../mcp/client.js";
import type { CallOutcome } from "../mcp/client.js";
import { acquireLock } from "./lock.js";
import { downloadVerified, DownloadError } from "./download.js";
import { writeExcludeBlock } from "./exclude.js";
import { NEW_FOLDER_NOTICE, syncedNotice } from "./notice.js";
import { isSafeRelativePath, isValidSkillName } from "./paths.js";
import { emptyState, inBackoff, lockPath, readState, writeState } from "./state.js";
import type { SkillsState } from "./state.js";
import { syncTargets } from "./targets.js";
import { cleanTemps, installSkill, listManaged, readMarker, removeManaged } from "./writer.js";
import type { SkillFile } from "./writer.js";

export type SyncDeps = {
  call: typeof callTool;
  download: typeof downloadVerified;
  now: () => number;
};

export type SyncOptions = {
  seat: { origin: string; token: string };
  agentId: string;
  /** The git top level the skills are written under. */
  top: string;
  workspaceId: string | null;
  /** Foreground syncs print their own summary; a background one leaves a notice for the next hook. */
  background: boolean;
  /** Skip when the local state already holds this server revision. */
  ifChanged?: number;
  deps?: Partial<SyncDeps>;
};

export type SyncStatus = "synced" | "unchanged" | "locked" | "backoff" | "failed";

export type SyncResult = {
  status: SyncStatus;
  added: string[];
  updated: string[];
  removed: string[];
  clashes: { name: string; dir: string }[];
  skills: number;
  revision: number | null;
  /** A top-level skills folder was created by this sync (an agent session started earlier won't see it). */
  createdFolder: boolean;
  failures: number;
};

const empty = (status: SyncStatus, revision: number | null = null): SyncResult => ({
  status,
  added: [],
  updated: [],
  removed: [],
  clashes: [],
  skills: 0,
  revision,
  createdFolder: false,
  failures: 0,
});

type ListedSkill = { name: string; revision_id: string; digest: string };
type ManifestFile = { path: string; size: number; sha256: string; executable: boolean; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseList(result: unknown): { skills: ListedSkill[]; revision: number | undefined } | null {
  if (!isRecord(result) || !Array.isArray(result["skills"])) return null;
  const skills: ListedSkill[] = [];
  for (const item of result["skills"]) {
    if (!isRecord(item)) continue;
    const { name, revision_id, digest } = item as Record<string, unknown>;
    if (isValidSkillName(name) && typeof revision_id === "string" && typeof digest === "string" && HEX64.test(digest)) {
      skills.push({ name, revision_id, digest });
    }
  }
  const revision = typeof result["skills_revision"] === "number" ? result["skills_revision"] : undefined;
  return { skills, revision };
}

function parseManifest(result: unknown): { digest: string; revision_id: string; files: ManifestFile[] } | null {
  if (!isRecord(result) || !Array.isArray(result["files"])) return null;
  const digest = result["digest"];
  const revisionId = result["revision_id"];
  if (typeof digest !== "string" || !HEX64.test(digest) || typeof revisionId !== "string") return null;
  const files: ManifestFile[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const item of result["files"]) {
    if (!isRecord(item)) return null;
    const { path, size, sha256, executable, url } = item as Record<string, unknown>;
    if (!isSafeRelativePath(path) || seen.has(path.toLowerCase())) return null;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return null;
    if (typeof sha256 !== "string" || !HEX64.test(sha256) || typeof url !== "string") return null;
    seen.add(path.toLowerCase());
    total += size;
    files.push({ path, size, sha256, executable: executable === true, url });
  }
  if (files.length === 0 || files.length > SKILLS_MAX_FILES || total > SKILLS_MAX_TOTAL_BYTES) return null;
  if (!files.some((f) => f.path === "SKILL.md")) return null;
  return { digest, revision_id: revisionId, files };
}

/** The repository slug to filter `list_skills` by: the origin remote's repo name, else the folder's. */
export function repositorySlug(top: string): string | null {
  const worktree = linkedWorktree(top);
  const slug = originSlug(worktree?.commonDir ?? join(top, ".git")) ?? basename(top);
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return /^[a-z0-9][a-z0-9._-]*$/.test(cleaned) ? cleaned : null;
}

function isUnknownTool(outcome: CallOutcome): boolean {
  const message = outcome.envelope.error ?? "";
  return outcome.exitCode === 1 && /unknown tool|tool .*not found|method not found|not found/i.test(message) && /list_skills|tool/i.test(message);
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const deps: SyncDeps = { call: callTool, download: downloadVerified, now: Date.now, ...opts.deps };
  const lock = acquireLock(lockPath(opts.top), deps.now);
  if (lock === null) return empty("locked");
  const state = readState(opts.top, opts.seat.origin);
  try {
    const switched = state.workspace_id !== null && opts.workspaceId !== null && state.workspace_id !== opts.workspaceId;
    if (opts.ifChanged !== undefined && state.revision === opts.ifChanged && !switched) return empty("unchanged", state.revision);
    if (opts.background && inBackoff(state, deps.now())) return empty("backoff", state.revision);
    return await sync(opts, deps, state, switched);
  } catch {
    return fail(opts, deps, state);
  } finally {
    lock.release();
  }
}

function fail(opts: SyncOptions, deps: SyncDeps, state: SkillsState): SyncResult {
  try {
    writeState(opts.top, { ...state, last_failure_at: deps.now() });
  } catch {
    // state is advisory; the next run starts clean
  }
  return { ...empty("failed", state.revision), failures: 1 };
}

async function sync(opts: SyncOptions, deps: SyncDeps, state: SkillsState, switched: boolean): Promise<SyncResult> {
  const repository = repositorySlug(opts.top);
  const listed = await deps.call(
    opts.seat,
    "list_skills",
    { agent_id: opts.agentId, ...(repository === null ? {} : { repository }) },
    { timeoutMs: SKILLS_SYNC_TIMEOUT_MS },
  );

  let parsed: { skills: ListedSkill[]; revision: number | undefined };
  if (listed.exitCode === 0 && listed.envelope.error === undefined) {
    const p = parseList(listed.envelope.result);
    if (p === null) return fail(opts, deps, state);
    parsed = p;
  } else if (isUnknownTool(listed)) {
    // An older server without company skills: zero skills, nothing to deliver.
    parsed = { skills: [], revision: undefined };
  } else {
    return fail(opts, deps, state);
  }

  const targets = syncTargets(opts.top);
  const result = empty("synced", parsed.revision ?? state.revision);
  const wanted = new Set(parsed.skills.map((s) => s.name));
  const createdBefore = new Map(targets.map((t) => [t, dirExistsSafe(join(opts.top, t))]));
  for (const t of targets) cleanTemps(join(opts.top, t));

  // Removals: managed folders no longer listed (or left over from another workspace).
  const removed = new Set<string>();
  for (const t of targets) {
    for (const [name, marker] of listManaged(join(opts.top, t))) {
      const foreign = opts.workspaceId !== null && marker.workspace_id !== null && marker.workspace_id !== opts.workspaceId;
      if ((!wanted.has(name) || foreign || switched) && removeManaged(join(opts.top, t), name)) removed.add(name);
    }
  }

  const nextSkills: SkillsState["skills"] = {};
  const clashes = new Map<string, string>();
  const added = new Set<string>();
  const updated = new Set<string>();

  for (const skill of parsed.skills) {
    const needing: string[] = [];
    for (const t of targets) {
      const dest = join(opts.top, t, skill.name);
      const marker = readMarker(dest);
      if (marker === null) {
        if (dirExistsSafe(dest)) clashes.set(skill.name, t);
        else needing.push(t);
      } else if (marker.digest !== skill.digest || (opts.workspaceId !== null && marker.workspace_id !== opts.workspaceId)) {
        needing.push(t);
      }
    }
    const previouslyManaged = targets.some((t) => readMarker(join(opts.top, t, skill.name)) !== null);
    if (needing.length > 0) {
      const manifestOutcome = await deps.call(
        opts.seat,
        "get_skill",
        { agent_id: opts.agentId, name: skill.name, manifest: true },
        { timeoutMs: SKILLS_SYNC_TIMEOUT_MS },
      );
      const manifest = manifestOutcome.exitCode === 0 && manifestOutcome.envelope.error === undefined ? parseManifest(manifestOutcome.envelope.result) : null;
      if (manifest === null) {
        // Disabled meanwhile, or a problem: keep what is on disk and try again next time.
        if (manifestOutcome.exitCode !== 1) result.failures += 1;
        else if (!/No enabled company skill/i.test(manifestOutcome.envelope.error ?? "")) result.failures += 1;
        keepEntry(nextSkills, state, skill.name, opts.top, targets);
        continue;
      }
      const files: SkillFile[] = [];
      try {
        await mapLimit(manifest.files, 4, async (f) => {
          const bytes = await deps.download(f.url, { size: f.size, sha256: f.sha256, appOrigin: opts.seat.origin });
          files.push({ path: f.path, bytes, executable: f.executable });
        });
      } catch (error) {
        result.failures += 1;
        if (!(error instanceof DownloadError)) throw error;
        keepEntry(nextSkills, state, skill.name, opts.top, targets);
        continue;
      }
      let installedAny = false;
      for (const t of needing) {
        const outcome = installSkill(join(opts.top, t), skill.name, files, {
          v: 1,
          workspace_id: opts.workspaceId,
          revision_id: manifest.revision_id,
          digest: manifest.digest,
          synced_at: new Date(deps.now()).toISOString(),
        });
        if (outcome === "clash") clashes.set(skill.name, t);
        else installedAny = true;
      }
      if (installedAny) (previouslyManaged ? updated : added).add(skill.name);
      nextSkills[skill.name] = { revision_id: manifest.revision_id, digest: manifest.digest, targets: targets.filter((t) => readMarker(join(opts.top, t, skill.name)) !== null) };
    } else {
      nextSkills[skill.name] = { revision_id: skill.revision_id, digest: skill.digest, targets: targets.filter((t) => readMarker(join(opts.top, t, skill.name)) !== null) };
    }
  }

  // Git exclude: one line per managed folder, nothing else.
  const lines: string[] = [];
  for (const t of targets) for (const name of listManaged(join(opts.top, t)).keys()) lines.push(`/${t}/${name}/`);
  try {
    writeExcludeBlock(opts.top, lines);
  } catch {
    // an unwritable exclude file only means git status shows the folders
  }

  result.added = [...added].sort();
  result.updated = [...updated].sort();
  result.removed = [...removed].filter((n) => !wanted.has(n) || switched).sort();
  result.clashes = [...clashes].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name));
  result.skills = Object.keys(nextSkills).length;
  result.createdFolder = targets.some((t) => createdBefore.get(t) === false && dirExistsSafe(join(opts.top, t)));
  const changed = result.added.length + result.updated.length + result.removed.length > 0;

  const nextClashes: SkillsState["clashes"] = {};
  for (const c of result.clashes) nextClashes[c.name] = { reported: state.clashes[c.name]?.reported ?? false, dir: c.dir };

  const next: SkillsState = {
    ...emptyState(opts.seat.origin),
    workspace_id: opts.workspaceId,
    revision: result.failures > 0 ? state.revision : (parsed.revision ?? state.revision),
    skills: nextSkills,
    pending_notice: [...state.pending_notice],
    clashes: nextClashes,
    created_dirs: state.created_dirs,
    last_failure_at: result.failures > 0 ? deps.now() : null,
    synced_at: deps.now(),
  };
  if (opts.background && changed) {
    next.pending_notice.push(syncedNotice(result.added.length, result.updated.length, result.removed.length));
    if (result.createdFolder) next.pending_notice.push(NEW_FOLDER_NOTICE);
  }
  writeState(opts.top, next);
  result.revision = next.revision;
  if (result.failures > 0) result.status = "failed";
  return result;
}

function dirExistsSafe(path: string): boolean {
  try {
    return readMarker(path) !== null || existsAny(path);
  } catch {
    return false;
  }
}


function keepEntry(
  next: SkillsState["skills"],
  state: SkillsState,
  name: string,
  top: string,
  targets: readonly string[],
): void {
  const prev = state.skills[name];
  const present = targets.filter((t) => readMarker(join(top, t, name)) !== null);
  if (prev !== undefined && present.length > 0) next[name] = { ...prev, targets: present };
}
