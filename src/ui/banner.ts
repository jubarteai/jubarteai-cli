import { readFileSync } from "node:fs";

import { gradient } from "./palette.js";
import type { Ui } from "./index.js";

/** Below this many columns the six-line art would wrap, so a one-line mark is printed instead. */
export const COMPACT_BELOW = 72;
const REVEAL_MS = 30;

export type BannerRole = "installer" | "updater" | "uninstaller";

/** The ANSI Shadow "JUBARTEAI" art, moved verbatim from the old installer; the app's shim banner is pinned to this file. */
export function bannerLines(): string[] {
  try {
    const text = readFileSync(new URL("../../assets/banner.txt", import.meta.url), "utf8");
    return text.split(/\r?\n/).filter((line) => line !== "");
  } catch {
    return [];
  }
}

function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No blocking wait available: the banner simply appears at once.
  }
}

/**
 * The banner before the timeline: art with a teal gradient on a rich terminal, a one-line mark when narrow, and
 * nothing in plain mode (the timeline's title line is the plain header). `JUBARTEAI_BANNER=off` prints nothing: the
 * install shims print their own banner first and set it for the CLI they start.
 */
export function printBanner(ui: Ui, role: BannerRole, env: NodeJS.ProcessEnv = process.env): void {
  if (!ui.mode.rich || env["JUBARTEAI_BANNER"] === "off") return;
  const tagline = `Agentic Connection Platform · ${role}`;
  const art = bannerLines();
  if (ui.mode.columns < COMPACT_BELOW || art.length === 0) {
    ui.line(`${ui.paint("brand", ui.glyphs.active)} ${ui.paint("bold", "JubarteAI")}  ${ui.paint("dim", tagline)}`);
    return;
  }
  ui.line();
  for (const line of gradient(ui.mode, art)) {
    ui.line(line);
    if (ui.mode.animate) pause(REVEAL_MS);
  }
  ui.line();
  ui.line(ui.paint("dim", `  ${tagline}`));
  ui.line();
}
