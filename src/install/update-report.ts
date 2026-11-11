// The lines `jubarteai update` prints and the exit code it ends with. Ported from update.sh's plain-mode output
// (src/lib/update-script/index.ts in the app: record_check, plan_line, plan_info, the closing line and print_tips)
// and its exit codes (update-sh grill D29): 0 nothing failed (advisories may be printed), 1 a step failed, 2 `--check`
// found something to change. Pure: nothing here reads a file, runs a command or knows about a key; every string that
// came from a step or a file goes through safeForDisplay.
import { safeForDisplay } from "../output.js";
import type { StepResult } from "../safe-edit/plan.js";
import { summarize } from "../safe-edit/plan.js";
import type { ManualInstructions } from "../harness/types.js";

const NAME_LIMIT = 200;
const TEXT_LIMIT = 600;

/** A row before the plan runs: `[ok]` a check that is fine, `[warn]` an advisory, `[info]` not a change, `[todo]` a change. */
export type ReportRow = { level: "ok" | "warn" | "info" | "todo"; name: string; text: string };

/** What the registry lookup decided for the CLI itself. */
export type CliVersionState =
  | { kind: "current"; current: string; latest: string }
  | { kind: "newer"; current: string; latest: string }
  | { kind: "unknown"; current: string }
  | { kind: "skipped"; current: string };

/** The fixed sentences `update` prints. */
export const UPDATE_COPY = {
  title: "JubarteAI update",
  nothingInstalled: "Nothing to update — JubarteAI is not set up here yet.",
  setUp: "To set it up, run: jubarteai init",
  upToDate: "Everything is up to date",
  checkNothing: "Nothing to update",
  byHand: "Do these by hand:",
  restart: "Restart your editor or agent so it picks up the changes.",
  notGitRepo: "not inside a git repository — using this folder as the project root",
  mcpNotSignedIn:
    "this machine has no jubarteai login, so the MCP entries stay (your agents still use them); run jubarteai init to switch to the CLI, then jubarteai update offers the cleanup",
  mcpKept: "kept (--keep-mcp)",
  cliInstallDeclined: "kept the installed CLI",
  cliReexecMissing: "installed, but the updated jubarteai isn't where npm should have put it; open a new terminal and run: jubarteai update",
  cliNotGlobal: "installed outside npm's global folder (npx, a project's node_modules or a checkout), so it isn't updated here; update it the way you installed it",
  cliReexecFailed: "installed, but the new jubarteai couldn't be started; run: jubarteai update",
} as const;

function row(level: ReportRow["level"], name: string, text: string): ReportRow {
  return { level, name, text };
}

/** One row, update.sh's plain markers: `  [todo] name: text`. */
export function formatRow(r: ReportRow): string {
  const marker = r.level === "todo" ? "[todo]" : r.level === "warn" ? "[warn]" : r.level === "info" ? "[info]" : "[ok]  ";
  return `  ${marker} ${safeForDisplay(r.name, NAME_LIMIT)}: ${safeForDisplay(r.text, TEXT_LIMIT)}`;
}

/** The CLI version row. A newer version is a change (`--check` exits 2 on it); an unknown one is an advisory. */
export function cliVersionRow(state: CliVersionState): ReportRow {
  switch (state.kind) {
    case "current":
      return row("ok", "CLI", `${state.current}, up to date`);
    case "newer":
      return row("todo", "CLI", `a newer CLI is available: ${state.current} -> ${state.latest} (npm install -g jubarteai@${state.latest})`);
    case "unknown":
      return row("warn", "CLI", `${state.current}; couldn't check for a newer version (offline or the npm registry is unreachable)`);
    case "skipped":
      return row("info", "CLI", `${state.current} (self-update skipped)`);
  }
}

/** The fixed lines after a failed `npm install -g`. `eacces`: npm couldn't write to its global folder. */
export function cliInstallFailedLines(version: string, opts: { eacces: boolean; timedOut: boolean; platform: NodeJS.Platform }): string[] {
  const command = `npm install -g jubarteai@${version}`;
  if (opts.timedOut) return [`  npm install timed out. Run it yourself: ${command}`];
  if (opts.eacces && opts.platform !== "win32") {
    return [
      "  npm couldn't write to its global folder (permission denied). Install into your home folder instead:",
      `    npm install -g --prefix "$HOME/.local" jubarteai@${version}`,
      "  then add this line to your shell profile (this command never edits it):",
      '    export PATH="$HOME/.local/bin:$PATH"',
    ];
  }
  return [`  npm install failed. Run it yourself: ${command}`];
}

/** A step result as a row: what an info step found (not a change). */
export function infoRow(result: StepResult): ReportRow {
  const level = result.status === "configured" || result.status === "already configured" ? "ok" : "warn";
  return row(level, result.label, result.detail ?? result.status);
}

/** The `[todo]` row of a change `--check` would make. */
export function todoRow(label: string): ReportRow {
  return row("todo", label, "would change");
}

/** "Do these by hand:" with each instruction's title and lines; empty when there are none. */
export function byHandLines(manuals: ManualInstructions[]): string[] {
  if (manuals.length === 0) return [];
  const out: string[] = [UPDATE_COPY.byHand];
  for (const m of manuals) {
    out.push(`  - ${safeForDisplay(m.title, NAME_LIMIT)}`);
    for (const line of m.lines) out.push(`      ${safeForDisplay(line, TEXT_LIMIT)}`);
  }
  return out;
}

/**
 * The plan's results, one line each, indented: summarize's wording, plus what a step that ran says it did (an updated
 * skill's version and restart note, the plugin's /reload-plugins note, D20).
 */
export function resultLines(results: StepResult[]): string[] {
  const lines = summarize(results);
  return results.map((r, i) => {
    const line = lines[i] ?? "";
    const done = r.status === "configured" || r.status === "already configured";
    return done && r.detail !== undefined && r.detail !== "" ? `  ${line} — ${safeForDisplay(r.detail, TEXT_LIMIT)}` : `  ${line}`;
  });
}

export type Counts = { ok: number; skipped: number; failed: number; warnings: number };

/** Counts as update.sh's closing line: ok = configured or already configured. `extraFailed` adds failures outside the plan (the CLI install). */
export function countResults(results: StepResult[], warnings: number, extraFailed = 0): Counts {
  let ok = 0;
  let skipped = 0;
  let failed = extraFailed;
  for (const r of results) {
    if (r.status === "failed") failed += 1;
    else if (r.status === "skipped") skipped += 1;
    else ok += 1;
  }
  return { ok, skipped, failed, warnings };
}

/** The closing lines of an applying run: the counts, the failed note, the restart tip when anything changed. */
export function closingLines(counts: Counts, opts: { changed: boolean }): string[] {
  const out = [`Done — ${counts.ok} ok, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.warnings} warning(s)`];
  if (counts.failed > 0) out.push(`   ${counts.failed} step(s) failed — see above.`);
  if (opts.changed) out.push(`   ${UPDATE_COPY.restart}`);
  return out;
}

/** The closing lines of a `--check` run. */
export function checkClosingLines(pending: number, warnings: number): string[] {
  const out = [pending > 0 ? `${pending} change(s) pending — run without --check to apply` : UPDATE_COPY.checkNothing];
  if (warnings > 0) out.push(`   ${warnings} warning(s) above.`);
  return out;
}

/** The lines when nothing is installed here (update-sh D30): point at init, exit 0. */
export function nothingInstalledLines(): string[] {
  return [UPDATE_COPY.nothingInstalled, `   ${UPDATE_COPY.setUp}`];
}

/** D29: `--check` → 2 when something would change, else 0; otherwise 1 when a step failed, else 0. */
export function updateExitCode(opts: { check: boolean; pending: number; failed: number }): 0 | 1 | 2 {
  if (opts.check) return opts.pending > 0 ? 2 : 0;
  return opts.failed > 0 ? 1 : 0;
}
