// Messages that don't fit a harness's hook output (spec §6.3). The server has already marked them
// delivered (at-most-once), so they are written next to the session cache instead of being dropped.
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { SESSION_CACHE_MAX_AGE_MS } from "../constants.js";
import { sessionsDir } from "../paths.js";
import { redactSecrets } from "../output.js";
import { writeFileAtomic } from "../safe-edit/atomic-write.js";
import { sessionKey } from "../session/cache.js";
import type { HarnessId } from "../session/harness-env.js";
import type { Spill } from "./inject.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_PRUNE_SCAN = 5000;
const OVERFLOW_FILE_RE = /^[0-9a-f]{32}\.overflow-\d+\.json$/;

function ownedByUs(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/** Deletes our overflow files untouched for SESSION_CACHE_MAX_AGE_MS (the session cache's rule). Best effort. */
function pruneOverflow(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.slice(0, MAX_PRUNE_SCAN)) {
    if (!OVERFLOW_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (info.isFile() && ownedByUs(info.uid) && info.mtimeMs < now - SESSION_CACHE_MAX_AGE_MS) unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Where this session's overflowing messages go: `<sessions dir>/<session key>.overflow-<timestamp>.json`
 * (mode 0600, a file of untrusted message content and no secret). `save` writes it atomically after
 * pruning week-old overflow files, and reports false rather than throwing.
 */
export function overflowSpill(harness: HarnessId, sessionId: string | null, now: number = Date.now()): Spill {
  const key = sessionId === null ? randomBytes(16).toString("hex") : sessionKey(harness, sessionId);
  const dir = sessionsDir();
  const path = join(dir, `${key}.overflow-${now}.json`);
  return {
    path,
    save(dropped) {
      try {
        pruneOverflow(dir, now);
        writeFileAtomic(path, `${redactSecrets(JSON.stringify({ messages: dropped }))}\n`, { mode: FILE_MODE, dirMode: DIR_MODE });
        return true;
      } catch {
        return false;
      }
    },
  };
}
