import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeStream, fakeTerminal } from "../../test/helpers/ui-streams.js";
import type { FakeTerminal } from "../../test/helpers/ui-streams.js";
import { stripAnsi } from "./display.js";
import { checklist, parseLeaveOut } from "./checklist.js";
import type { ChecklistGroup } from "./checklist.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };
let term: FakeTerminal | null = null;
afterEach(() => {
  term?.restore();
  term = null;
});

const richUi = () => createUi(fakeStream({ tty: true, columns: 100, depth: 24 }), { platform: "linux", env: UTF8 });
const plainUi = () => createUi(fakeStream(), { plain: true, platform: "linux", env: UTF8 });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

function groups(): ChecklistGroup[] {
  return [
    {
      key: "claude-code",
      title: "Claude Code",
      rows: [
        { key: "a", label: "Install skill", checked: true },
        { key: "b", label: "Add the permission rule", checked: true },
        { key: "c", label: "Add the hooks", checked: true },
      ],
    },
    { key: "repo", title: "Repo", note: "~/work/repo", rows: [{ key: "d", label: "Bind this repo", checked: true }, { key: "e", label: "AGENTS.md section", checked: true }] },
  ];
}
const input = (over: { details?: (checked: ReadonlySet<string>) => string[] } = {}) => ({
  title: "Choose what to set up",
  hint: "↑/↓ move · space toggle · d show the exact changes · enter apply",
  groups: groups(),
  details: over.details ?? (() => ["EXACT"]),
});

describe("checklist: a list taller than the terminal", () => {
  const tall = (): ChecklistGroup[] => [
    { key: "g", title: "Everything", rows: Array.from({ length: 30 }, (_v, i) => ({ key: `r${i}`, label: `Row number ${i}`, checked: true })) },
  ];
  const tallInput = () => ({ title: "Choose", hint: "hint", groups: tall(), details: () => [] });
  /** The last frame: what the cursor-up/erase sequence of the final redraw left on screen. */
  const lastFrame = (shown: string): string[] => stripAnsi(shown.split("\u001b[J").pop() ?? "").split("\n").filter((l) => l !== "");

  it("draws a window that fits, scrolls it with the cursor, and applies every row on Enter", async () => {
    term = fakeTerminal({ rows: 12 });
    const pending = checklist(richUi(), tallInput());
    await tick();
    let frame = lastFrame(term.shown());
    expect(frame.length).toBeLessThanOrEqual(11);
    expect(frame.join("\n")).toContain("Row number 0");
    expect(frame.join("\n")).not.toContain("Row number 29");
    expect(frame.join("\n")).toMatch(/↓ \d+ more/);
    term.type("\u001b[A"); // wraps from the first row up through the header to the last row
    term.type("\u001b[A");
    await tick();
    frame = lastFrame(term.shown());
    expect(frame.length).toBeLessThanOrEqual(11);
    expect(frame.join("\n")).toContain("Row number 29");
    expect(frame.join("\n")).toMatch(/↑ \d+ more/);
    term.type("\r");
    const result = await pending;
    expect(result.kind).toBe("apply");
    expect(result.kind === "apply" && result.checked.size).toBe(30);
  });

  it("Space toggles the row the cursor is on after the window scrolled, and every frame keeps the same height", async () => {
    term = fakeTerminal({ rows: 12 });
    const pending = checklist(richUi(), tallInput());
    await vi.waitFor(() => expect(term?.shown()).toContain("Row number 0"));
    // From the first row down 15: the cursor is on row 15, far below the first window.
    for (let i = 0; i < 15; i += 1) term.type("\u001b[B");
    await vi.waitFor(() => expect(lastFrame(term?.shown() ?? "").join("\n")).toMatch(/› +■ Row number 15/));
    const frame = lastFrame(term.shown());
    expect(frame.join("\n")).toMatch(/↑ \d+ more/);
    expect(frame.join("\n")).toMatch(/↓ \d+ more/);
    expect(frame.join("\n")).not.toContain("Row number 0");
    term.type(" ");
    await vi.waitFor(() => expect(lastFrame(term?.shown() ?? "").join("\n")).toMatch(/› +□ Row number 15/));
    // The window doesn't grow or shrink as the cursor moves: every redraw is the same height.
    const heights = new Set(
      term
        .shown()
        .split("\u001b[J")
        .slice(1)
        .map((chunk) => chunk.split("\n").length),
    );
    expect(heights.size).toBe(1);
    term.type("\r");
    const result = await pending;
    expect(result.kind === "apply" && [...result.checked].sort()).toEqual(
      Array.from({ length: 30 }, (_v, i) => `r${i}`)
        .filter((k) => k !== "r15")
        .sort(),
    );
  });

  it("uses ASCII arrows for the more lines off a UTF-8 locale", async () => {
    term = fakeTerminal({ rows: 12 });
    const pending = checklist(createUi(fakeStream({ tty: true, columns: 100, depth: 24 }), { platform: "linux", env: { LANG: "C" } }), tallInput());
    await vi.waitFor(() => expect(lastFrame(term?.shown() ?? "").join("\n")).toMatch(/v \d+ more/));
    expect(term.shown()).not.toMatch(/[↑↓]/);
    term.type("\u001b[A");
    term.type("\u001b[A");
    await vi.waitFor(() => expect(lastFrame(term?.shown() ?? "").join("\n")).toMatch(/\^ \d+ more/));
    term.type("\r");
    expect((await pending).kind).toBe("apply");
  });

  it("assumes 24 rows when the terminal doesn't say how tall it is", async () => {
    term = fakeTerminal();
    const pending = checklist(richUi(), tallInput());
    await vi.waitFor(() => expect(lastFrame(term?.shown() ?? "").join("\n")).toMatch(/↓ \d+ more/));
    expect(lastFrame(term.shown()).length).toBeLessThanOrEqual(23);
    term.type("\r");
    await pending;
  });

  it("the line form lists every row, however short the terminal", async () => {
    term = fakeTerminal({ rows: 12 });
    const pending = checklist(plainUi(), tallInput());
    await vi.waitFor(() => expect(term?.shown()).toContain("press Enter for all"));
    expect(term.shown()).toContain("    1. Row number 0\n");
    expect(term.shown()).toContain("    30. Row number 29\n");
    expect(term.shown()).not.toMatch(/more/);
    term.type("1-29\n");
    expect(await pending).toEqual({ kind: "apply", checked: new Set(["r29"]) });
  });

  it("draws everything when the list fits", async () => {
    term = fakeTerminal({ rows: 40 });
    const pending = checklist(richUi(), input());
    await tick();
    expect(stripAnsi(term.shown())).not.toMatch(/more/);
    term.type("\r");
    await pending;
  });
});

describe("checklist: rich form", () => {
  it("renders every row checked and applies them all on Enter", async () => {
    term = fakeTerminal();
    const pending = checklist(richUi(), input());
    await tick();
    const frame = stripAnsi(term.shown());
    expect(frame).toContain("◆  Choose what to set up");
    expect(frame).toContain("■ Claude Code");
    expect(frame).toContain("›     ■ Install skill");
    expect(frame).toContain("■ Install skill");
    expect(frame).toContain("■ Bind this repo");
    term.type("\r");
    const result = await pending;
    expect(result).toEqual({ kind: "apply", checked: new Set(["a", "b", "c", "d", "e"]) });
    expect(stripAnsi(term.shown())).toContain("◇  Choose what to set up  5 of 5");
    expect(term.rawModes).toEqual([true, false]);
    expect(term.closed()).toBe(true);
  });

  it("Space on a group header toggles all its rows and shows a partial box when mixed", async () => {
    term = fakeTerminal();
    const pending = checklist(richUi(), input());
    await tick();
    term.type("\u001b[A"); // up to the Claude Code header
    await tick();
    term.type(" "); // uncheck the whole group
    await tick();
    expect(stripAnsi(term.shown())).toContain("□ Claude Code");
    term.type("\u001b[B "); // down to "Install skill", re-check just it
    await tick();
    expect(stripAnsi(term.shown())).toContain("▣ Claude Code");
    term.type("\r");
    expect(await pending).toEqual({ kind: "apply", checked: new Set(["a", "d", "e"]) });
  });

  it("d prints the details for the checked rows, then the checklist is drawn again", async () => {
    term = fakeTerminal();
    const seen: string[][] = [];
    const pending = checklist(richUi(), input({ details: (checked) => (seen.push([...checked]), ["EXACT ENTRY"]) }));
    await tick();
    term.type("d");
    await tick();
    expect(stripAnsi(term.shown())).toContain("EXACT ENTRY");
    expect(seen[0]).toEqual(["a", "b", "c", "d", "e"]);
    term.type("\r");
    expect((await pending).kind).toBe("apply");
  });

  it("Enter with nothing checked is declined", async () => {
    term = fakeTerminal();
    const pending = checklist(richUi(), input());
    await tick();
    term.type("\u001b[A \u001b[B\u001b[B\u001b[B\u001b[B "); // header 1 off, then the Repo header off
    await tick();
    term.type("\r");
    expect(await pending).toEqual({ kind: "declined" });
  });

  it("Ctrl-C rejects with Cancelled and restores raw mode and the cursor", async () => {
    term = fakeTerminal();
    const pending = checklist(richUi(), input());
    await tick();
    term.type("\u0003");
    await expect(pending).rejects.toThrow("Cancelled.");
    expect(term.rawModes).toEqual([true, false]);
    expect(term.shown().endsWith("\u001b[?25h")).toBe(true);
  });

  it("truncates rows to the terminal width", async () => {
    term = fakeTerminal();
    const wide = input();
    wide.groups[0]!.rows[0]!.label = "x".repeat(300);
    const pending = checklist(createUi(fakeStream({ tty: true, columns: 50, depth: 24 }), { platform: "linux", env: UTF8 }), wide);
    await tick();
    for (const line of stripAnsi(term.shown()).split("\n")) expect(Array.from(line).length).toBeLessThanOrEqual(50);
    term.type("\r");
    await pending;
  });
});

describe("checklist: line form", () => {
  it("plain mode: Enter applies all rows, listing numbered rows by group", async () => {
    term = fakeTerminal();
    const pending = checklist(plainUi(), input());
    await tick();
    const shown = term.shown();
    expect(shown).toContain("Choose what to set up:\n  Claude Code\n    1. Install skill\n    2. Add the permission rule\n    3. Add the hooks\n  Repo  ~/work/repo\n    4. Bind this repo\n    5. AGENTS.md section\n");
    expect(shown).toContain("Type the numbers to leave out (e.g. 2 5), d to show the exact changes, or press Enter for all: ");
    term.type("\n");
    expect(await pending).toEqual({ kind: "apply", checked: new Set(["a", "b", "c", "d", "e"]) });
    // Plain mode never switches the terminal to raw mode.
    expect(term.rawModes).toEqual([]);
  });

  it("leaves out numbers and ranges", async () => {
    term = fakeTerminal();
    const pending = checklist(plainUi(), input());
    await tick();
    term.type("2 4-5\n");
    expect(await pending).toEqual({ kind: "apply", checked: new Set(["a", "c"]) });
  });

  it("d shows the details and asks again; invalid input three times declines", async () => {
    term = fakeTerminal();
    const pending = checklist(plainUi(), input());
    await tick();
    term.type("d\n");
    await tick();
    expect(term.shown()).toContain("EXACT");
    term.type("zz\n");
    await tick();
    expect(term.shown()).toContain("Please type row numbers");
    term.type("what\n");
    // Three asks in all (the details view counts as one): declined.
    expect(await pending).toEqual({ kind: "declined" });
  });

  it("falls back to the line form when raw mode throws, and when there is no setRawMode", async () => {
    for (const rawMode of ["throws", "missing"] as const) {
      term = fakeTerminal({ rawMode });
      const pending = checklist(richUi(), input());
      await tick();
      expect(term.shown()).toContain("1. Install skill");
      term.type("1 2 3 4 5\n");
      expect(await pending).toEqual({ kind: "declined" });
      term.restore();
    }
  });

  it("with no terminal at all it declines", async () => {
    expect(await checklist(plainUi(), input())).toEqual({ kind: "declined" });
  });

  it("end of input declines", async () => {
    term = fakeTerminal();
    const pending = checklist(plainUi(), input());
    await tick();
    term.end();
    expect(await pending).toEqual({ kind: "declined" });
  });
});

describe("parseLeaveOut", () => {
  it("reads numbers, ranges and commas, and refuses anything else", () => {
    expect([...(parseLeaveOut("2, 5 7-8", 9) ?? [])]).toEqual([2, 5, 7, 8]);
    expect(parseLeaveOut("0", 9)).toBeNull();
    expect(parseLeaveOut("10", 9)).toBeNull();
    expect(parseLeaveOut("4-2", 9)).toBeNull();
    expect(parseLeaveOut("a", 9)).toBeNull();
    expect(parseLeaveOut("", 9)?.size).toBe(0);
  });
});
