// The two glyph sets: the Unicode one for UTF-8 terminals, and the ASCII fallback for a non-UTF-8 locale or a legacy
// Windows console, where a single non-ASCII glyph prints as mojibake.
import { describe, expect, it } from "vitest";

import { detectUiMode } from "./env.js";
import type { UiMode } from "./env.js";
import { glyphs } from "./glyphs.js";
import type { Glyphs } from "./glyphs.js";

const tty = { isTTY: true, columns: 80, getColorDepth: () => 24 };
const unicodeMode: UiMode = detectUiMode(tty, { env: { LANG: "en_US.UTF-8" }, platform: "linux" });
const asciiMode: UiMode = detectUiMode(tty, { env: { LANG: "C" }, platform: "linux" });

/** Every glyph of a set, the spinner's frames included, as [name, text]. */
function entries(set: Glyphs): Array<[string, string]> {
  return Object.entries(set).flatMap(([name, value]): Array<[string, string]> =>
    Array.isArray(value) ? value.map((frame, i): [string, string] => [`${name}[${i}]`, String(frame)]) : [[name, String(value)]],
  );
}

describe("glyphs", () => {
  it("picks the Unicode set on a UTF-8 terminal and the ASCII set off one", () => {
    expect(unicodeMode.unicode).toBe(true);
    expect(asciiMode.unicode).toBe(false);
    expect(glyphs(unicodeMode).checked).toBe("■");
    expect(glyphs(asciiMode).checked).toBe("[x]");
  });

  it("the ASCII set is printable ASCII only, every glyph of it", () => {
    const all = entries(glyphs(asciiMode));
    expect(all.length).toBeGreaterThan(10);
    for (const [name, text] of all) {
      expect(text, name).not.toBe("");
      expect(/^[\x20-\x7e]+$/.test(text), `${name} = ${JSON.stringify(text)}`).toBe(true);
    }
  });

  it("both sets name the same glyphs, none empty, with a spinner of at least two frames", () => {
    const unicode = glyphs(unicodeMode);
    const ascii = glyphs(asciiMode);
    expect(Object.keys(unicode).sort()).toEqual(Object.keys(ascii).sort());
    for (const [name, text] of entries(unicode)) expect(text, name).not.toBe("");
    expect(unicode.spinner.length).toBeGreaterThanOrEqual(2);
    expect(ascii.spinner.length).toBeGreaterThanOrEqual(2);
  });

  it("the checklist's boxes and the scroll arrows are told apart in both sets", () => {
    for (const set of [glyphs(unicodeMode), glyphs(asciiMode)]) {
      expect(new Set([set.checked, set.unchecked, set.partial]).size).toBe(3);
      expect(set.up).not.toBe(set.down);
      expect(set.radioOn).not.toBe(set.radioOff);
    }
  });
});
