// One CLI watcher per agent per machine (spec §3.3/§7: a second `inbox --watch` for the same agent would
// rotate the first one's token, killing it and waking its agent for nothing). The lock is a file in a
// per-user, per-boot directory, created with O_EXCL, that names the holder's pid. It never holds a token.
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { watchLocksDir } from "../paths.js";
import { isAgentId } from "../session/cache.js";

export type LockMode = "watch" | "session" | "hook";

export type WatchLock = {
  /** Removes the lock if it is still ours. Idempotent; safe to call from an exit handler. */
  release: () => void;
};

export type AcquireResult =
  | { kind: "acquired"; lock: WatchLock }
  /** A live process holds it: `pid` and `mode` are the holder's (0 and "unknown" while another process is mid-reclaim). */
  | { kind: "held"; pid: number; mode: string }
  /** The lock directory can't be used safely; the caller proceeds without one rather than fail the watch. */
  | { kind: "unavailable" };

export type LockDeps = {
  dir: () => string;
  pid: number;
  isAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Registers `release` to run when the process exits; returns the function that unregisters it. */
  onExit: (release: () => void) => () => void;
};

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** A real lock is ~100 bytes; anything bigger is not ours. */
const MAX_LOCK_BYTES = 1024;
/** A lock file that doesn't parse might be a holder mid-write; it only counts as stale once it is this old. */
const MALFORMED_GRACE_MS = 2_000;
/** A leftover reclaim marker (its owner crashed mid-reclaim) is ignored once it is this old. */
const RECLAIM_STALE_MS = 10_000;
const ATTEMPTS = 6;
const RETRY_SLEEP_MS = 25;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but isn't ours to signal.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export const DEFAULT_LOCK_DEPS: LockDeps = {
  dir: watchLocksDir,
  pid: process.pid,
  isAlive: processExists,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onExit: (release) => {
    process.on("exit", release);
    return () => process.off("exit", release);
  },
};

function errnoCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function fileNameFor(agentId: string): string {
  return isAgentId(agentId) ? `${agentId.toLowerCase()}.lock` : `${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}.lock`;
}

/** The lock directory, created private (0700) and checked: a directory of ours, not a link, with no group or world access. Null if it can't be. */
function ensureDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return null;
    return dir;
  } catch {
    return null;
  }
}

type Holder = { pid: number; mode: string } | "malformed";

function readHolder(path: string): Holder | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_LOCK_BYTES) return "malformed";
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return "malformed";
    const record = raw as Record<string, unknown>;
    const pid = record["pid"];
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "malformed";
    return { pid, mode: typeof record["mode"] === "string" ? record["mode"].slice(0, 16) : "unknown" };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? null : "malformed";
  }
}

function ageMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function tryCreate(path: string, pid: number, mode: LockMode, now: number): boolean {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, FILE_MODE);
  try {
    writeSync(fd, `${JSON.stringify({ pid, mode, started_at: new Date(now).toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Takes the watcher lock for `agentId`, or says who holds it. A holder whose process is gone (or whose
 * file is unreadable and no longer fresh) is stale and is replaced, once, even when several processes race
 * to do it: replacing goes through a second O_EXCL marker, so only one of them removes the stale file.
 */
export async function acquireWatchLock(agentId: string, mode: LockMode, deps: LockDeps = DEFAULT_LOCK_DEPS): Promise<AcquireResult> {
  const dir = ensureDir(deps.dir());
  if (dir === null) return { kind: "unavailable" };
  const path = join(dir, fileNameFor(agentId));
  const reclaimPath = `${path}.reclaim`;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      tryCreate(path, deps.pid, mode, deps.now());
      let released = false;
      let unregister: () => void = () => undefined;
      const release = (): void => {
        if (released) return;
        released = true;
        unregister();
        const holder = readHolder(path);
        if (holder !== null && holder !== "malformed" && holder.pid === deps.pid) {
          try {
            unlinkSync(path);
          } catch {
            // Already gone.
          }
        }
      };
      unregister = deps.onExit(release);
      return { kind: "acquired", lock: { release } };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return { kind: "unavailable" };
    }

    const holder = readHolder(path);
    if (holder === null) continue; // released between our attempt and our read: try again
    const stale =
      holder === "malformed" ? ageMs(path, deps.now()) > MALFORMED_GRACE_MS : !deps.isAlive(holder.pid);
    if (!stale) return holder === "malformed" ? { kind: "held", pid: 0, mode: "unknown" } : { kind: "held", pid: holder.pid, mode: holder.mode };

    // Stale: whoever creates the marker removes the file; the others wait a moment and look again.
    let marker: number;
    try {
      marker = openSync(reclaimPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, FILE_MODE);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return { kind: "unavailable" };
      if (ageMs(reclaimPath, deps.now()) > RECLAIM_STALE_MS) {
        try {
          unlinkSync(reclaimPath);
        } catch {
          // Someone else cleaned it.
        }
      } else {
        await deps.sleep(RETRY_SLEEP_MS);
      }
      continue;
    }
    try {
      // Re-read under the marker: another process may have replaced the stale file already.
      const again = readHolder(path);
      const stillStale =
        again !== null && (again === "malformed" ? ageMs(path, deps.now()) > MALFORMED_GRACE_MS : !deps.isAlive(again.pid));
      if (stillStale) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone.
        }
      }
    } finally {
      closeSync(marker);
      try {
        unlinkSync(reclaimPath);
      } catch {
        // Already gone.
      }
    }
  }
  // Contention that never settled means other processes are racing for it: someone holds it.
  return { kind: "held", pid: 0, mode: "unknown" };
}
