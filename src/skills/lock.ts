import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { SKILLS_LOCK_STALE_MS } from "../constants.js";

export type Lock = { release(): void };

/** An exclusive lock file (`wx`), taken over when older than SKILLS_LOCK_STALE_MS. null = someone else holds it. */
export function acquireLock(path: string, now: () => number = Date.now): Lock | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        if (now() - statSync(path).mtimeMs > SKILLS_LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}
