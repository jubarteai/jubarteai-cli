// Reads what a harness sends a hook on stdin (spec §6.3): which harness it really is, its session id,
// the `source` of a session start and the working directory. Never throws: malformed input yields a
// HookInput with nulls, which the event handlers treat as "nothing to do".
import { isAbsolute } from "node:path";

import { HARNESS_IDS, sessionFromEnv } from "../session/harness-env.js";
import type { HarnessId } from "../session/harness-env.js";
import type { HookEvent } from "./events.js";
import { parseBackgroundTasks } from "./stop-watch.js";
import type { BackgroundTask } from "./stop-watch.js";

export type HookInput = {
  harness: HarnessId | null;
  /** The `--harness` value the hook was registered with; `harness` differs from it when detection won. */
  hint: HarnessId | null;
  event: HookEvent;
  sessionId: string | null;
  source: string | null;
  cwd: string;
  /** Claude Code's Stop payload: true when this Stop is a re-entry after a hook already blocked one. */
  stopHookActive: boolean;
  /** Claude Code's Stop payload: the session's background tasks (bounded; empty when the payload has none). */
  backgroundTasks: BackgroundTask[];
};

const MAX_SESSION_ID_CHARS = 256;
const MAX_CWD_CHARS = 4096;
const SOURCE_RE = /^[A-Za-z][A-Za-z_-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnsafeChar(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A `--harness` value that names a known harness, else null. */
export function harnessFromHint(value: unknown): HarnessId | null {
  return typeof value === "string" ? (HARNESS_IDS.find((id) => id === value) ?? null) : null;
}

/**
 * The harness this hook really runs in. The `--harness` hint is what `init` registered, but Cursor and
 * Devin import Claude Code's hooks (P2), so the stdin shape and the environment come first: Cursor sends
 * `cursor_version` and `conversation_id`; Devin (the Windsurf product) sets `DEVIN_PROJECT_DIR`.
 */
function detectHarness(doc: Record<string, unknown> | null, hint: HarnessId | null, env: NodeJS.ProcessEnv): HarnessId | null {
  if (doc !== null && typeof doc["cursor_version"] === "string" && typeof doc["conversation_id"] === "string") return "cursor";
  const devin = env["DEVIN_PROJECT_DIR"];
  if (typeof devin === "string" && devin !== "") return "windsurf";
  return hint ?? sessionFromEnv(env)?.harness ?? null;
}

function sessionIdFrom(doc: Record<string, unknown> | null): string | null {
  if (doc === null) return null;
  for (const key of ["session_id", "sessionId", "conversation_id"]) {
    const value = doc[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "" && trimmed.length <= MAX_SESSION_ID_CHARS && !hasUnsafeChar(trimmed)) return trimmed;
  }
  return null;
}

function usableCwd(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_CHARS) return null;
  if (!isAbsolute(value) || hasUnsafeChar(value)) return null;
  return value;
}

function cwdFrom(doc: Record<string, unknown> | null): string | null {
  if (doc === null) return null;
  const direct = usableCwd(doc["cwd"]);
  if (direct !== null) return direct;
  const roots = doc["workspace_roots"];
  return Array.isArray(roots) ? usableCwd(roots[0]) : null;
}

/**
 * Parses one hook invocation. The session id comes from stdin (`session_id`, `sessionId`, or Cursor's
 * `conversation_id`); only when stdin has none does the environment's session variable stand in, and
 * only for the same harness. `fallbackCwd` is used when stdin names no usable directory.
 */
export function parseHookInput(
  raw: string,
  hint: HarnessId | null,
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  fallbackCwd: string = process.cwd(),
): HookInput {
  const doc = parseObject(raw);
  const harness = detectHarness(doc, hint, env);
  let sessionId = sessionIdFrom(doc);
  if (sessionId === null) {
    const fromEnv = sessionFromEnv(env);
    if (fromEnv !== null && (harness === null || fromEnv.harness === harness)) sessionId = fromEnv.sessionId;
  }
  const source = doc !== null && typeof doc["source"] === "string" && SOURCE_RE.test(doc["source"]) ? doc["source"] : null;
  return {
    harness,
    hint,
    event,
    sessionId,
    source,
    cwd: cwdFrom(doc) ?? fallbackCwd,
    stopHookActive: doc !== null && doc["stop_hook_active"] === true,
    backgroundTasks: doc === null ? [] : parseBackgroundTasks(doc["background_tasks"]),
  };
}
