// Per-repository sync state, kept under the CLI's own config dir (never in the repo).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_BACKOFF_MS, SKILLS_STATE_VERSION } from "../constants.js";
import { configDir } from "../paths.js";

export type SkillEntry = { revision_id: string; digest: string; targets: string[] };

export type SkillsState = {
  v: 1;
  origin: string;
  workspace_id: string | null;
  /** The server's skills_revision at the last successful sync (null = never synced). */
  revision: number | null;
  skills: Record<string, SkillEntry>;
  /** Lines a hook injects once (set by a background sync). */
  pending_notice: string[];
  /** Names whose clash (an unmanaged folder of the same name) was already shown to the agent. */
  clashes: Record<string, { reported: boolean; dir?: string }>;
  created_dirs: string[];
  last_failure_at: number | null;
  synced_at: number | null;
};

export function emptyState(origin: string): SkillsState {
  return {
    v: SKILLS_STATE_VERSION,
    origin,
    workspace_id: null,
    revision: null,
    skills: {},
    pending_notice: [],
    clashes: {},
    created_dirs: [],
    last_failure_at: null,
    synced_at: null,
  };
}

export function stateDir(): string {
  return join(configDir(), "company-skills");
}

function keyFor(top: string): string {
  let real = top;
  try {
    real = realpathSync(top);
  } catch {
    // an unresolvable path still hashes to a stable key
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 32);
}

export function statePath(top: string): string {
  return join(stateDir(), `${keyFor(top)}.json`);
}

export function lockPath(top: string): string {
  return join(stateDir(), `${keyFor(top)}.lock`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readState(top: string, origin: string): SkillsState {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(top), "utf8"));
    if (!isRecord(raw) || raw["v"] !== SKILLS_STATE_VERSION || raw["origin"] !== origin) return emptyState(origin);
    const base = emptyState(origin);
    return {
      ...base,
      workspace_id: typeof raw["workspace_id"] === "string" ? raw["workspace_id"] : null,
      revision: typeof raw["revision"] === "number" ? raw["revision"] : null,
      skills: isRecord(raw["skills"]) ? (raw["skills"] as Record<string, SkillEntry>) : {},
      pending_notice: Array.isArray(raw["pending_notice"]) ? raw["pending_notice"].filter((l): l is string => typeof l === "string") : [],
      clashes: isRecord(raw["clashes"]) ? (raw["clashes"] as Record<string, { reported: boolean; dir?: string }>) : {},
      created_dirs: Array.isArray(raw["created_dirs"]) ? raw["created_dirs"].filter((l): l is string => typeof l === "string") : [],
      last_failure_at: typeof raw["last_failure_at"] === "number" ? raw["last_failure_at"] : null,
      synced_at: typeof raw["synced_at"] === "number" ? raw["synced_at"] : null,
    };
  } catch {
    return emptyState(origin);
  }
}

/** Written last in a sync, atomically (temp file then rename), so a crash leaves the previous state. */
export function writeState(top: string, state: SkillsState): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const path = statePath(top);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function deleteState(top: string): void {
  rmSync(statePath(top), { force: true });
}

/** After a failure, a new sync waits SKILLS_BACKOFF_MS. */
export function inBackoff(state: SkillsState, now: number): boolean {
  return state.last_failure_at !== null && now - state.last_failure_at < SKILLS_BACKOFF_MS;
}

/** Whether a hook should start a sync for the server's revision: it changed and no backoff applies. */
export function shouldSync(state: SkillsState, serverRevision: number | undefined, now: number): boolean {
  if (serverRevision === undefined) return false;
  if (state.revision === serverRevision) return false;
  return !inBackoff(state, now);
}
