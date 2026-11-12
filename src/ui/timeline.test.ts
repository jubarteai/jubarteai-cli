import { describe, expect, it } from "vitest";

import { fakeStream } from "../../test/helpers/ui-streams.js";
import type { StepResult } from "../safe-edit/plan.js";
import { stripAnsi } from "./display.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };

function rich(columns = 100) {
  const out = fakeStream({ tty: true, columns, depth: 24 });
  return { out, ui: createUi(out, { env: UTF8 }) };
}
function plain() {
  const out = fakeStream();
  return { out, ui: createUi(out, { plain: true, env: UTF8 }) };
}

const hooks: StepResult = { id: "claude-code:hooks", label: "Add the JubarteAI session hooks to ~/.claude/settings.json", status: "configured" };
const failed: StepResult = { id: "cursor:hooks", label: "Add the JubarteAI session hooks to ~/.cursor/hooks.json", status: "failed", detail: "could not write (symlink)" };
const skipped: StepResult = { id: "x", label: "Allow the rule", status: "skipped", detail: "needs confirmation", flag: "--yes" };

describe("timeline: rich", () => {
  it("renders the title, headers, results and the tally in the clack-style timeline", () => {
    const { out, ui } = rich(140);
    const t = ui.timeline();
    t.open("JubarteAI installer");
    t.header("Project", "jubarteai  ~/Projects/aea/jubarteai");
    t.header("Node", "v24.22.3");
    t.result(hooks, "Claude Code");
    t.result(failed, "Cursor");
    t.close({ ok: 9, skipped: 1, failed: 1 }, 14_200);
    expect(stripAnsi(out.text())).toBe(
      [
        "┌  JubarteAI installer",
        "│",
        "◇  Project   jubarteai  ~/Projects/aea/jubarteai",
        "◇  Node      v24.22.3",
        "◇  Claude Code  configured · Add the JubarteAI session hooks to ~/.claude/settings.json",
        "▲  Cursor       failed: could not write (symlink) · Add the JubarteAI session hooks to ~/.cursor/hooks.json",
        "│",
        "└  Done in 14s — 9 ok · 1 skipped · 1 failed",
        "",
      ].join("\n"),
    );
    expect(out.text()).toContain("\u001b[");
  });

  it("keeps statuses literal and shows a failed step's log tail dimmed", () => {
    const { out, ui } = rich();
    const t = ui.timeline();
    t.result({ ...failed, log: ["npm ERR! first", "npm ERR! second"] }, "Cursor");
    t.result(skipped, "Claude Code");
    const text = stripAnsi(out.text());
    expect(text).toContain("failed: could not write (symlink)");
    expect(text).toContain("│    npm ERR! first");
    expect(text).toContain("skipped (needs confirmation; rerun with --yes)");
  });

  it("truncates the label, never the status, to the terminal width", () => {
    const { out, ui } = rich(60);
    ui.timeline().result(hooks, "Claude Code");
    const line = stripAnsi(out.text()).trimEnd();
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain("configured");
    expect(line).toContain("…");
  });

  it("abort closes the timeline", () => {
    const { out, ui } = rich();
    ui.timeline().abort("Aborted.");
    expect(stripAnsi(out.text())).toBe("│\n└  Aborted.\n");
  });

  it("sanitises everything it prints", () => {
    const { out, ui } = rich();
    ui.timeline().row("ok", "Gr\u001b[31moup", "text jba_SECRETSECRETSECRET1", "de\u0007tail");
    const text = stripAnsi(out.text());
    expect(text).toContain("Gr?[31moup");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("\u0007");
  });
});

describe("timeline: plain", () => {
  it("renders the same run as marker lines with no escape codes", () => {
    const { out, ui } = plain();
    const t = ui.timeline();
    t.open("JubarteAI installer");
    t.header("Project", "jubarteai (~/Projects/aea/jubarteai)");
    t.result(hooks, "Claude Code");
    t.result(failed, "Cursor");
    t.result(skipped, "Claude Code");
    t.note(["Restart your editor."]);
    t.close({ ok: 9, skipped: 1, failed: 1 }, 14_200);
    expect(out.text()).toBe(
      [
        "JubarteAI installer",
        "  Project: jubarteai (~/Projects/aea/jubarteai)",
        "[ok]   Claude Code · Add the JubarteAI session hooks to ~/.claude/settings.json: configured",
        "[FAIL] Cursor · Add the JubarteAI session hooks to ~/.cursor/hooks.json: failed: could not write (symlink)",
        "[skip] Claude Code · Allow the rule: skipped (needs confirmation; rerun with --yes)",
        "Restart your editor.",
        "Done in 14s — 9 ok, 1 skipped, 1 failed",
        "",
      ].join("\n"),
    );
    expect(out.text()).not.toContain("\u001b");
  });

  it("counts warnings and prints <1s for a quick run", () => {
    const { out, ui } = plain();
    ui.timeline().close({ ok: 2, skipped: 0, failed: 0, warnings: 1 }, 200);
    expect(out.text()).toBe("Done in <1s — 2 ok, 1 warning\n");
  });

  it("abort is a plain line", () => {
    const { out, ui } = plain();
    ui.timeline().abort("Aborted.");
    expect(out.text()).toBe("Aborted.\n");
  });
});
