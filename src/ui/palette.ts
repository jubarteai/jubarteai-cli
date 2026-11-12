import type { UiMode } from "./env.js";

export type Role = "brand" | "accent" | "ok" | "warn" | "fail" | "dim" | "bold";

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

/** Brand teal, the gradient's two ends (the old installer's, matching the dashboard's accent). */
const BRAND_DEEP: readonly [number, number, number] = [0, 136, 136];
const BRAND_BRIGHT: readonly [number, number, number] = [2, 224, 222];
const BANDS = 9;

const CODES: Readonly<Record<Exclude<Role, "brand" | "accent">, string>> = {
  ok: "32",
  warn: "33",
  fail: "31",
  dim: "2",
  bold: "1",
};

function brandCode(color: 4 | 8 | 24, bright: boolean): string {
  if (color === 24) return bright ? "38;2;2;224;222" : "38;2;0;175;175";
  if (color === 8) return bright ? "38;5;80" : "38;5;37";
  return bright ? "96" : "36";
}

/** `text` in the role's colour; the identity when colour is off. */
export function paint(mode: UiMode, role: Role, text: string): string {
  if (mode.color === 0 || text === "") return text;
  const code = role === "brand" ? brandCode(mode.color, false) : role === "accent" ? brandCode(mode.color, true) : CODES[role];
  return `${ESC}[${code}m${text}${RESET}`;
}

function lerp(t: number): [number, number, number] {
  const [r0, g0, b0] = BRAND_DEEP;
  const [r1, g1, b1] = BRAND_BRIGHT;
  return [Math.round(r0 + (r1 - r0) * t), Math.round(g0 + (g1 - g0) * t), Math.round(b0 + (b1 - b0) * t)];
}

/**
 * Each line in nine horizontal bands from deep to bright teal at 24-bit colour (cut by code point, so a box-drawing
 * glyph is never split); one solid teal at 8 and 4 colours; unchanged at none.
 */
export function gradient(mode: UiMode, lines: string[]): string[] {
  if (mode.color === 0) return lines;
  if (mode.color !== 24) return lines.map((line) => paint(mode, "brand", line));
  return lines.map((line) => {
    const chars = Array.from(line);
    let out = "";
    for (let band = 0; band < BANDS; band += 1) {
      const text = chars.slice(Math.floor((band * chars.length) / BANDS), Math.floor(((band + 1) * chars.length) / BANDS)).join("");
      if (text === "") continue;
      const [r, g, b] = lerp(band / (BANDS - 1));
      out += `${ESC}[38;2;${r};${g};${b}m${text}`;
    }
    return `${out}${RESET}`;
  });
}
