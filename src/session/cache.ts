// The per-session agent cache (spec §3.3, D29): one small file per harness session, so
// several harnesses and subagents on one machine never contend. It names an agent, never a key.
import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { SESSION_CACHE_MAX_AGE_MS, SESSION_CACHE_VERSION } from "../constants.js";
import { CliError, ExitCode } from "../errors.js";
import { sessionsDir } from "../paths.js";
import { isValidOrigin } from "../process-env.js";
import { SafeEditError, writeFileAtomic } from "../safe-edit/atomic-write.js";
import { HARNESS_IDS } from "./harness-env.js";
import type { HarnessId } from "./harness-env.js";

export type SessionEntry = {
  version: 1;
  harness: HarnessId;
  agent_id: string;
  seat_id: string | null;
  origin: string;
  /** First 8 hex of sha256(key), for an entry written under an environment key (no seat id): which key it was made for. */
  key_fp?: string;
  name?: string;
  created_at: string;
  updated_at: string;
};

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** A real entry is a few hundred bytes; anything bigger is not ours. */
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_PRUNE_SCAN = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_FP_RE = /^[0-9a-f]{8}$/;
const ENTRY_FILE_RE = /^[0-9a-f]{32}\.json$/;
// Leftovers of an interrupted write: our own no-clobber staging name and writeFileAtomic's temp name.
const STAGING_FILE_RE = /^[0-9a-f]{32}\.[0-9a-f]{12}\.new$/;
const ATOMIC_TEMP_RE = /^\..+\.jubarteai\.tmp$/;

export function isAgentId(value: string): boolean {
  return UUID_RE.test(value);
}

/** The seat a command runs as, as far as a cache entry is concerned. */
export type SeatIdentity = { origin: string; seatId: string | null; token: string };

/** First 8 hex characters of sha256(token): enough to tell one environment key from another, useless as a key. */
export function keyFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Whether the entry was written for this seat: same origin and seat id. An environment key has no
 * seat id, so such an entry must also carry the fingerprint of the very key in use.
 */
export function entryBelongsToSeat(entry: SessionEntry, seat: SeatIdentity): boolean {
  if (entry.origin !== seat.origin || entry.seat_id !== seat.seatId) return false;
  return seat.seatId !== null || entry.key_fp === keyFingerprint(seat.token);
}

/** First 32 hex characters of sha256("<harness>:<session id>"): the entry's file name. */
export function sessionKey(harness: HarnessId, sessionId: string): string {
  return createHash("sha256").update(`${harness}:${sessionId}`).digest("hex").slice(0, 32);
}

function entryPath(harness: HarnessId, sessionId: string): string {
  return join(sessionsDir(), `${sessionKey(harness, sessionId)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function ownedByUs(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function parseEntry(raw: unknown, harness: HarnessId): SessionEntry | null {
  if (!isRecord(raw) || raw["version"] !== SESSION_CACHE_VERSION || raw["harness"] !== harness) return null;
  const agentId = shortString(raw["agent_id"], 64);
  const origin = shortString(raw["origin"], 512);
  const createdAt = shortString(raw["created_at"], 64);
  const updatedAt = shortString(raw["updated_at"], 64);
  if (agentId === null || !isAgentId(agentId) || origin === null || !isValidOrigin(origin)) return null;
  if (createdAt === null || updatedAt === null) return null;
  const seatId = raw["seat_id"] === null ? null : shortString(raw["seat_id"], 128);
  if (raw["seat_id"] !== null && seatId === null) return null;
  const entry: SessionEntry = {
    version: SESSION_CACHE_VERSION,
    harness,
    agent_id: agentId,
    seat_id: seatId,
    origin,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  if (raw["key_fp"] !== undefined) {
    if (typeof raw["key_fp"] !== "string" || !KEY_FP_RE.test(raw["key_fp"])) return null;
    entry.key_fp = raw["key_fp"];
  }
  if (raw["name"] !== undefined) {
    const name = shortString(raw["name"], 200);
    if (name === null) return null;
    entry.name = name;
  }
  return entry;
}

/**
 * The cached entry for this session, or null: missing, unreadable, malformed, another harness's, not
 * a regular file of ours (a symbolic link, or a file another user planted in a directory they own,
 * is a miss). Never throws and never echoes file content.
 */
export function readSession(harness: HarnessId, sessionId: string): SessionEntry | null {
  const path = entryPath(harness, sessionId);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || !ownedByUs(info.uid) || info.size > MAX_ENTRY_BYTES) return null;
    return parseEntry(JSON.parse(readFileSync(path, "utf8")) as unknown, harness);
  } catch {
    return null;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Deletes our files in the sessions folder that haven't been touched for SESSION_CACHE_MAX_AGE_MS. Best effort. */
function pruneOld(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SESSION_CACHE_MAX_AGE_MS;
  for (const name of names.slice(0, MAX_PRUNE_SCAN)) {
    if (!ENTRY_FILE_RE.test(name) && !STAGING_FILE_RE.test(name) && !ATOMIC_TEMP_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (info.isFile() && ownedByUs(info.uid) && info.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove: the next write tries again.
    }
  }
}

function cacheWriteError(error: unknown): CliError {
  const reason = error instanceof SafeEditError ? error.reason : null;
  const message =
    reason === null
      ? "Could not write the session cache."
      : `Refusing to write the session cache: its folder or file failed a safety check (${reason}).`;
  return new CliError(message, ExitCode.SERVER_ERROR, "session_cache_unwritable");
}

/**
 * Saves this session's agent. `overwrite: false` never replaces a valid entry (`written: false`):
 * the first agent a session was given stays its agent, even when several processes race (the
 * entry is staged under a private name and hard-linked into place, which fails if the name is
 * taken). A corrupt leftover under that name is replaced, and so is a valid entry written for
 * another seat when `opts.seat` is given: it isn't this seat's agent, so for this seat it is absent. Files untouched for a week
 * are pruned first. Throws CliError (code `session_cache_unwritable`) when the folder or file
 * fails a safety check or can't be written; callers decide whether that matters.
 */
export function writeSession(
  harness: HarnessId,
  sessionId: string,
  entry: Omit<SessionEntry, "version" | "created_at" | "updated_at">,
  opts: { overwrite: boolean; seat?: SeatIdentity },
): { written: boolean } {
  if (!HARNESS_IDS.includes(harness) || entry.harness !== harness) throw new TypeError("writeSession: harness mismatch");
  if (!isAgentId(entry.agent_id)) throw new TypeError("writeSession: agent_id must be a UUID");

  const target = entryPath(harness, sessionId);
  const dir = sessionsDir();
  const now = new Date().toISOString();
  // Pruned first: a week-old entry for this very session must not block its new agent.
  pruneOld(dir);
  const previous = readSession(harness, sessionId);
  const keeps = (existing: SessionEntry | null): boolean =>
    existing !== null && !opts.overwrite && (opts.seat === undefined || entryBelongsToSeat(existing, opts.seat));
  if (keeps(previous)) return { written: false };

  const next: SessionEntry = {
    version: SESSION_CACHE_VERSION,
    harness,
    agent_id: entry.agent_id,
    seat_id: entry.seat_id,
    origin: entry.origin,
    ...(entry.key_fp === undefined ? {} : { key_fp: entry.key_fp }),
    ...(entry.name === undefined ? {} : { name: entry.name }),
    created_at: previous !== null && previous.agent_id === entry.agent_id ? previous.created_at : now,
    updated_at: now,
  };
  const data = `${JSON.stringify(next, null, 2)}\n`;

  try {
    if (opts.overwrite) {
      writeFileAtomic(target, data, { mode: FILE_MODE, dirMode: DIR_MODE });
      return { written: true };
    }
    const staging = join(dir, `${sessionKey(harness, sessionId)}.${randomBytes(6).toString("hex")}.new`);
    writeFileAtomic(staging, data, { mode: FILE_MODE, dirMode: DIR_MODE });
    try {
      linkSync(staging, target);
      return { written: true };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      // Someone got there first. A valid entry for this seat wins; any other leftover is replaced.
      if (keeps(readSession(harness, sessionId))) return { written: false };
      writeFileAtomic(target, data, { mode: FILE_MODE, dirMode: DIR_MODE });
      return { written: true };
    } finally {
      try {
        unlinkSync(staging);
      } catch {
        // Already gone.
      }
    }
  } catch (error) {
    throw cacheWriteError(error);
  }
}
