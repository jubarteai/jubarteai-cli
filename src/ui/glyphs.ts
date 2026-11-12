import type { UiMode } from "./env.js";

export type Glyphs = {
  open: string;
  bar: string;
  close: string;
  done: string;
  active: string;
  fail: string;
  warn: string;
  checked: string;
  unchecked: string;
  partial: string;
  pointer: string;
  radioOn: string;
  radioOff: string;
  spinner: readonly string[];
};

const UNICODE: Glyphs = {
  open: "┌",
  bar: "│",
  close: "└",
  done: "◇",
  active: "◆",
  fail: "▲",
  warn: "!",
  checked: "■",
  unchecked: "□",
  partial: "▣",
  pointer: "›",
  radioOn: "●",
  radioOff: "○",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII: Glyphs = {
  open: "+",
  bar: "|",
  close: "+",
  done: "*",
  active: ">",
  fail: "!",
  warn: "!",
  checked: "[x]",
  unchecked: "[ ]",
  partial: "[-]",
  pointer: ">",
  radioOn: "(*)",
  radioOff: "( )",
  spinner: ["|", "/", "-", "\\"],
};

export function glyphs(mode: UiMode): Glyphs {
  return mode.unicode ? UNICODE : ASCII;
}
