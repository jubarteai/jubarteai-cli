// The one approval: a grouped checklist with every row checked. Arrow keys, Space and Enter on a terminal in raw
// mode; a numbered line form in plain mode or when raw mode isn't available. `d` shows the exact changes first.
import { CliError, ExitCode } from "../errors.js";
import { readHandleLine, withRawTerminal } from "../prompt.js";
import type { TtyHandle } from "../prompt.js";
import { safeForDisplay } from "../output.js";
import { truncate } from "./display.js";
import type { Ui } from "./index.js";
import type { Key } from "./keys.js";

export type ChecklistRow = { key: string; label: string; checked: boolean };
export type ChecklistGroup = { key: string; title: string; note?: string; rows: ChecklistRow[] };
export type ChecklistResult = { kind: "apply"; checked: ReadonlySet<string> } | { kind: "declined" };
export type ChecklistInput = { title: string; hint: string; groups: ChecklistGroup[]; details(checked: ReadonlySet<string>): string[] };

const MAX_LINE_ATTEMPTS = 3;
const ROW_LIMIT = 300;

type Item = { kind: "group"; group: number } | { kind: "row"; group: number; row: number };

function cancelled(): CliError {
  return new CliError("Cancelled.", ExitCode.SERVER_ERROR, "cancelled");
}

function itemsOf(groups: ChecklistGroup[]): Item[] {
  const items: Item[] = [];
  groups.forEach((group, g) => {
    items.push({ kind: "group", group: g });
    group.rows.forEach((_row, r) => items.push({ kind: "row", group: g, row: r }));
  });
  return items;
}

function checkedKeys(state: boolean[][], groups: ChecklistGroup[]): Set<string> {
  const keys = new Set<string>();
  groups.forEach((group, g) => group.rows.forEach((row, r) => state[g]?.[r] === true && keys.add(row.key)));
  return keys;
}

function groupState(state: boolean[][], g: number): "all" | "none" | "some" {
  const rows = state[g] ?? [];
  const on = rows.filter(Boolean).length;
  return on === 0 ? "none" : on === rows.length ? "all" : "some";
}

/** The numbered rows of the line form, in display order. */
function numbered(groups: ChecklistGroup[]): Array<{ number: number; g: number; r: number }> {
  const out: Array<{ number: number; g: number; r: number }> = [];
  let n = 0;
  groups.forEach((group, g) => group.rows.forEach((_row, r) => out.push({ number: (n += 1), g, r })));
  return out;
}

/** "2 5", "3-4", "2,5": the numbers to leave out; null when something in it isn't a number or a range. */
export function parseLeaveOut(text: string, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const token of text.split(/[\s,]+/).filter((t) => t !== "")) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    const single = /^(\d+)$/.exec(token);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > max || from > to) return null;
      for (let n = from; n <= to; n += 1) out.add(n);
    } else if (single !== null) {
      const n = Number(single[1]);
      if (n < 1 || n > max) return null;
      out.add(n);
    } else return null;
  }
  return out;
}

function writeLines(handle: TtyHandle, lines: string[]): void {
  for (const line of lines) handle.output.write(`${line}\n`);
}

async function lineForm(ui: Ui, handle: TtyHandle, input: ChecklistInput, state: boolean[][]): Promise<ChecklistResult> {
  const rows = numbered(input.groups);
  const header = (): void => {
    handle.output.write(`${input.title}:\n`);
    input.groups.forEach((group, g) => {
      handle.output.write(`  ${safeForDisplay(group.title, ROW_LIMIT)}${group.note === undefined ? "" : `  ${safeForDisplay(group.note, ROW_LIMIT)}`}\n`);
      for (const entry of rows.filter((e) => e.g === g)) {
        const row = group.rows[entry.r];
        if (row !== undefined) handle.output.write(`    ${entry.number}. ${safeForDisplay(row.label, ROW_LIMIT)}\n`);
      }
    });
  };
  header();
  for (let attempt = 0; attempt < MAX_LINE_ATTEMPTS; attempt += 1) {
    handle.output.write("Type the numbers to leave out (e.g. 2 5), d to show the exact changes, or press Enter for all: ");
    const answer = await readHandleLine(handle);
    if (answer === null) return { kind: "declined" };
    const text = answer.trim();
    if (text.toLowerCase() === "d") {
      writeLines(handle, input.details(checkedKeys(state, input.groups)));
      continue;
    }
    const leave = text === "" ? new Set<number>() : parseLeaveOut(text, rows.length);
    if (leave === null) {
      handle.output.write("Please type row numbers like 2 5 or 3-4, d, or press Enter.\n");
      continue;
    }
    for (const entry of rows) {
      const row = state[entry.g];
      if (row !== undefined) row[entry.r] = !leave.has(entry.number);
    }
    const checked = checkedKeys(state, input.groups);
    return checked.size === 0 ? { kind: "declined" } : { kind: "apply", checked };
  }
  return { kind: "declined" };
}

async function richForm(ui: Ui, handle: TtyHandle, keys: AsyncIterable<Key>, input: ChecklistInput, state: boolean[][]): Promise<ChecklistResult> {
  const g = ui.glyphs;
  const items = itemsOf(input.groups);
  const total = input.groups.reduce((sum, group) => sum + group.rows.length, 0);
  let cursor = items.findIndex((item) => item.kind === "row");
  if (cursor < 0) cursor = 0;
  let drawn = 0;
  const width = ui.mode.columns;

  const out = (text: string): void => {
    handle.output.write(text);
  };
  const clear = (): void => {
    if (drawn > 0) out(`\u001b[${drawn}A\r\u001b[J`);
    drawn = 0;
  };
  const box = (state: "all" | "none" | "some" | boolean): string => {
    const kind = state === true || state === "all" ? "checked" : state === "some" ? "partial" : "unchecked";
    const glyph = kind === "checked" ? g.checked : kind === "partial" ? g.partial : g.unchecked;
    return kind === "unchecked" ? ui.paint("dim", glyph) : ui.paint("brand", glyph);
  };
  const render = (): void => {
    clear();
    const lines: string[] = [`${ui.paint("brand", g.active)}  ${ui.paint("bold", safeForDisplay(input.title, ROW_LIMIT))}`, `${ui.paint("dim", g.bar)}  ${ui.paint("dim", input.hint)}`];
    items.forEach((item, index) => {
      const here = index === cursor;
      const pointer = here ? ui.paint("accent", g.pointer) : " ";
      if (item.kind === "group") {
        const group = input.groups[item.group];
        if (group === undefined) return;
        const note = group.note === undefined ? "" : `  ${ui.paint("dim", safeForDisplay(group.note, ROW_LIMIT))}`;
        lines.push(`${ui.paint("dim", g.bar)}  ${pointer} ${box(groupState(state, item.group))} ${ui.paint("bold", safeForDisplay(group.title, ROW_LIMIT))}${note}`);
      } else {
        const row = input.groups[item.group]?.rows[item.row];
        if (row === undefined) return;
        lines.push(`${ui.paint("dim", g.bar)}  ${pointer}     ${box(state[item.group]?.[item.row] === true)} ${safeForDisplay(row.label, ROW_LIMIT)}`);
      }
    });
    const fitted = lines.map((line) => truncate(line, width));
    out(`${fitted.join("\n")}\n`);
    drawn = fitted.length;
  };
  const finish = (text: string): void => {
    clear();
    out(`${ui.paint("ok", g.done)}  ${safeForDisplay(input.title, ROW_LIMIT)}  ${ui.paint("dim", text)}\n`);
  };
  const toggle = (): void => {
    const item = items[cursor];
    if (item === undefined) return;
    if (item.kind === "row") {
      const rows = state[item.group];
      if (rows !== undefined) rows[item.row] = rows[item.row] !== true;
    } else {
      const rows = state[item.group];
      if (rows !== undefined) {
        const turnOn = groupState(state, item.group) !== "all";
        for (let r = 0; r < rows.length; r += 1) rows[r] = turnOn;
      }
    }
  };

  out("\u001b[?25l");
  try {
    render();
    for await (const key of keys) {
      if (key.name === "ctrl-c") {
        clear();
        throw cancelled();
      }
      if (key.name === "ctrl-d" || key.name === "escape") {
        finish("declined");
        return { kind: "declined" };
      }
      if (key.name === "up") cursor = (cursor + items.length - 1) % items.length;
      else if (key.name === "down") cursor = (cursor + 1) % items.length;
      else if (key.name === "space") toggle();
      else if (key.name === "char" && (key.char === "d" || key.char === "D")) {
        clear();
        writeLines(handle, input.details(checkedKeys(state, input.groups)));
      } else if (key.name === "enter") {
        const checked = checkedKeys(state, input.groups);
        if (checked.size === 0) {
          finish("nothing selected");
          return { kind: "declined" };
        }
        finish(`${checked.size} of ${total}`);
        return { kind: "apply", checked };
      }
      render();
    }
    finish("declined");
    return { kind: "declined" };
  } finally {
    out("\u001b[?25h");
  }
}

/**
 * Shows the groups with every row checked and returns the rows left checked when the person confirms, or `declined`
 * (nothing checked, Escape, end of input, no terminal). Ctrl-C rejects with "Cancelled." and applies nothing.
 */
export function checklist(ui: Ui, input: ChecklistInput): Promise<ChecklistResult> {
  const state = input.groups.map((group) => group.rows.map((row) => row.checked));
  return withRawTerminal<ChecklistResult>({ kind: "declined" }, async (handle, keys) => {
    if (!ui.mode.rich || keys === null) return lineForm(ui, handle, input, state);
    return richForm(ui, handle, keys, input, state);
  }, { raw: ui.mode.rich });
}
