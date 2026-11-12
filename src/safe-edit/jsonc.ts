// JSONC detection, ported from install.sh's stripJsonc: a config an editor may
// read as JSON-with-comments (Zed's settings.json, VS Code's mcp.json) holds
// `//` or `/* */` comments or trailing commas, none of which survive a
// JSON.parse / JSON.stringify round trip. The CLI never rewrites such a file;
// it only needs to tell it apart from plain invalid JSON.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const STAR = 0x2a;
const COMMA = 0x2c;

/** Index just past the string literal that starts at `start` (an unterminated one runs to the end of the text). */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text.charCodeAt(i) !== QUOTE) i += text.charCodeAt(i) === BACKSLASH ? 2 : 1;
  return Math.min(i + 1, text.length);
}

function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** True when `text` has a comment or a trailing comma outside its strings: `"http://x"` and `"/* y"` are strings, not comments. */
export function looksLikeJsonc(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      i = stringEnd(text, i);
      continue;
    }
    if (c === SLASH) {
      const next = text.charCodeAt(i + 1);
      if (next === SLASH || next === STAR) return true;
    }
    if (c === COMMA) {
      let j = i + 1;
      while (j < text.length && isJsonSpace(text.charCodeAt(j))) j++;
      const after = text[j];
      if (after === "}" || after === "]") return true;
    }
    i++;
  }
  return false;
}
