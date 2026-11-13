// A single question with Yes / No (and "Show the exact changes"): arrows, y/n/d and Enter on a raw terminal,
// `Proceed? [Y/n/d]` as a line elsewhere. "Show" prints the details and asks again.
import { CliError, ExitCode } from "../errors.js";
import { readHandleLine, withRawTerminal } from "../prompt.js";
import type { TtyHandle } from "../prompt.js";
import { safeForDisplay } from "../output.js";
import { truncate } from "./display.js";
import type { Ui } from "./index.js";
import type { Key } from "./keys.js";

type Option = "yes" | "no" | "show";
export type ChoiceInput = { question: string; options: ReadonlyArray<Option>; defaultIndex: number; details?: () => string[] };

const LABELS: Readonly<Record<Option, string>> = { yes: "Yes", no: "No", show: "Show the exact changes" };
const MAX_LINE_ATTEMPTS = 3;

function cancelled(): CliError {
  return new CliError("Cancelled.", ExitCode.SERVER_ERROR, "cancelled");
}

function writeLines(handle: TtyHandle, lines: string[]): void {
  for (const line of lines) handle.output.write(`${line}\n`);
}

/** `[Y/n/d]`: the default's letter in capitals. */
function hint(options: ReadonlyArray<Option>, defaultOption: Option): string {
  const letters = options.map((option) => {
    const letter = option === "yes" ? "y" : option === "no" ? "n" : "d";
    return option === defaultOption ? letter.toUpperCase() : letter;
  });
  return `[${letters.join("/")}]`;
}

async function lineForm(handle: TtyHandle, input: ChoiceInput, defaultOption: Option): Promise<"yes" | "no"> {
  const question = safeForDisplay(input.question, 300);
  for (let attempt = 0; attempt < MAX_LINE_ATTEMPTS; attempt += 1) {
    handle.output.write(`${question} ${hint(input.options, defaultOption)} `);
    const answer = await readHandleLine(handle);
    if (answer === null) return "no";
    const text = answer.trim().toLowerCase();
    if (text === "" && defaultOption !== "show") return defaultOption;
    if (text === "y" || text === "yes") return "yes";
    if (text === "n" || text === "no") return "no";
    if ((text === "d" || text === "show") && input.options.includes("show")) {
      writeLines(handle, input.details?.() ?? []);
      continue;
    }
    handle.output.write("Please answer y or n.\n");
  }
  return "no";
}

async function richForm(ui: Ui, handle: TtyHandle, keys: AsyncIterable<Key>, input: ChoiceInput): Promise<"yes" | "no"> {
  const g = ui.glyphs;
  let selected = Math.min(Math.max(input.defaultIndex, 0), input.options.length - 1);
  let drawn = 0;
  const out = (text: string): void => {
    handle.output.write(text);
  };
  const clear = (): void => {
    if (drawn > 0) out(`\u001b[${drawn}A\r\u001b[J`);
    drawn = 0;
  };
  const render = (): void => {
    clear();
    const choices = input.options
      .map((option, index) => (index === selected ? `${ui.paint("brand", g.radioOn)} ${LABELS[option]}` : ui.paint("dim", `${g.radioOff} ${LABELS[option]}`)))
      .join("  ");
    const lines = [`${ui.paint("brand", g.active)}  ${ui.paint("bold", safeForDisplay(input.question, 300))}`, `${ui.paint("dim", g.bar)}  ${choices}`].map((line) => truncate(line, ui.mode.columns));
    out(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  const answer = (value: "yes" | "no"): "yes" | "no" => {
    clear();
    out(`${ui.paint("ok", g.done)}  ${safeForDisplay(input.question, 300)}  ${ui.paint("dim", LABELS[value])}\n`);
    return value;
  };
  out("\u001b[?25l");
  try {
    render();
    for await (const key of keys) {
      if (key.name === "ctrl-c") {
        clear();
        throw cancelled();
      }
      if (key.name === "ctrl-d" || key.name === "escape") return answer("no");
      if (key.name === "left" || key.name === "up") selected = (selected + input.options.length - 1) % input.options.length;
      else if (key.name === "right" || key.name === "down") selected = (selected + 1) % input.options.length;
      else if (key.name === "char" && (key.char === "y" || key.char === "Y")) return answer("yes");
      else if (key.name === "char" && (key.char === "n" || key.char === "N")) return answer("no");
      else if ((key.name === "char" && (key.char === "d" || key.char === "D") && input.options.includes("show")) || (key.name === "enter" && input.options[selected] === "show")) {
        clear();
        writeLines(handle, input.details?.() ?? []);
      } else if (key.name === "enter") return answer(input.options[selected] === "yes" ? "yes" : "no");
      render();
    }
    return answer("no");
  } finally {
    out("\u001b[?25h");
  }
}

/** Resolves "yes" or "no". No terminal, end of input, Escape and too many bad answers are "no"; Ctrl-C rejects "Cancelled.". */
export function choice(ui: Ui, input: ChoiceInput): Promise<"yes" | "no"> {
  const defaultOption = input.options[Math.min(Math.max(input.defaultIndex, 0), input.options.length - 1)] ?? "yes";
  return withRawTerminal<"yes" | "no">("no", async (handle, keys) => {
    if (!ui.mode.rich || keys === null) return lineForm(handle, input, defaultOption);
    return richForm(ui, handle, keys, input);
  }, { raw: ui.mode.rich });
}
