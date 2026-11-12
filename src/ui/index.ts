// The human-output toolkit: a Ui is built only by commands a person runs (init, update, login, …), never by tool
// commands, --json or hooks, so an escape code can't reach machine output (detectUiMode gates on the stream anyway).
import { printBanner } from "./banner.js";
import type { BannerRole } from "./banner.js";
import { detectUiMode } from "./env.js";
import type { UiMode } from "./env.js";
import { glyphs } from "./glyphs.js";
import type { Glyphs } from "./glyphs.js";
import { paint } from "./palette.js";
import type { Role } from "./palette.js";
import { spinner } from "./spinner.js";
import { createTimeline } from "./timeline.js";
import type { Timeline } from "./timeline.js";

export type { UiMode, ColorTier } from "./env.js";
export type { Glyphs } from "./glyphs.js";
export type { Role } from "./palette.js";
export type { Timeline, RowKind } from "./timeline.js";

export type Ui = {
  mode: UiMode;
  out: NodeJS.WritableStream;
  line(text?: string): void;
  paint: (role: Role, text: string) => string;
  glyphs: Glyphs;
  banner(role: BannerRole): void;
  timeline(): Timeline;
  spin<T>(label: string, work: () => Promise<T>): Promise<T>;
};

export function createUi(
  out: NodeJS.WritableStream,
  opts: { plain?: boolean; verbose?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Ui {
  const env = opts.env ?? process.env;
  const mode = detectUiMode(out, opts);
  const set = glyphs(mode);
  const ui: Ui = {
    mode,
    out,
    glyphs: set,
    line(text = "") {
      out.write(`${text}\n`);
    },
    paint: (role, text) => paint(mode, role, text),
    banner: (role) => printBanner(ui, role, env),
    timeline: () => createTimeline(ui),
    spin: (label, work) => spinner(label, work, { out, glyphs: set, animate: mode.animate, paint: ui.paint, prefix: mode.rich ? `${ui.paint("dim", set.bar)}  ` : "" }),
  };
  return ui;
}
