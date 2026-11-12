import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where a folder sits in git, read from the filesystem alone. Hooks call this on every prompt, so it never
 * spawns a process, and nothing here trusts a `.git` file: a linked worktree is accepted only when git's own
 * back-link (`<gitdir>/gitdir`) points at the file that named it.
 */

const MAX_GIT_FILE_BYTES = 4 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_SLUG_CHARS = 100;

export type LinkedWorktree = {
  /** The worktree's own top level (the folder holding the `.git` file). */
  top: string;
  /** `<common>/worktrees/<name>`: this worktree's private git directory. */
  gitDir: string;
  /** The repository's shared git directory. */
  commonDir: string;
  /** The main checkout's folder, or null when the repository is bare. */
  mainCheckout: string | null;
};

/** The nearest folder at or above `start` that holds `.git` (a directory, or a file for worktrees and submodules). */
export function gitTop(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readSmallFile(path: string, limit: number): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `<top>/.git` as a file: `gitdir: X`. A directory (the main checkout) or anything else is not a linked worktree. */
function gitDirOf(top: string): string | null {
  const text = readSmallFile(join(top, ".git"), MAX_GIT_FILE_BYTES);
  if (text === null) return null;
  const match = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(text);
  const target = match?.[1];
  if (target === undefined || target.includes("\0")) return null;
  return isAbsolute(target) ? target : resolve(top, target);
}

/**
 * The linked worktree whose top level is `top`, or null when `top` is the main checkout, a submodule, or a
 * folder whose `.git` file does not check out against git's back-link (a forged file proves nothing).
 */
export function linkedWorktree(top: string): LinkedWorktree | null {
  const gitDir = gitDirOf(top);
  if (gitDir === null) return null;
  const realGitDir = realpathOrNull(gitDir);
  if (realGitDir === null) return null;

  const commonText = readSmallFile(join(realGitDir, "commondir"), MAX_GIT_FILE_BYTES);
  if (commonText === null) return null;
  const commonRel = commonText.trim();
  if (commonRel === "" || commonRel.includes("\0")) return null;
  const commonDir = realpathOrNull(isAbsolute(commonRel) ? commonRel : resolve(realGitDir, commonRel));
  if (commonDir === null || !isDirectory(commonDir)) return null;

  const backLink = readSmallFile(join(realGitDir, "gitdir"), MAX_GIT_FILE_BYTES);
  if (backLink === null) return null;
  const backTarget = backLink.trim();
  if (backTarget === "" || backTarget.includes("\0")) return null;
  const expected = realpathOrNull(join(top, ".git"));
  const actual = realpathOrNull(isAbsolute(backTarget) ? backTarget : resolve(realGitDir, backTarget));
  if (expected === null || actual === null || expected !== actual) return null;

  const mainCandidate = basename(commonDir) === ".git" ? dirname(commonDir) : null;
  const mainCheckout = mainCandidate !== null && isDirectory(join(mainCandidate, ".git")) ? mainCandidate : null;
  return { top: realpathOrNull(top) ?? resolve(top), gitDir: realGitDir, commonDir, mainCheckout };
}

/** The canonical repo slug of a remote URL: its last path segment, `.git` stripped, lowercased. */
export function slugFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return null;
  const segment = trimmed.split(/[\\/:]/).pop() ?? "";
  const slug = segment.replace(/\.git$/i, "").toLowerCase();
  if (slug.length === 0 || slug.length > MAX_SLUG_CHARS || !SLUG_RE.test(slug)) return null;
  return slug;
}

/** The slug of `[remote "origin"] url` in `<commonDir>/config`, or null (none, unreadable, oversize, not a slug). */
export function originSlug(commonDir: string): string | null {
  const text = readSmallFile(join(commonDir, "config"), MAX_CONFIG_BYTES);
  if (text === null) return null;
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(line);
    if (match?.[1] !== undefined) return slugFromRemoteUrl(match[1].replace(/^"(.*)"$/, "$1"));
  }
  return null;
}
