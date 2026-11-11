import { readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CliError, ExitCode } from "../errors.js";
import { SafeEditError, writeFileAtomic } from "../safe-edit/atomic-write.js";
import { assertSafeTarget } from "../safe-edit/file-guards.js";

/** The two lines the CLI adds to a repo's .gitignore for a private binding (spec §3.2). */
const PRIVATE_MARKER = "# jubarteai: private workspace binding";
const PRIVATE_PATTERN = "/.jubarteai/";
const PRIVATE_BLOCK: readonly string[] = [PRIVATE_MARKER, PRIVATE_PATTERN];

const MAX_IGNORE_BYTES = 1024 * 1024;
const DEFAULT_MODE = 0o644;

type IgnoreFile = { lines: string[]; eol: string; finalNewline: boolean; mode: number; exists: boolean };

function ignoreError(path: string, detail: string): CliError {
  return new CliError(`Cannot update ${path}: ${detail}.`, ExitCode.SERVER_ERROR, "gitignore_unsafe");
}

function readIgnoreFile(path: string): IgnoreFile {
  const guard = assertSafeTarget(path, { allowMissing: true });
  if (!guard.ok) throw ignoreError(path, `refused (${guard.reason})`);
  let raw: string;
  let mode = DEFAULT_MODE;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_IGNORE_BYTES) throw ignoreError(path, "the file is too large");
    mode = stat.mode & 0o777;
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { lines: [], eol: "\n", finalNewline: false, mode, exists: false };
    }
    throw ignoreError(path, "it could not be read");
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = raw.endsWith("\n");
  const body = finalNewline ? raw.slice(0, raw.endsWith("\r\n") ? -2 : -1) : raw;
  const lines = raw.length === 0 ? [] : body.split(/\r?\n/);
  return { lines, eol, finalNewline: raw.length === 0 ? true : finalNewline, mode, exists: true };
}

function writeIgnoreFile(path: string, file: IgnoreFile): void {
  const text = file.lines.length === 0 ? "" : file.lines.join(file.eol) + (file.finalNewline ? file.eol : "");
  try {
    writeFileAtomic(path, text, { mode: file.mode, dirMode: 0o755 });
  } catch (error) {
    if (error instanceof SafeEditError) throw ignoreError(path, `refused (${error.reason})`);
    throw ignoreError(path, "it could not be written");
  }
}

function blockAt(lines: readonly string[], block: readonly string[], index: number): boolean {
  return block.every((line, offset) => lines[index + offset]?.trimEnd() === line);
}

function hasBlock(lines: readonly string[], block: readonly string[]): boolean {
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    if (blockAt(lines, block, i)) return true;
  }
  return false;
}

/** Appends `block` (consecutive lines) unless it is already there. Existing lines are never touched. */
export function ensureIgnoreBlock(path: string, block: readonly string[]): { changed: boolean } {
  const file = readIgnoreFile(path);
  if (hasBlock(file.lines, block)) return { changed: false };
  file.lines = [...file.lines, ...block];
  file.finalNewline = true;
  writeIgnoreFile(path, file);
  return { changed: true };
}

/**
 * Removes every consecutive occurrence of `block` and nothing else. With `deleteWhenEmpty`, a file
 * left with no lines at all is deleted (for a file the CLI created itself).
 */
export function removeIgnoreBlock(
  path: string,
  block: readonly string[],
  opts: { deleteWhenEmpty: boolean },
): { changed: boolean } {
  const file = readIgnoreFile(path);
  if (!file.exists || !hasBlock(file.lines, block)) return { changed: false };
  const kept: string[] = [];
  for (let i = 0; i < file.lines.length; ) {
    if (blockAt(file.lines, block, i)) {
      i += block.length;
    } else {
      kept.push(file.lines[i] ?? "");
      i += 1;
    }
  }
  file.lines = kept;
  if (kept.length === 0 && opts.deleteWhenEmpty) {
    removeFileSafely(path);
  } else {
    writeIgnoreFile(path, file);
  }
  return { changed: true };
}

/** Adds the marked private-binding lines to `<root>/.gitignore`. Idempotent. */
export function ensurePrivateGitignore(root: string): { changed: boolean } {
  return ensureIgnoreBlock(join(root, ".gitignore"), PRIVATE_BLOCK);
}

/** Removes exactly the two marked lines from `<root>/.gitignore`; every other line stays. */
export function removePrivateGitignore(root: string): { changed: boolean } {
  return removeIgnoreBlock(join(root, ".gitignore"), PRIVATE_BLOCK, { deleteWhenEmpty: false });
}

/** Removes a file the CLI wrote, through the same guards as a write. A missing file is not an error. */
export function removeFileSafely(path: string): { changed: boolean } {
  const guard = assertSafeTarget(path, { allowMissing: true });
  if (!guard.ok) throw ignoreError(path, `refused (${guard.reason})`);
  try {
    unlinkSync(path);
    return { changed: true };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { changed: false };
    throw ignoreError(path, "it could not be removed");
  }
}
