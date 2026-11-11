// Edits of JSON config files (an editor's mcp.json, Claude Code's settings.json,
// ~/.claude.json). The file is read, parsed strictly, changed by the caller's
// edit function and written back atomically (writeFileAtomic: exclusive temp
// file, exact mode, guards against symlinks, other owners and hard links) only
// when the edit says it changed something. A file that is not plain JSON (a
// comment, a trailing comma, invalid syntax, a top level that is not an object)
// is refused untouched, never repaired. Ported from install.sh's json_merge.
import * as fs from "node:fs";
import { looksLikeJsonc } from "./jsonc.js";
import { SafeEditError, writeFileAtomic } from "./atomic-write.js";
import type { RefusalReason } from "./file-guards.js";

export type JsonEditResult = {
  status: "changed" | "unchanged" | "refused" | "missing";
  reason?: "jsonc" | "invalid-json" | "not-object" | RefusalReason;
};

/** A config file larger than this is not a config: it is refused rather than read into memory. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODE = 0o600;
const DEFAULT_INDENT = 2;
const MAX_INDENT = 8;

type ReadText = { status: "ok"; text: string; mode: number } | { status: "missing" } | { status: "unreadable" };

/**
 * The file's text (UTF-8, byte order mark kept) and mode. A missing file is "missing"; a directory, a
 * device, a pipe, an oversized file or bytes that are not UTF-8 are "unreadable" (never read through, never
 * decoded lossily and written back). Any other failure (no permission) throws, so it is never mistaken for a missing file.
 */
export function readConfigText(file: string): ReadText {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (isErrno(e, "ENOENT") || isErrno(e, "ENOTDIR")) return { status: "missing" };
    throw e;
  }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { status: "unreadable" };
  const bytes = fs.readFileSync(file);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { status: "ok", text, mode: st.mode & 0o777 };
  } catch {
    return { status: "unreadable" };
  }
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === code;
}

type WriteOpts = { createIfMissing: boolean; mode?: number; withinHome?: boolean };

/**
 * Write `text` to `file` atomically (writeFileAtomic runs the guards), mode `opts.mode`, else the mode the file already has, else 0600.
 * Returns the refusal reason when a guard (symlink, another owner, hard links…) refuses the target; nothing is written then.
 */
export function writeConfigText(file: string, text: string, existingMode: number | null, opts: WriteOpts): RefusalReason | null {
  const mode = opts.mode ?? existingMode ?? DEFAULT_MODE;
  try {
    writeFileAtomic(file, text, { mode, withinHome: opts.withinHome });
  } catch (e) {
    if (e instanceof SafeEditError) return e.reason;
    throw e;
  }
  return null;
}

type Parsed = { status: "ok"; doc: Record<string, unknown> } | { status: "jsonc" | "invalid-json" | "not-object" };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An empty (or blank) file is an empty config, like install.sh's json_merge; anything else must be one plain JSON object. */
function parseObject(text: string): Parsed {
  if (text.trim().length === 0) return { status: "ok", doc: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: looksLikeJsonc(text) ? "jsonc" : "invalid-json" };
  }
  return isObject(value) ? { status: "ok", doc: value } : { status: "not-object" };
}

/** The indent the file uses: a tab, or the width of its first indented line (1-8 spaces), else 2 spaces. */
function detectIndent(text: string): string {
  const m = /^([ \t]+)\S/m.exec(text);
  if (m === null) return " ".repeat(DEFAULT_INDENT);
  const lead = m[1] ?? "";
  if (lead.startsWith("\t")) return "\t";
  return lead.length >= 1 && lead.length <= MAX_INDENT ? lead : " ".repeat(DEFAULT_INDENT);
}

/** Serialize `doc` in the style of `original`: its indent, its line ending, and a final newline only if it had one (a new file gets one). */
function render(doc: Record<string, unknown>, original: string | null): string {
  const hasContent = original !== null && original.trim().length > 0;
  const crlf = hasContent && original.includes("\r\n");
  const finalNewline = hasContent ? /\n$/.test(original) : true;
  const indent = hasContent ? detectIndent(original) : " ".repeat(DEFAULT_INDENT);
  let out = JSON.stringify(doc, null, indent) + (finalNewline ? "\n" : "");
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return out;
}

/**
 * Read a JSON config. A missing file is "missing"; an empty one is `{}`. Anything that is not one plain JSON object
 * (comments or trailing commas, bad syntax, an array or scalar, unreadable bytes) comes back with the reason, untouched.
 */
export function readJsonObject(file: string): { status: "ok"; doc: Record<string, unknown> } | { status: "missing" | "jsonc" | "invalid-json" | "not-object" } {
  const read = readConfigText(file);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "unreadable") return { status: "invalid-json" };
  return parseObject(read.text);
}

/**
 * Apply `edit` to the JSON object in `file` and write the result back, only when `edit` returns true.
 * "refused" (with the reason) means nothing was written: the file is JSONC, invalid, not an object, or a guard
 * (symlink, other owner, hard link…) refused the write. "missing" is a file that is not there with createIfMissing off.
 * A file `edit` leaves alone is never rewritten, so an already-configured one that a guard would refuse is "unchanged".
 * Keys keep their order (JavaScript moves integer-like keys such as "1" first); numbers beyond 2^53 lose precision.
 */
export function editJsonFile(file: string, edit: (doc: Record<string, unknown>) => boolean, opts: WriteOpts): JsonEditResult {
  const read = readConfigText(file);
  if (read.status === "unreadable") return { status: "refused", reason: "invalid-json" };
  if (read.status === "missing" && !opts.createIfMissing) return { status: "missing" };
  const original = read.status === "ok" ? read.text : null;
  const parsed: Parsed = original === null ? { status: "ok", doc: {} } : parseObject(original);
  if (parsed.status !== "ok") return { status: "refused", reason: parsed.status };
  if (!edit(parsed.doc)) return { status: "unchanged" };
  const refusal = writeConfigText(file, render(parsed.doc, original), read.status === "ok" ? read.mode : null, opts);
  return refusal === null ? { status: "changed" } : { status: "refused", reason: refusal };
}
