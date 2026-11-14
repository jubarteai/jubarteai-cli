// Guards for a watcher that outlives one command: is this an interactive session (an unattended run must
// not keep a watcher alive), and is the process that started it still there.
import { INBOX_PARENT_CHECK_MS, INBOX_SESSION_MAX_MS } from "../constants.js";

/** A session watch stops for good after this long (spec §3.4). */
export const SESSION_MAX_MS = INBOX_SESSION_MAX_MS;

/** The opt-out an automated runner sets for a session the harness reports as interactive (see `unattendedReason`). */
export const UNATTENDED_ENV = "JUBARTEAI_UNATTENDED";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Why this process is an unattended run, or null when it looks interactive. Three signals, any of which counts:
 * `JUBARTEAI_UNATTENDED` set to a true value (`1`, `true`, `yes`, `on`: the explicit opt-out for an automated
 * runner, such as a pipeline or CI step, that drives a full `claude` session and so looks interactive to the
 * other two); Claude Code's `CLAUDE_CODE_ENTRYPOINT` (`cli` for an interactive session; anything else, e.g.
 * `sdk-cli`, is a programmatic run); and `CLAUDE_CODE_SESSION_ATTENDED` (`0` when nobody is at the keyboard).
 * The last two are undocumented, so this fails open: with none present, or with unrecognised values, the run
 * counts as interactive. The opt-out is the only way to tell an automated run that reports itself as an
 * interactive session; the skill's "interactive sessions only" rule covers the rest.
 */
export function unattendedReason(env: NodeJS.ProcessEnv = process.env): "unattended" | null {
  if (TRUTHY.has((env[UNATTENDED_ENV] ?? "").trim().toLowerCase())) return "unattended";
  const entrypoint = env["CLAUDE_CODE_ENTRYPOINT"];
  if (entrypoint !== undefined && entrypoint !== "" && entrypoint !== "cli") return "unattended";
  if (env["CLAUDE_CODE_SESSION_ATTENDED"] === "0") return "unattended";
  return null;
}

export type ParentWatchDeps = {
  /** Whether a process with this id exists (signal 0). */
  isAlive: (pid: number) => boolean;
  /** This process's current parent id. */
  ppid: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  checkEveryMs: number;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but isn't ours to signal.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export const DEFAULT_PARENT_WATCH_DEPS: ParentWatchDeps = {
  isAlive: processExists,
  ppid: () => process.ppid,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  checkEveryMs: INBOX_PARENT_CHECK_MS,
};

/** `CLAUDE_PID` as a positive integer, or null (unset, empty, 0, negative, not a whole number). */
function harnessPid(env: NodeJS.ProcessEnv): number | null {
  const raw = env["CLAUDE_PID"];
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw.trim())) return null;
  const pid = Number(raw.trim());
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * Aborts `signal` once the session this watcher belongs to is gone: the harness process named by
 * `CLAUDE_PID` no longer exists, or, whatever that says, this process was re-parented (its `ppid`
 * changed since it started: the process that launched it died). A crashed session therefore can't leave a
 * watcher keeping a dead agent alive. Checked every `checkEveryMs`; `stop()` ends the checks.
 */
export function watchParent(
  env: NodeJS.ProcessEnv = process.env,
  deps: ParentWatchDeps = DEFAULT_PARENT_WATCH_DEPS,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const startPpid = deps.ppid();
  const pid = harnessPid(env);
  const handle = deps.setInterval(() => {
    if (controller.signal.aborted) return;
    if (deps.ppid() !== startPpid || (pid !== null && !deps.isAlive(pid))) controller.abort();
  }, deps.checkEveryMs);
  // A timer must never keep a finished command alive.
  if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return { signal: controller.signal, stop: () => deps.clearInterval(handle) };
}
