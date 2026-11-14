// A managed block in the repository's `info/exclude` so synced skill folders never show up in `git status`.
// Only this block is ever touched; the lines around it are the user's.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { childEnv } from "../process-env.js";

export const EXCLUDE_BEGIN = "# >>> jubarteai company skills (managed — do not edit)";
export const EXCLUDE_END = "# <<< jubarteai company skills";

export function excludePath(top: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: top,
      env: childEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out === "" ? null : resolve(top, out);
  } catch {
    return null;
  }
}

/** The file's text with the managed block replaced by one line per entry (or removed when `lines` is empty). */
export function withManagedBlock(text: string, lines: readonly string[]): string {
  const begin = text.indexOf(EXCLUDE_BEGIN);
  const end = begin === -1 ? -1 : text.indexOf(EXCLUDE_END, begin);
  let rest = text;
  if (begin !== -1 && end !== -1) rest = text.slice(0, begin) + text.slice(end + EXCLUDE_END.length).replace(/^\r?\n/, "");
  if (lines.length === 0) return rest;
  const sep = rest === "" || rest.endsWith("\n") ? "" : "\n";
  return `${rest}${sep}${EXCLUDE_BEGIN}\n${lines.join("\n")}\n${EXCLUDE_END}\n`;
}

/** Writes the block for `lines`; returns whether the file changed. A repo without a git dir is left alone. */
export function writeExcludeBlock(top: string, lines: readonly string[]): boolean {
  const path = excludePath(top);
  if (path === null) return false;
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // no exclude file yet
  }
  const next = withManagedBlock(current, [...lines].sort());
  if (next === current) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
  return true;
}
