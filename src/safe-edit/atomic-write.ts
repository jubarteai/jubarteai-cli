// Atomic file write for files that hold a key or a user's config. Ported from
// install.sh's json_merge / codex_rewrite: a temp file with a random name,
// created exclusively (O_EXCL, so a file or link planted in its place is never
// written through) in the target's own directory, then renamed over the target,
// so a failure or a crash leaves the old file exactly as it was.
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { assertSafeTargetWith, defaultGuardEnv, realTarget, type GuardEnv, type RefusalReason } from "./file-guards.js";

export class SafeEditError extends Error {
  constructor(
    message: string,
    readonly reason: RefusalReason,
  ) {
    super(message);
    this.name = "SafeEditError";
  }
}

const REFUSALS: Record<RefusalReason, string> = {
  symlink: "it is a symbolic link, or sits in a directory that is one",
  hardlink: "it has other hard links, which a rewrite would split from it",
  "foreign-owner": "it belongs to another user, who could read what is written there",
  "reparse-point": "it is a link or reparse point, or sits in a directory that is one",
  "outside-home": "it is a link that leads outside your home directory",
  "unsafe-parent": "its directory belongs to another user or can be written to by others",
};

// Ctrl-C reaches this process mid-write too. With no handler Node would die
// between creating the temp file (which holds the key) and renaming it, so the
// signals are held while the write runs and re-raised afterwards, as if they
// had arrived a moment later (install.sh's node did the same by ignoring them).
// A handler only runs on the next turn of the event loop, never while this
// synchronous write is running, so the handlers stay installed until a setImmediate
// after it: by then every signal that arrived during the write has been recorded.
const HELD_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

// One set of handlers shared by every write in flight (several writes in one
// turn must not stack listeners), removed when the last of them is released.
let holds = 0;
let received: NodeJS.Signals[] = [];
let installed: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

function holdSignals(): void {
  if (holds === 0) {
    installed = HELD_SIGNALS.map((signal) => {
      const handler = (): void => {
        received.push(signal);
      };
      process.on(signal, handler);
      return { signal, handler };
    });
  }
  holds++;
}

function releaseSignals(): void {
  holds--;
  if (holds > 0) return;
  for (const { signal, handler } of installed) process.off(signal, handler);
  installed = [];
  const first = received[0];
  received = [];
  if (first !== undefined) process.kill(process.pid, first);
}

function holdingSignals<T>(run: () => T): T {
  holdSignals();
  try {
    return run();
  } finally {
    setImmediate(releaseSignals);
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** Create `dir` and any missing parents with `mode`, regardless of umask. Directories that already exist are left alone. */
function ensureDir(dir: string, mode: number, chmod: boolean): void {
  const missing: string[] = [];
  for (let d = dir; !exists(d); d = path.dirname(d)) {
    missing.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of missing) {
    try {
      fs.mkdirSync(d, { mode });
      if (chmod) fs.chmodSync(d, mode);
    } catch (e) {
      // Created by someone else a moment ago: fine if it is a real directory.
      const raced = typeof e === "object" && e !== null && "code" in e && e.code === "EEXIST";
      if (!raced || !fs.lstatSync(d).isDirectory()) throw e;
    }
  }
}

function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best effort: some filesystems refuse to fsync a directory, and the rename has happened either way.
  }
}

export type AtomicWriteDeps = {
  guard: GuardEnv;
  /** Runs with the temp file written and closed, right before the rename. Tests only (crash and failure cases). */
  beforeRename?: () => void;
};

/** writeFileAtomic with its dependencies injected (tests); writeFileAtomic is the production caller. */
export function writeFileAtomicWith(
  target: string,
  data: string,
  opts: { mode: number; dirMode?: number; withinHome?: boolean; withinRoot?: string },
  deps: AtomicWriteDeps,
): void {
  const abs = path.resolve(target);
  const check = assertSafeTargetWith(abs, { allowMissing: true, withinHome: opts.withinHome, withinRoot: opts.withinRoot }, deps.guard);
  if (!check.ok) throw new SafeEditError(`Refusing to write ${abs}: ${REFUSALS[check.reason]}.`, check.reason);

  // A symlinked config (withinHome, or withinRoot for a file inside a project) is written through: the link stays, the file it names is replaced.
  const real = opts.withinHome === true || opts.withinRoot !== undefined ? realTarget(abs, deps.guard.fs) : abs;
  const dir = path.dirname(real);
  const posix = deps.guard.platform !== "win32";
  const { mode, dirMode = 0o700 } = opts;

  holdingSignals(() => {
    ensureDir(dir, dirMode, posix);
    const tmp = path.join(dir, `.${path.basename(real)}.${randomBytes(8).toString("hex")}.jubarteai.tmp`);
    let fd: number | undefined;
    let tmpExists = false;
    try {
      fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
      tmpExists = true;
      // The open's mode is masked by the umask; this makes it exact.
      if (posix) fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      deps.beforeRename?.();
      fs.renameSync(tmp, real);
      tmpExists = false;
    } catch (e) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // the original error is the one to report
        }
      }
      if (tmpExists) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // already gone: nothing left behind either way
        }
      }
      throw e;
    }
    if (posix) syncDir(dir);
  });
}

/**
 * Replace `target` with `data` atomically, mode exactly `mode` (0600 for anything
 * holding a key) and any directory it has to create `dirMode` (default 0700),
 * whatever the umask. Throws SafeEditError, writing nothing, when
 * assertSafeTarget refuses the path; any other failure removes the temp file
 * and rethrows, leaving the old file as it was. `withinHome: true` writes
 * through a symlinked config to the file it names, as does `withinRoot: dir` for a link that stays inside
 * `dir` (see file-guards.ts).
 */
export function writeFileAtomic(
  target: string,
  data: string,
  opts: { mode: number; dirMode?: number; withinHome?: boolean; withinRoot?: string },
): void {
  writeFileAtomicWith(target, data, opts, { guard: defaultGuardEnv() });
}
