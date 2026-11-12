// File guards for every write the CLI makes to a file a key (or a user's own
// config) lives in. Ported from install.sh (src/lib/install-script.ts in the
// app: json_merge's owner / hard-link checks, realTarget, codex_rewrite).
//
// Two modes, decided by `withinHome`:
//
// * Strict (default, the credential store): the file and every existing parent
//   directory below the home directory must be real, not links. A symlinked file
//   or directory is refused as "symlink" (Windows: "reparse-point").
//
// * `withinHome: true` (user-managed configs such as ~/.cursor/mcp.json): what
//   install.sh did. A symlinked config is written THROUGH the link to the file
//   it really names (a dotfiles-managed config keeps its link and the real file
//   gets the edit); the real file's owner and link count are what is checked.
//   install.sh followed links anywhere; this port is stricter in one way: a
//   link that resolves outside the home directory is refused as "outside-home",
//   so a link planted in a config directory cannot steer a write elsewhere.
//
// * `withinRoot: dir` (files inside a project the repo's own contents steer, such
//   as AGENTS.md or .codex/config.toml): like `withinHome`, but the boundary is
//   that directory instead of the home directory. A link (to the file or to any
//   directory above it) is followed only when the file it really names stays
//   inside the real path of `dir` (CLAUDE.md -> AGENTS.md keeps working); a link
//   that leaves it, e.g. AGENTS.md -> ../../.zshrc, is refused as "symlink". It
//   takes precedence over `withinHome`.
//
// Every mode refuses a file owned by another uid (POSIX; a key written there
// could be read by that user) and a file with other hard links (a rewrite would
// split it from them, and an in-place write would put the key in every copy).
// Foreign owner is reported before hard links, as install.sh did.
//
// Both modes also vet the directory the file will sit in (POSIX only): another
// user who owns it, or who can write to it (group or other write bit), could
// swap the file or pre-create what it holds (group-writable counts only when it
// is this user's directory in this user's own primary group), so it is refused as
// "unsafe-parent". The one exemption is a root-owned directory with the sticky
// bit (/tmp itself), where nobody can replace another user's entries. Strict
// mode applies the same test to every existing directory between the file and
// home, and, for a path outside home, to the nearest existing directory; the
// directories above that only have to belong to this user or to root, and not
// be writable by others, as the system's own /usr or /var are.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { homeDir } from "../paths.js";

export type RefusalReason = "symlink" | "hardlink" | "foreign-owner" | "reparse-point" | "outside-home" | "unsafe-parent";
export type GuardResult<R extends string> = { ok: true } | { ok: false; reason: R };

/** The slice of node:fs the guards use, so a test can stub a lstat result. */
export type GuardFs = {
  lstatSync(p: string): Pick<nodeFs.Stats, "isSymbolicLink" | "isDirectory" | "uid" | "nlink" | "mode" | "gid">;
  realpathSync(p: string): string;
  readlinkSync(p: string): string;
};

/** Everything the guards read from the machine. Production uses defaultGuardEnv(). */
export type GuardEnv = {
  fs: GuardFs;
  platform: NodeJS.Platform;
  /** undefined where the platform has no uids (Windows): the owner check is skipped. */
  getuid: (() => number) | undefined;
  /** The primary group: a group-writable directory of this user's own is trusted only when it is in it. */
  getgid: (() => number) | undefined;
  home: () => string;
};

export function defaultGuardEnv(): GuardEnv {
  return {
    fs: nodeFs,
    platform: process.platform,
    getuid: typeof process.getuid === "function" ? () => process.getuid!() : undefined,
    getgid: typeof process.getgid === "function" ? () => process.getgid!() : undefined,
    home: homeDir,
  };
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** lstat that answers null for a missing path; any other error (EACCES, ENOTDIR) is the caller's to handle. */
function lstatOrNull(fs: GuardFs, p: string): ReturnType<GuardFs["lstatSync"]> | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * The file `start` really names: symlinks followed through real directories
 * (realpath), a dangling link followed hop by hop, a relative link resolved
 * from the real directory it sits in (install.sh's realTarget).
 */
export function realTarget(start: string, fs: GuardFs): string {
  try {
    return fs.realpathSync(start);
  } catch {
    // Missing or dangling: walk the links by hand below.
  }
  let p = start;
  for (let i = 0; i < 40; i++) {
    let link: string;
    try {
      link = fs.readlinkSync(p);
    } catch {
      break; // not a link (or missing): p is as far as it goes
    }
    let dir = path.dirname(p);
    try {
      dir = fs.realpathSync(dir);
    } catch {
      // keep the lexical directory
    }
    p = path.resolve(dir, link);
  }
  // The nearest ancestor that exists is resolved, and what is missing below it
  // is appended, so a path under a symlinked home (macOS /var -> /private/var)
  // comes out in the same real form as realpath(home) even when its own
  // directories are not created yet.
  const rest: string[] = [path.basename(p)];
  for (let dir = path.dirname(p); ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return p;
      rest.unshift(path.basename(dir));
    }
  }
}

/**
 * A directory a write must not go into (POSIX). `mine` demands this user own it;
 * otherwise root may too (a system directory above the one that matters).
 */
function unsafeDir(st: ReturnType<GuardFs["lstatSync"]>, env: GuardEnv, mine: boolean): boolean {
  if (env.platform === "win32" || env.getuid === undefined) return false;
  if (st.uid === 0 && (st.mode & 0o1000) !== 0) return false; // root-owned, sticky: /tmp
  const ownerOk = st.uid === env.getuid() || (!mine && st.uid === 0);
  if (!ownerOk || (st.mode & 0o002) !== 0) return true; // another owner, or anyone can write
  if ((st.mode & 0o020) === 0) return false;
  // Group-writable. Debian and Ubuntu give every user a private primary group and
  // a umask of 0002, so their own ~/.config is 0775 with that group: nobody else
  // is in it. That is trusted: this user's directory, in this user's primary group.
  // A group-writable directory in any other group (shared, "staff", "admin") is
  // not: its members could swap the file.
  return !(st.uid === env.getuid() && env.getgid !== undefined && st.gid === env.getgid());
}

function checkOwnerAndLinks(
  st: ReturnType<GuardFs["lstatSync"]>,
  env: GuardEnv,
): GuardResult<"foreign-owner" | "hardlink"> {
  if (env.getuid !== undefined && st.uid !== env.getuid()) return { ok: false, reason: "foreign-owner" };
  // A directory's link count is its entry count (2+ on every filesystem), not hard links.
  if (!st.isDirectory() && st.nlink > 1) return { ok: false, reason: "hardlink" };
  return { ok: true };
}

function checkStrict(abs: string, opts: { allowMissing: boolean }, env: GuardEnv): GuardResult<RefusalReason | "missing"> {
  const linkReason = env.platform === "win32" ? "reparse-point" : "symlink";
  const home = path.resolve(env.home());
  const underHome = isInside(abs, home);

  // Every existing parent directory below the home directory (the home
  // directory itself is the user's own and may be anything), or below the
  // filesystem root when the file lives outside home.
  let dir = path.dirname(abs);
  let nearest = true; // the first directory that exists is where the file lands
  for (;;) {
    if (underHome && dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // the filesystem root is not checked
    const st = lstatOrNull(env.fs, dir);
    if (st !== null && !st.isSymbolicLink() && st.isDirectory()) {
      if (unsafeDir(st, env, underHome || nearest)) return { ok: false, reason: "unsafe-parent" };
    }
    if (st !== null) nearest = false;
    if (st !== null && st.isSymbolicLink()) {
      // Outside home, a link only root could have made (macOS /var, /tmp, /etc)
      // is the system's own layout, not something another user planted.
      const systemLink = !underHome && env.platform !== "win32" && st.uid === 0;
      if (!systemLink) return { ok: false, reason: linkReason };
    }
    dir = parent;
  }

  const st = lstatOrNull(env.fs, abs);
  if (st === null) return opts.allowMissing ? { ok: true } : { ok: false, reason: "missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: linkReason };
  return checkOwnerAndLinks(st, env);
}

function checkThroughLinks(
  abs: string,
  opts: { allowMissing: boolean },
  env: GuardEnv,
  boundary: { dir: string; reason: RefusalReason },
): GuardResult<RefusalReason | "missing"> {
  const real = realTarget(abs, env.fs);
  const base = path.resolve(boundary.dir);
  let realBase = base;
  try {
    realBase = env.fs.realpathSync(base);
  } catch {
    // an unresolvable boundary keeps its lexical form; the comparison below then fails closed for anything else
  }
  if (!isInside(real, realBase)) return { ok: false, reason: boundary.reason };

  // The directory the real file sits in (or will be created in).
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const d = lstatOrNull(env.fs, dir);
    if (d !== null) {
      if (d.isDirectory() && unsafeDir(d, env, true)) return { ok: false, reason: "unsafe-parent" };
      break;
    }
    if (path.dirname(dir) === dir) break;
  }

  const st = lstatOrNull(env.fs, real);
  if (st === null) return opts.allowMissing ? { ok: true } : { ok: false, reason: "missing" };
  // A link left after realTarget's 40 hops is a loop, not a file.
  if (st.isSymbolicLink()) return { ok: false, reason: env.platform === "win32" ? "reparse-point" : "symlink" };
  return checkOwnerAndLinks(st, env);
}

/** assertSafeTarget with its environment injected (tests); assertSafeTarget is the production caller. */
export function assertSafeTargetWith(
  target: string,
  opts: { allowMissing: true; withinHome?: boolean; withinRoot?: string },
  env: GuardEnv,
): GuardResult<RefusalReason>;
export function assertSafeTargetWith(
  target: string,
  opts: { allowMissing: boolean; withinHome?: boolean; withinRoot?: string },
  env: GuardEnv,
): GuardResult<RefusalReason | "missing">;
export function assertSafeTargetWith(
  target: string,
  opts: { allowMissing: boolean; withinHome?: boolean; withinRoot?: string },
  env: GuardEnv,
): GuardResult<RefusalReason | "missing"> {
  const abs = path.resolve(target);
  if (opts.withinRoot !== undefined) return checkThroughLinks(abs, opts, env, { dir: opts.withinRoot, reason: env.platform === "win32" ? "reparse-point" : "symlink" });
  return opts.withinHome === true ? checkThroughLinks(abs, opts, env, { dir: env.home(), reason: "outside-home" }) : checkStrict(abs, opts, env);
}

/**
 * Whether `target` may be written. See the header for the two modes.
 * Pass allowMissing: true when the file may not exist yet (a first write); a
 * missing file is then fine, and the result can never be "missing".
 */
export function assertSafeTarget(target: string, opts: { allowMissing: true; withinHome?: boolean; withinRoot?: string }): GuardResult<RefusalReason>;
export function assertSafeTarget(
  target: string,
  opts: { allowMissing: boolean; withinHome?: boolean; withinRoot?: string },
): GuardResult<RefusalReason | "missing">;
export function assertSafeTarget(
  target: string,
  opts: { allowMissing: boolean; withinHome?: boolean; withinRoot?: string },
): GuardResult<RefusalReason | "missing"> {
  return assertSafeTargetWith(target, opts, defaultGuardEnv());
}
