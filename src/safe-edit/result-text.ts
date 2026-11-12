import { safeForDisplay } from "../output.js";
import type { StepResult } from "./plan.js";

const LABEL_LIMIT = 200;

/** A step's label as printed. */
export function labelText(label: string): string {
  return safeForDisplay(label, LABEL_LIMIT);
}

/**
 * The status wording of one result, shared by the plain summary and the timeline so a script or an email that
 * quotes it reads the same either way: `configured`, `already configured`, `skipped (<detail>; rerun with <flag>)`,
 * `failed: <detail>`.
 */
export function statusText(r: StepResult): string {
  const detail = r.detail === undefined ? undefined : safeForDisplay(r.detail, LABEL_LIMIT);
  const flag = r.flag === undefined ? undefined : safeForDisplay(r.flag, LABEL_LIMIT);
  if (r.status === "skipped") {
    const why = [detail, flag === undefined ? undefined : `rerun with ${flag}`].filter((p) => p !== undefined);
    return why.length === 0 ? "skipped" : `skipped (${why.join("; ")})`;
  }
  if (r.status === "failed") return detail === undefined ? "failed" : `failed: ${detail}`;
  return r.status;
}
