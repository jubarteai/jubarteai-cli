// The lines and the exit code of `jubarteai update`, in update.sh's plain-mode wording (D29 for the codes).
import { describe, expect, it } from "vitest";
import type { StepResult } from "../safe-edit/plan.js";
import {
  UPDATE_COPY,
  byHandLines,
  checkClosingLines,
  cliInstallFailedLines,
  cliVersionRow,
  closingLines,
  countResults,
  formatRow,
  infoRow,
  nothingInstalledLines,
  resultLines,
  todoRow,
  updateExitCode,
} from "./update-report.js";

const result = (status: StepResult["status"], detail?: string): StepResult =>
  detail === undefined ? { id: status, label: `Step ${status}`, status } : { id: status, label: `Step ${status}`, status, detail };

describe("rows", () => {
  it("uses update.sh's plain markers", () => {
    expect(formatRow({ level: "todo", name: "AGENTS.md section", text: "would change" })).toBe("  [todo] AGENTS.md section: would change");
    expect(formatRow({ level: "ok", name: "CLI", text: "1.0.0, up to date" })).toBe("  [ok]   CLI: 1.0.0, up to date");
    expect(formatRow({ level: "warn", name: "x", text: "y" })).toBe("  [warn] x: y");
    expect(formatRow({ level: "info", name: "x", text: "y" })).toBe("  [info] x: y");
  });

  it("neutralises control characters and redacts anything key-shaped in a row", () => {
    const line = formatRow({ level: "warn", name: "a\u001b[31mb", text: "key jba_FAKEFAKEFAKE here\nnext" });
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("jba_FAKE");
    expect(line).not.toContain("\n");
  });

  it("describes the CLI version states; a newer one is a change, an unknown one an advisory", () => {
    expect(cliVersionRow({ kind: "current", current: "1.0.0", latest: "1.0.0" })).toEqual({ level: "ok", name: "CLI", text: "1.0.0, up to date" });
    const newer = cliVersionRow({ kind: "newer", current: "1.0.0", latest: "1.1.0" });
    expect(newer.level).toBe("todo");
    expect(newer.text).toContain("a newer CLI is available: 1.0.0 -> 1.1.0");
    expect(newer.text).toContain("npm install -g jubarteai@1.1.0");
    expect(cliVersionRow({ kind: "unknown", current: "1.0.0" }).level).toBe("warn");
    expect(cliVersionRow({ kind: "skipped", current: "1.0.0" })).toEqual({ level: "info", name: "CLI", text: "1.0.0 (self-update skipped)" });
  });

  it("an info step's result is ok when settled and a warning otherwise", () => {
    expect(infoRow(result("already configured", "already current (1.7.1, user)"))).toEqual({
      level: "ok",
      name: "Step already configured",
      text: "already current (1.7.1, user)",
    });
    expect(infoRow(result("skipped", "tip")).level).toBe("warn");
    expect(infoRow(result("skipped")).text).toBe("skipped");
    expect(todoRow("Update skill (project, npx copy)")).toEqual({ level: "todo", name: "Update skill (project, npx copy)", text: "would change" });
  });
});

describe("npm install failures", () => {
  it("on a permission error prints the --prefix \"$HOME/.local\" command and the PATH line, never editing a profile", () => {
    const lines = cliInstallFailedLines("1.2.0", { eacces: true, timedOut: false, platform: "darwin" }).join("\n");
    expect(lines).toContain('npm install -g --prefix "$HOME/.local" jubarteai@1.2.0');
    expect(lines).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(lines).toContain("never edits it");
  });

  it("on Windows, a timeout or any other failure prints the plain command to run", () => {
    expect(cliInstallFailedLines("1.2.0", { eacces: true, timedOut: false, platform: "win32" })).toEqual([
      "  npm install failed. Run it yourself: npm install -g jubarteai@1.2.0",
    ]);
    expect(cliInstallFailedLines("1.2.0", { eacces: false, timedOut: true, platform: "linux" })[0]).toContain("timed out");
    expect(cliInstallFailedLines("1.2.0", { eacces: false, timedOut: false, platform: "linux" })[0]).toContain("npm install failed");
  });
});

describe("closing", () => {
  it("counts ok, skipped and failed like update.sh's closing line, plus failures outside the plan", () => {
    const counts = countResults([result("configured"), result("already configured"), result("skipped"), result("failed", "x")], 2, 1);
    expect(counts).toEqual({ ok: 2, skipped: 1, failed: 2, warnings: 2 });
    expect(closingLines(counts, { changed: true })).toEqual([
      "Done — 2 ok, 1 skipped, 2 failed, 2 warning(s)",
      "   2 step(s) failed — see above.",
      `   ${UPDATE_COPY.restart}`,
    ]);
    expect(closingLines({ ok: 0, skipped: 0, failed: 0, warnings: 0 }, { changed: false })).toEqual(["Done — 0 ok, 0 skipped, 0 failed, 0 warning(s)"]);
  });

  it("closes a --check run with the pending count or 'Nothing to update'", () => {
    expect(checkClosingLines(3, 1)).toEqual(["3 change(s) pending — run without --check to apply", "   1 warning(s) above."]);
    expect(checkClosingLines(0, 0)).toEqual(["Nothing to update"]);
  });

  it("prints the plan's results with summarize's wording", () => {
    expect(resultLines([result("skipped", "needs confirmation")])).toEqual(["  Step skipped: skipped (needs confirmation)"]);
    expect(resultLines([result("failed", "npx error")])).toEqual(["  Step failed: failed: npx error"]);
    expect(resultLines([result("configured", "updated 1.7.0 -> 1.7.1 (user); restart Claude Code or run /reload-plugins to load it")])).toEqual([
      "  Step configured: configured — updated 1.7.0 -> 1.7.1 (user); restart Claude Code or run /reload-plugins to load it",
    ]);
    expect(resultLines([result("already configured")])).toEqual(["  Step already configured: already configured"]);
  });

  it("points at jubarteai init when nothing is installed (D30)", () => {
    expect(nothingInstalledLines()).toEqual([UPDATE_COPY.nothingInstalled, "   To set it up, run: jubarteai init"]);
  });

  it("lists instructions to do by hand under one heading, and nothing when there are none", () => {
    expect(byHandLines([])).toEqual([]);
    expect(
      byHandLines([{ kind: "manual", harness: "codex", title: "Codex network access", lines: ["Upgrade Codex.", "jba_FAKEFAKEFAKE"], reason: "old" }]),
    ).toEqual([UPDATE_COPY.byHand, "  - Codex network access", "      Upgrade Codex.", "      [redacted]"]);
  });
});

describe("exit codes (D29)", () => {
  it.each([
    [{ check: true, pending: 2, failed: 0 }, 2],
    [{ check: true, pending: 0, failed: 0 }, 0],
    [{ check: true, pending: 0, failed: 1 }, 0],
    [{ check: false, pending: 0, failed: 1 }, 1],
    [{ check: false, pending: 5, failed: 0 }, 0],
  ] as const)("%j → %i", (input, code) => {
    expect(updateExitCode(input)).toBe(code);
  });
});
