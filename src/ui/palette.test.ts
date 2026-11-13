import { describe, expect, it } from "vitest";

import type { UiMode } from "./env.js";
import { gradient, paint } from "./palette.js";
import { stripAnsi } from "./display.js";

const mode = (color: UiMode["color"]): UiMode => ({ rich: color !== 0, color, unicode: true, animate: false, columns: 80, verbose: false });

describe("paint", () => {
  it("is the identity at colour 0", () => {
    expect(paint(mode(0), "ok", "hi")).toBe("hi");
  });
  it("wraps with a reset otherwise", () => {
    expect(paint(mode(4), "fail", "x")).toBe("\u001b[31mx\u001b[0m");
    expect(paint(mode(24), "brand", "x")).toContain("38;2;");
    expect(paint(mode(8), "brand", "x")).toContain("38;5;");
  });
});

describe("gradient", () => {
  const art = ["██╗██╗   ██╗██████╗  █████╗ ██████╗ ████████╗███████╗", "abc"];
  it("is unchanged at colour 0", () => {
    expect(gradient(mode(0), art)).toEqual(art);
  });
  it("is one solid teal at 8 and 4 colours", () => {
    const out = gradient(mode(8), art);
    expect(out[0]).toBe(`\u001b[38;5;37m${art[0]}\u001b[0m`);
  });
  it("is nine bands at 24-bit with the exact endpoints, keeping the text intact", () => {
    const [first] = gradient(mode(24), art);
    // eslint-disable-next-line no-control-regex -- reading the escape codes back is the test
    const colours = [...(first ?? "").matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m/g)];
    expect(colours).toHaveLength(9);
    expect(colours[0]?.slice(1)).toEqual(["0", "136", "136"]);
    expect(colours[8]?.slice(1)).toEqual(["2", "224", "222"]);
    expect(stripAnsi(first ?? "")).toBe(art[0]);
  });
});
