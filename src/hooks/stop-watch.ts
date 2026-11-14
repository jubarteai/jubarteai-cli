// The Stop hook (Claude Code only): when an agent ends its turn with no inbox watcher running, ask it once to arm one, so a
// peer's message can wake the idle session. Claude Code lists the session's running background tasks in the Stop payload and
// treats `{"decision":"block","reason":…}` as "don't stop yet: do this first". The agent then runs the session-mode watcher
// as a background command; its exit (a message, or the end of the session) wakes the idle session. The hook itself never
// waits and never touches the network.
import { isAgentId } from "../session/cache.js";

/** A running background task, as far as the hook reads it: Claude Code's `background_tasks` entries. */
export type BackgroundTask = { type: string | null; status: string | null; command: string };

const MAX_TASKS = 50;
const MAX_COMMAND_CHARS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload's `background_tasks`, bounded and reduced to what the hook reads. Anything else is dropped. */
export function parseBackgroundTasks(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: BackgroundTask[] = [];
  for (const item of value.slice(0, MAX_TASKS)) {
    if (!isRecord(item) || typeof item["command"] !== "string" || item["command"].length > MAX_COMMAND_CHARS) continue;
    tasks.push({
      type: typeof item["type"] === "string" ? item["type"] : null,
      status: typeof item["status"] === "string" ? item["status"] : null,
      command: item["command"],
    });
  }
  return tasks;
}

const WATCH_COMMAND = /\bjubarteai(?:\.(?:cmd|exe))?\b[^|;&\n]*\binbox\b[^|;&\n]*\s--watch\b/;
const AGENT_FLAG = /\s--agent[\s=]+([^\s'"]+)/;

/**
 * Whether a background task is a `jubarteai inbox --watch` for this agent: running (or of unknown status), the command names
 * `inbox` and `--watch`, and any `--agent` it carries is this agent's.
 */
export function isWatcherTask(task: BackgroundTask, agentId: string): boolean {
  if (task.status !== null && task.status !== "running") return false;
  if (!WATCH_COMMAND.test(task.command)) return false;
  const named = AGENT_FLAG.exec(task.command)?.[1];
  return named === undefined || named.toLowerCase() === agentId.toLowerCase();
}

export function hasRunningWatcher(tasks: readonly BackgroundTask[], agentId: string): boolean {
  return tasks.some((task) => isWatcherTask(task, agentId));
}

/**
 * The stdout of a Stop hook that blocks the stop once. Claude Code shows `reason` to the model as the reason it may not stop
 * yet; it names the agent (a validated id) and the exact command, nothing taken from the repository or a peer.
 */
export function stopReminderOutput(agentId: string): string {
  if (!isAgentId(agentId)) return "";
  const reason = [
    "Your JubarteAI inbox is not being watched, so a peer's message would not reach you while you wait.",
    `Before you end your turn, run \`jubarteai inbox --agent ${agentId} --watch --session\` as a background command (Bash with run_in_background: true), then end your turn without commenting on this reminder.`,
  ].join(" ");
  return `${JSON.stringify({ decision: "block", reason })}\n`;
}
