import { isAbsolute, relative, resolve, sep } from "node:path";

import { safeForDisplay } from "../output.js";

const PATH_LIMIT = 400;
// CSI sequences (colours, cursor), OSC strings (title, hyperlinks) and lone two-byte escapes.
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

function inside(child: string, parent: string): string | null {
  const rel = relative(parent, child);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * A path for people: `./…` under the project root, else `~/…` under home, else as given. Control characters and
 * secrets are made safe, so a hostile file name can't write to the terminal.
 */
export function displayPath(file: string, opts: { home: string; root?: string | null }): string {
  const absolute = isAbsolute(file) ? resolve(file) : file;
  if (!isAbsolute(absolute)) return safeForDisplay(file, PATH_LIMIT);
  if (opts.root !== undefined && opts.root !== null) {
    const rel = inside(absolute, resolve(opts.root));
    if (rel !== null) return safeForDisplay(rel === "." ? "." : `./${rel}`, PATH_LIMIT);
  }
  const home = inside(absolute, resolve(opts.home));
  if (home !== null) return safeForDisplay(home === "." ? "~" : `~/${home}`, PATH_LIMIT);
  return safeForDisplay(absolute, PATH_LIMIT);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Columns a string takes on screen: escape sequences are zero wide, every other code point one. */
export function visibleWidth(text: string): number {
  return Array.from(stripAnsi(text)).length;
}

/** `text` cut to `width` visible columns with an ellipsis, never splitting an escape sequence. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const keep = Math.max(0, width - 1);
  let out = "";
  let seen = 0;
  let sawEscape = false;
  for (let i = 0; i < text.length; ) {
    ANSI.lastIndex = i;
    const match = ANSI.exec(text);
    if (match !== null && match.index === i) {
      out += match[0];
      sawEscape = true;
      i += match[0].length;
      continue;
    }
    const point = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(point);
    if (seen >= keep) break;
    out += char;
    seen += 1;
    i += char.length;
  }
  return `${out}…${sawEscape ? "\u001b[0m" : ""}`;
}
