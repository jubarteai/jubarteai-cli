// What the session hooks do about company skills: flush the one-time lines a background sync left (a notice
// that skills changed, a clash with a folder that isn't ours) and, when the server's `skills_revision` differs
// from what this repo last synced, start a detached `jubarteai skills sync --background`. The hook never waits
// for the sync: it spawns and returns, so it stays inside its budget and a slow network can't delay a prompt.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { SKILLS_LOCK_STALE_MS } from "../constants.js";
import { gitTop } from "../git/layout.js";
import { childEnv } from "../process-env.js";
import { clashNotice } from "./notice.js";
import { lockPath, readState, shouldSync, writeState } from "./state.js";

export type HookSkillsInput = {
  cwd: string;
  /** The repo binding's root and (for a linked worktree) the worktree top. */
  bindingRoot: string;
  seat: { origin: string; seatId: string | null; token: string };
  /** null on a resume/compact: flush pending lines only, never start a sync. */
  agentId: string | null;
  /** `skills_revision` from connect / check_inbox; undefined = the server didn't say (do nothing). */
  revision: number | undefined;
};

export type HookSkillsDeps = {
  now: () => number;
  /** Starts the detached sync. Tests replace it. */
  spawnSync: (top: string, agentId: string, revision: number) => void;
};

const LINE_MAX = 400;
const LINES_MAX = 6;

export function defaultSpawnSync(top: string, agentId: string, revision: number): void {
  const entry = process.argv[1];
  if (entry === undefined) return;
  const child = spawn(process.execPath, [entry, "skills", "sync", "--background", "--agent", agentId, "--if-changed", String(revision)], {
    cwd: top,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: childEnv(),
  });
  child.on("error", () => undefined);
  child.unref();
}

function lockFresh(top: string, now: number): boolean {
  try {
    return now - statSync(lockPath(top)).mtimeMs < SKILLS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** The lines to add to the hook's injection (possibly none). Never throws and never makes a network call. */
export function skillsHookLines(input: HookSkillsInput, deps: Partial<HookSkillsDeps> = {}): string[] {
  const d: HookSkillsDeps = { now: Date.now, spawnSync: defaultSpawnSync, ...deps };
  try {
    const top = gitTop(input.cwd) ?? input.bindingRoot;
    const state = readState(top, input.seat.origin);
    const lines = state.pending_notice.map((l) => l.slice(0, LINE_MAX));
    let dirty = state.pending_notice.length > 0;
    for (const [name, clash] of Object.entries(state.clashes)) {
      if (!clash.reported && clash.dir !== undefined) {
        lines.push(clashNotice(name, clash.dir).slice(0, LINE_MAX));
        clash.reported = true;
        dirty = true;
      }
    }
    if (dirty) writeState(top, { ...state, pending_notice: [], clashes: state.clashes });

    // An environment key can't be handed to a detached child (it is scrubbed from child environments), so only
    // saved logins start a background sync.
    if (
      input.agentId !== null &&
      input.seat.seatId !== null &&
      shouldSync(state, input.revision, d.now()) &&
      input.revision !== undefined &&
      !lockFresh(top, d.now())
    ) {
      d.spawnSync(top, input.agentId, input.revision);
    }
    return lines.slice(0, LINES_MAX);
  } catch {
    return [];
  }
}
