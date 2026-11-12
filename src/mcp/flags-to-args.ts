import type { ParsedArgs } from "../cli/args.js";
import { UsageError } from "../errors.js";
import type { ToolSpec } from "./tool-specs.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tool's argument object: `--json` (the whole object) as the base, then every flag that was
 * given overrides its key. A flag that was not given adds nothing (booleans and arrays included).
 * `agent_id` is not here: the command fills it (spec §4).
 */
export function flagsToArgs(spec: ToolSpec, parsed: ParsedArgs): Record<string, unknown> {
  const base = parsed.flags["json"];
  if (base !== undefined && !isPlainObject(base)) throw new UsageError("--json must be a JSON object, like {\"title\":\"…\"}.");
  const args: Record<string, unknown> = base === undefined ? {} : { ...base };
  for (const flag of spec.flags) {
    if (Object.hasOwn(parsed.flags, flag.name)) args[flag.arg] = parsed.flags[flag.name];
  }
  return args;
}
