import { safeForDisplay } from "../output.js";
import { labelText, statusText } from "../safe-edit/result-text.js";
import type { StepResult } from "../safe-edit/plan.js";
import { truncate, visibleWidth } from "./display.js";
import type { Ui } from "./index.js";

export type RowKind = "ok" | "skip" | "fail" | "warn" | "info" | "todo";

export interface Timeline {
  open(title: string): void;
  header(name: string, value: string, opts?: { warn?: boolean }): void;
  row(kind: RowKind, group: string, text: string, detail?: string): void;
  result(r: StepResult, group: string): void;
  note(lines: string[]): void;
  run<T>(label: string, work: () => Promise<T>): Promise<T>;
  close(counts: { ok: number; skipped: number; failed: number; warnings?: number }, elapsedMs: number): void;
  abort(text: string): void;
}

const HEADER_WIDTH = 10;
const GROUP_WIDTH = 13;
const PLAIN_TAG: Readonly<Record<RowKind, string>> = {
  ok: "[ok]",
  skip: "[skip]",
  fail: "[FAIL]",
  warn: "[warn]",
  info: "[info]",
  todo: "[todo]",
};
const TAG_WIDTH = 6;
/** Below this many columns for the detail, a row drops it rather than print a stub. */
const MIN_DETAIL = 12;

function elapsed(ms: number): string {
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}

/** The status of one result as a row kind: configured and already configured are both fine. */
function kindOf(r: StepResult): RowKind {
  if (r.status === "failed") return "fail";
  if (r.status === "skipped") return "skip";
  return "ok";
}

export function createTimeline(ui: Ui): Timeline {
  const { mode, glyphs: g } = ui;
  const rich = mode.rich;

  const glyphFor = (kind: RowKind): string => {
    switch (kind) {
      case "ok":
        return ui.paint("ok", g.done);
      case "skip":
        return ui.paint("dim", g.done);
      case "fail":
        return ui.paint("fail", g.fail);
      case "warn":
        return ui.paint("warn", g.warn);
      case "todo":
        return ui.paint("warn", g.active);
      case "info":
        return ui.paint("brand", g.done);
    }
  };

  /** `prefix + text`, with the detail after a " · " cut to what fits; the status text is never cut. */
  const fit = (prefix: string, text: string, detail: string | undefined): string => {
    if (detail === undefined || detail === "") return truncate(`${prefix}${text}`, mode.columns);
    const head = `${prefix}${text} · `;
    const room = mode.columns - visibleWidth(head);
    if (room < MIN_DETAIL) return truncate(`${prefix}${text}`, mode.columns);
    return `${head}${ui.paint("dim", truncate(detail, room))}`;
  };

  return {
    open(title) {
      const safe = safeForDisplay(title, 120);
      ui.line(rich ? `${ui.paint("brand", g.open)}  ${ui.paint("bold", safe)}` : safe);
      if (rich) ui.line(ui.paint("dim", g.bar));
    },

    header(name, value, opts) {
      const safeName = safeForDisplay(name, 40);
      const safeValue = safeForDisplay(value, 300);
      if (!rich) {
        ui.line(`  ${safeName}: ${safeValue}`);
        return;
      }
      const glyph = opts?.warn === true ? ui.paint("warn", g.warn) : ui.paint("ok", g.done);
      ui.line(truncate(`${glyph}  ${safeName.padEnd(Math.max(HEADER_WIDTH, safeName.length + 1))}${safeValue}`, mode.columns));
    },

    row(kind, group, text, detail) {
      const safeGroup = safeForDisplay(group, 60);
      const safeText = safeForDisplay(text, 300);
      const safeDetail = detail === undefined ? undefined : safeForDisplay(detail, 300);
      if (!rich) {
        const tag = PLAIN_TAG[kind].padEnd(TAG_WIDTH);
        const line =
          safeDetail === undefined || safeDetail === ""
            ? `${tag} ${safeGroup === "" ? "" : `${safeGroup}: `}${safeText}`
            : `${tag} ${safeGroup === "" ? safeDetail : `${safeGroup} · ${safeDetail}`}: ${safeText}`;
        ui.line(line);
        return;
      }
      const prefix = `${glyphFor(kind)}  ${safeGroup === "" ? "" : `${safeGroup.padEnd(GROUP_WIDTH)}`}`;
      const coloredText = kind === "fail" ? ui.paint("fail", safeText) : kind === "skip" ? ui.paint("dim", safeText) : safeText;
      ui.line(fit(prefix, coloredText, safeDetail));
    },

    result(r, group) {
      // A step that finished says what it did after the literal status ("configured — updated 1.2 -> 1.3; restart …").
      const done = r.status === "configured" || r.status === "already configured";
      const text = done && r.detail !== undefined && r.detail !== "" ? `${statusText(r)} — ${safeForDisplay(r.detail, 300)}` : statusText(r);
      this.row(kindOf(r), group, text, labelText(r.label));
      if (r.status === "failed" && r.log !== undefined) {
        for (const line of r.log) ui.line(rich ? ui.paint("dim", `${g.bar}    ${truncate(line, mode.columns - 6)}`) : `        ${line}`);
      }
    },

    note(lines) {
      for (const line of lines) {
        const safe = safeForDisplay(line, 400);
        ui.line(rich ? truncate(`${ui.paint("dim", g.bar)}  ${safe}`, mode.columns) : safe);
      }
    },

    run(label, work) {
      return ui.spin(label, work);
    },

    close(counts, elapsedMs) {
      const parts = [`${counts.ok} ok`];
      if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
      if (counts.failed > 0) parts.push(`${counts.failed} failed`);
      if (counts.warnings !== undefined && counts.warnings > 0) parts.push(`${counts.warnings} ${counts.warnings === 1 ? "warning" : "warnings"}`);
      const tally = `Done in ${elapsed(elapsedMs)} — ${parts.join(rich ? " · " : ", ")}`;
      if (rich) {
        ui.line(ui.paint("dim", g.bar));
        ui.line(`${ui.paint("brand", g.close)}  ${counts.failed > 0 ? ui.paint("fail", tally) : ui.paint("ok", tally)}`);
      } else {
        ui.line(tally);
      }
    },

    abort(text) {
      const safe = safeForDisplay(text, 120);
      if (rich) {
        ui.line(ui.paint("dim", g.bar));
        ui.line(`${ui.paint("brand", g.close)}  ${safe}`);
      } else ui.line(safe);
    },
  };
}
