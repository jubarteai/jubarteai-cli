import type { Glyphs } from "./glyphs.js";
import type { Role } from "./palette.js";

const FRAME_MS = 80;
/** A step that finishes within this never shows a spinner (no flicker for fast work). */
const START_DELAY_MS = 150;
const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const CLEAR_LINE = "\r\u001b[2K";

export type SpinnerOptions = {
  out: NodeJS.WritableStream;
  glyphs: Glyphs;
  animate: boolean;
  paint: (role: Role, text: string) => string;
  /** Prefix kept on every frame so the spinner sits inside the timeline's bar. */
  prefix?: string;
};

let exitHooked = false;
const active = new Set<NodeJS.WritableStream>();

function restoreAll(): void {
  for (const stream of active) {
    try {
      stream.write(`${CLEAR_LINE}${SHOW}`);
    } catch {
      // The stream is gone; nothing to restore.
    }
  }
  active.clear();
}

/**
 * Runs `work` and, while it takes longer than a moment on an animating terminal, shows a one-line spinner with
 * `label`. The cursor is hidden only while a frame is live and is restored on resolve, reject and process exit.
 * Prints nothing at all when not animating, so a pipe or a plain run is unchanged.
 */
export async function spinner<T>(label: string, work: () => Promise<T>, opts: SpinnerOptions): Promise<T> {
  if (!opts.animate) return work();
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", restoreAll);
  }
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  const prefix = opts.prefix ?? "";
  const draw = (): void => {
    const glyph = opts.glyphs.spinner[frame % opts.glyphs.spinner.length] ?? "";
    opts.out.write(`${CLEAR_LINE}${prefix}${opts.paint("brand", glyph)}  ${label}`);
    frame += 1;
  };
  const delay = setTimeout(() => {
    active.add(opts.out);
    opts.out.write(HIDE);
    draw();
    timer = setInterval(draw, FRAME_MS);
    timer.unref();
  }, START_DELAY_MS);
  delay.unref();
  try {
    return await work();
  } finally {
    clearTimeout(delay);
    if (timer !== undefined) {
      clearInterval(timer);
      opts.out.write(`${CLEAR_LINE}${SHOW}`);
      active.delete(opts.out);
    }
  }
}
