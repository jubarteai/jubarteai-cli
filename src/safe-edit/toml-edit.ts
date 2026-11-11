// Line-based edits of a TOML config (Codex's config.toml). Nothing here parses
// the whole file into a document and prints it back: the text is scanned line
// by line with a quote-aware reader (comments, "=" and "," count only outside
// strings; a multi-line string or array is never read as a header), and an edit
// touches only the lines of the table it names. Every other byte (comments,
// other tables, spacing, line endings, a byte order mark) stays as it was.
// Ported from install.sh's codex_toml.
import { readConfigText, writeConfigText, type JsonEditResult } from "./json-edit.js";

/** Thrown when the table an edit names is also defined inline or by dotted keys (`jubarteai = { … }`), which a line edit can't rewrite safely. */
export class TomlConflictError extends Error {
  readonly code = "toml-conflict";
  constructor() {
    super("the table is also defined inline or with dotted keys");
    this.name = "TomlConflictError";
  }
}

type LineKind = "header" | "key" | "cont" | "blank" | "comment";

type Line = {
  /** Offset of the line's first character in the text (a byte order mark counts). */
  start: number;
  /** Offset just past the line's line ending (or the end of the text). */
  end: number;
  /** Offset where the line's content starts: `start`, or past a byte order mark. */
  cs: number;
  /** The line without its line ending or byte order mark. */
  content: string;
  kind: LineKind;
  /** Header: the dotted name. Key: the dotted key left of "=". Otherwise null. */
  segs: string[] | null;
  array: boolean;
  /** The table the line sits in (the header's own name on a header line). [] before any header. */
  table: string[];
  /** Index in `content` where a trailing comment starts, or the content length. */
  codeEnd: number;
  /** Index in `content` of the first "=" of a key line, or -1. */
  eq: number;
  /** For a key line: the index of the last line of its statement. */
  last: number;
};

type ScanState = { ml: string | null; depth: number };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const BARE_AT = /[A-Za-z0-9_-]+/y;
const BOM = "﻿";

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function unescapeBasic(s: string, pos: number): { value: string; end: number } | null {
  // pos is just past the opening quote
  let out = "";
  let i = pos;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    const simple = e === undefined ? undefined : SIMPLE_ESCAPES[e];
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    const width = e === "u" ? 4 : e === "U" ? 8 : 0;
    const hex = width > 0 ? s.slice(i + 2, i + 2 + width) : "";
    if (width === 0 || hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += 2 + width;
  }
  return null;
}

/** Reads a dotted key (bare or quoted segments) from `pos`; returns its segments and where it ends. */
function parseKey(s: string, pos: number): { segs: string[]; end: number } | null {
  const segs: string[] = [];
  let i = pos;
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    const c = s[i];
    if (c === '"') {
      const r = unescapeBasic(s, i + 1);
      if (r === null) return null;
      segs.push(r.value);
      i = r.end;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      segs.push(s.slice(i + 1, close));
      i = close + 1;
    } else {
      BARE_AT.lastIndex = i;
      const m = BARE_AT.exec(s);
      if (m === null) return null;
      segs.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === ".") {
      i++;
      continue;
    }
    return { segs, end: i };
  }
}

function parseHeader(content: string): { segs: string[]; array: boolean } | null {
  let i = 0;
  while (content[i] === " " || content[i] === "\t") i++;
  const array = content.startsWith("[[", i);
  const key = parseKey(content, i + (array ? 2 : 1));
  if (key === null) return null;
  const close = array ? "]]" : "]";
  if (!content.startsWith(close, key.end)) return null;
  const rest = content.slice(key.end + close.length).trimStart();
  if (rest !== "" && !rest.startsWith("#")) return null;
  return { segs: key.segs, array };
}

/** Where the delimiter `d` that closes a multi-line string starts in `s` (-1 if none). A backslash escapes the next character in a basic string only; up to two quotes before the delimiter belong to the string. */
function closeIndex(s: string, d: string): number {
  for (let i = 0; i <= s.length - 3; i++) {
    if (s[i] === "\\" && d === '"""') {
      i++;
      continue;
    }
    if (s.startsWith(d, i)) {
      let j = i;
      const q = d[0] as string;
      while (j - i < 2 && s[j + 3] === q) j++;
      return j;
    }
  }
  return -1;
}

function scanLine(content: string, st: ScanState): { codeEnd: number; eq: number; cont: boolean } {
  const cont = st.ml !== null || st.depth > 0;
  let i = 0;
  if (st.ml !== null) {
    const at = closeIndex(content, st.ml);
    if (at === -1) return { codeEnd: content.length, eq: -1, cont };
    i = at + 3;
    st.ml = null;
  }
  let q: string | null = null;
  let eq = -1;
  let codeEnd = content.length;
  for (; i < content.length; i++) {
    const c = content[i] as string;
    if (q === '"') {
      if (c === "\\") i++;
      else if (c === '"') q = null;
      continue;
    }
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = c + c + c;
      if (content.startsWith(triple, i)) {
        const at = closeIndex(content.slice(i + 3), triple);
        if (at === -1) {
          st.ml = triple;
          return { codeEnd: content.length, eq, cont };
        }
        i += 3 + at + 2;
        continue;
      }
      q = c;
      continue;
    }
    if (c === "#") {
      codeEnd = i;
      break;
    }
    if (c === "=" && eq === -1 && !cont) {
      eq = i;
      continue;
    }
    if (eq !== -1 || cont) {
      if (c === "[" || c === "{") st.depth++;
      else if ((c === "]" || c === "}") && st.depth > 0) st.depth--;
    }
  }
  return { codeEnd, eq, cont };
}

function sameSegs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function startsWithSegs(a: readonly string[], prefix: readonly string[]): boolean {
  return a.length >= prefix.length && prefix.every((s, i) => s === a[i]);
}

function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  const st: ScanState = { ml: null, depth: 0 };
  let table: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    let content = text.slice(pos, nl === -1 ? text.length : nl);
    if (content.endsWith("\r")) content = content.slice(0, -1);
    const bom = pos === 0 && content.startsWith(BOM) ? BOM.length : 0;
    content = content.slice(bom);
    const scan = scanLine(content, st);
    const trimmed = content.trim();
    const base = { start: pos, end, cs: pos + bom, content, array: false, codeEnd: scan.codeEnd, eq: scan.eq, last: lines.length };
    if (scan.cont) {
      lines.push({ ...base, kind: "cont", segs: null, table });
    } else if (trimmed === "") {
      lines.push({ ...base, kind: "blank", segs: null, table });
    } else if (trimmed.startsWith("#")) {
      lines.push({ ...base, kind: "comment", segs: null, table });
    } else {
      const header = trimmed.startsWith("[") ? parseHeader(content) : null;
      if (header !== null) {
        table = header.segs;
        lines.push({ ...base, kind: "header", segs: header.segs, array: header.array, table });
      } else {
        const key = scan.eq === -1 ? null : parseKey(content.slice(0, scan.eq), 0);
        const left = scan.eq === -1 ? "" : content.slice(0, scan.eq).slice(key?.end ?? 0);
        lines.push({ ...base, kind: "key", segs: key !== null && left.trim() === "" ? key.segs : null, table });
      }
    }
    pos = end;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (line.kind !== "key") continue;
    let j = i;
    while (lines[j + 1]?.kind === "cont") j++;
    line.last = j;
  }
  return lines;
}

/** Index of the last line that carries content (a key or its continuation) in the table whose header is `headerIdx`; the header itself for an empty table. */
function lastContentLine(lines: Line[], headerIdx: number): number {
  let last = headerIdx;
  for (let j = headerIdx + 1; j < lines.length; j++) {
    const kind = (lines[j] as Line).kind;
    if (kind === "header") break;
    if (kind === "key" || kind === "cont") last = j;
  }
  return last;
}

/** A table name in TOML key syntax ("mcp_servers.jubarteai", 'projects."/a/b.c"') as its segments; "" is the top level. */
function splitTable(table: string): string[] {
  if (table === "") return [];
  const key = parseKey(table, 0);
  if (key === null || key.end !== table.length) throw new RangeError("not a TOML table name");
  return key.segs;
}

function namedTable(table: string): string[] {
  const segs = splitTable(table);
  if (segs.length === 0) throw new RangeError("the top level has no table to edit");
  return segs;
}

function findHeader(lines: Line[], target: string[]): number {
  return lines.findIndex((l) => l.kind === "header" && !l.array && l.segs !== null && sameSegs(l.segs, target));
}

function detectEol(text: string): string {
  const nl = text.indexOf("\n");
  return nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
}

function hasInlineDefinition(lines: Line[], target: string[]): boolean {
  return lines.some((l) => {
    if (l.kind !== "key" || l.segs === null || startsWithSegs(l.table, target)) return false;
    const full = [...l.table, ...l.segs];
    return startsWithSegs(full, target) || (full.length < target.length && startsWithSegs(target, full));
  });
}

/** The table's lines: `start` is its header's offset, `end` just past its last key (trailing blank and comment lines belong to what follows), `body` what sits between. */
export function getTomlTable(text: string, table: string): { start: number; end: number; body: string } | null {
  const lines = parseLines(text);
  const idx = findHeader(lines, splitTable(table));
  if (idx === -1) return null;
  const header = lines[idx] as Line;
  const end = (lines[lastContentLine(lines, idx)] as Line).end;
  return { start: header.start, end, body: text.slice(header.end, end) };
}

/** Removes the table and its "table.*" sub-tables, with the blank lines right after each. Throws TomlConflictError when it is also defined inline. */
export function removeTomlTable(text: string, table: string): { text: string; changed: boolean } {
  const target = namedTable(table);
  const lines = parseLines(text);
  if (hasInlineDefinition(lines, target)) throw new TomlConflictError();
  const ranges: Array<{ start: number; end: number; first: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (line.kind !== "header" || line.segs === null) continue;
    const exact = sameSegs(line.segs, target) && !line.array;
    const sub = line.segs.length > target.length && startsWithSegs(line.segs, target);
    if (!exact && !sub) continue;
    let last = lastContentLine(lines, i);
    while (lines[last + 1]?.kind === "blank") last++;
    ranges.push({ start: line.start, end: (lines[last] as Line).end, first: i });
    i = last;
  }
  if (ranges.length === 0) return { text, changed: false };
  let out = text;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k] as (typeof ranges)[number];
    const floor = k > 0 ? (ranges[k - 1] as (typeof ranges)[number]).end : 0;
    let start = r.start;
    if (r.end === out.length) {
      // Nothing follows: the blank lines that separated it from what came before go with it.
      let prev = r.first;
      while (prev > 0 && (lines[prev - 1] as Line).kind === "blank" && (lines[prev - 1] as Line).start >= floor) {
        prev--;
        start = (lines[prev] as Line).start;
      }
    }
    out = out.slice(0, start) + out.slice(r.end);
  }
  return { text: out, changed: true };
}

function fmtKey(key: string): string {
  return BARE_KEY.test(key) ? key : fmtString(key);
}

const ESCAPES: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

function fmtString(value: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new RangeError("not a well-formed string");
  }
  // eslint-disable-next-line no-control-regex
  const body = value.replace(/[\u0000-\u001f"\\\u007f]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${body}"`;
}

function fmtValue(value: string | boolean | number): string {
  if (typeof value === "string") return fmtString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) throw new RangeError("not a finite number");
  return String(value);
}

/** The scalar a one-line value holds (a basic or literal string, true/false, a decimal number), or null for anything else. */
function parseValue(raw: string): string | boolean | number | null {
  if (raw.startsWith('"')) {
    if (raw.startsWith('"""')) return null;
    const r = unescapeBasic(raw, 1);
    return r !== null && r.end === raw.length ? r.value : null;
  }
  if (raw.startsWith("'")) {
    if (raw.startsWith("'''")) return null;
    return raw.length >= 2 && raw.endsWith("'") && !raw.slice(1, -1).includes("'") ? raw.slice(1, -1) : null;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
  return null;
}

function valueSpan(line: Line): { from: number; to: number } {
  let from = line.eq + 1;
  while (line.content[from] === " " || line.content[from] === "\t") from++;
  const to = line.content.slice(0, line.codeEnd).trimEnd().length;
  return { from, to: Math.max(from, to) };
}

function findKey(lines: Line[], target: string[], key: string): Line | undefined {
  return lines.find((l) => l.kind === "key" && l.segs !== null && sameSegs(l.table, target) && l.segs.length === 1 && l.segs[0] === key);
}

/** The value of `key` in `table` when it is a one-line scalar (string, boolean, decimal number); null when it is absent or anything else. */
export function readTomlKey(text: string, table: string, key: string): string | boolean | number | null {
  const lines = parseLines(text);
  const line = findKey(lines, splitTable(table), key);
  if (line === undefined || line.last !== lines.indexOf(line)) return null;
  const { from, to } = valueSpan(line);
  return parseValue(line.content.slice(from, to));
}

/**
 * Sets `key` in `table`: replaces the value in place (spacing and the comment after it stay), adds the key after the
 * table's last one, or appends the whole table at the end when it isn't there. A key already holding this value is left alone.
 * Throws TomlConflictError when the table is also defined inline or with dotted keys.
 */
export function setTomlKey(text: string, table: string, key: string, value: string | boolean | number): { text: string; changed: boolean } {
  const target = namedTable(table);
  const lines = parseLines(text);
  if (hasInlineDefinition(lines, target)) throw new TomlConflictError();
  const formatted = fmtValue(value);
  const eol = detectEol(text);
  const headerIdx = findHeader(lines, target);

  if (headerIdx === -1) {
    let out = text;
    if (out.length > 0) {
      if (!out.endsWith("\n")) out += eol;
      if (!/\n[ \t]*\r?\n$/.test(out)) out += eol;
    }
    out += `[${target.map(fmtKey).join(".")}]${eol}${fmtKey(key)} = ${formatted}${eol}`;
    return { text: out, changed: true };
  }

  const existing = findKey(lines, target, key);
  if (existing !== undefined) {
    const idx = lines.indexOf(existing);
    if (existing.last === idx) {
      const { from, to } = valueSpan(existing);
      if (parseValue(existing.content.slice(from, to)) === value) return { text, changed: false };
      const at = existing.cs;
      return { text: text.slice(0, at + from) + formatted + text.slice(at + to), changed: true };
    }
    const lastLine = lines[existing.last] as Line;
    const tail = lastLine.content.slice(lastLine.content.slice(0, lastLine.codeEnd).trimEnd().length);
    const lineEol = text.slice(lastLine.cs + lastLine.content.length, lastLine.end);
    const replacement = `${existing.content.slice(0, existing.eq)}= ${formatted}${tail}${lineEol}`;
    return { text: text.slice(0, existing.start) + (existing.cs > existing.start ? BOM : "") + replacement + text.slice(lastLine.end), changed: true };
  }

  const last = lines[lastContentLine(lines, headerIdx)] as Line;
  const hadEol = text.slice(last.cs + last.content.length, last.end) !== "";
  const insert = `${hadEol ? "" : eol}${fmtKey(key)} = ${formatted}${eol}`;
  return { text: text.slice(0, last.end) + insert + text.slice(last.end), changed: true };
}

/**
 * Apply `edit` to the TOML text in `file`, written back atomically (exact mode, guards against symlinks, other owners and
 * hard links) only when `edit` says it changed something. "refused" carries the guard's reason, or "invalid-json" for a
 * file that is not UTF-8 text or is too big to be a config; nothing is written then.
 */
export function editTomlFile(file: string, edit: (text: string) => { text: string; changed: boolean }, opts: { createIfMissing: boolean; mode?: number; withinHome?: boolean }): JsonEditResult {
  const read = readConfigText(file);
  if (read.status === "unreadable") return { status: "refused", reason: "invalid-json" };
  if (read.status === "missing" && !opts.createIfMissing) return { status: "missing" };
  const result = edit(read.status === "ok" ? read.text : "");
  if (!result.changed) return { status: "unchanged" };
  const refusal = writeConfigText(file, result.text, read.status === "ok" ? read.mode : null, opts);
  return refusal === null ? { status: "changed" } : { status: "refused", reason: refusal };
}
