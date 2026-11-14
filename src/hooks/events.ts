// What each hook event does (spec §6.3). Every path ends in a string to print ("" for nothing) and none
// throws for a server, network or file problem: a hook must never fail the harness (I7).
import { basename, isAbsolute, join } from "node:path";

import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { findBinding } from "../binding/binding.js";
import { gitTop, linkedWorktree, originSlug } from "../git/layout.js";
import type { Binding } from "../binding/binding.js";
import { isOurHookCommand, settingsPath as claudeSettingsPath } from "../harness/claude-code.js";
import { codexHome } from "../harness/mcp-cleanup.js";
import type { Envelope } from "../mcp/client.js";
import { callTool } from "../mcp/client.js";
import { entryBelongsToSeat, isAgentId, keyFingerprint, readSession, writeSession } from "../session/cache.js";
import type { SessionEntry } from "../session/cache.js";
import type { HarnessId } from "../session/harness-env.js";
import { overflowSpill } from "./overflow.js";
import { NOT_SIGNED_IN_LINE, UNREACHABLE_LINE, composeInjection, formatInjection, identityLine, injectionSupported } from "./inject.js";
import type { HookInput } from "./input.js";
import { homeDir } from "../paths.js";
import { readJsonObject } from "../safe-edit/json-edit.js";
import { unattendedReason } from "../inbox/guards.js";
import { isWatchLockHeld } from "../inbox/lock.js";
import { hasRunningWatcher, stopReminderOutput } from "./stop-watch.js";

export type HookEvent = "session-start" | "user-prompt-submit" | "session-end" | "stop";

export const HOOK_EVENTS: readonly HookEvent[] = ["session-start", "user-prompt-submit", "session-end", "stop"];

/**
 * Events a harness registers that `update` adds to an install that predates them (the three session events are `init`'s to
 * finish; a later release's new event arrives with `update`). `stop` is Claude Code's: it asks the agent to arm its inbox watcher.
 */
export const REFRESH_ADDS_EVENTS: readonly HookEvent[] = ["stop"];

/** `session-end` is best effort: harnesses give it about a second (spec §6.3). */
export const SESSION_END_NETWORK_TIMEOUT_MS = 1_000;

/** The `source` values on which a cached agent is reused instead of connecting a new one. */
const REUSE_SOURCES: readonly string[] = ["resume", "compact"];
/** 401 codes where "run jubarteai login" is the right hint; a billing or seat refusal is not fixed by logging in. */
const LOGIN_CODES: readonly string[] = ["invalid_api_key", "revoked_api_key", "unauthorized"];
const MAX_AGENT_NAME_CHARS = 200;
const MAX_SLUG_CHARS = 100;

/**
 * The hooks `init` registers in each harness's own hook file (spec §9 "Hooks"): the `--harness` value its commands
 * carry and, per event, the key it sits under. Cursor and Devin import Claude Code's hooks, so the Claude-registered
 * hook also fires there; when the detected harness's own file holds our hook for the event, that one does the work
 * and this one stays out (else two agents connect per session). Windsurf, Zed and OpenCode get no hook of ours.
 */
const OWN_HOOKS: Readonly<Record<HarnessId, { hint: HarnessId; keys: Partial<Record<HookEvent, string>> } | null>> = {
  "claude-code": { hint: "claude-code", keys: { "session-start": "SessionStart", "user-prompt-submit": "UserPromptSubmit", "session-end": "SessionEnd", stop: "Stop" } },
  codex: { hint: "codex", keys: { "session-start": "SessionStart", "user-prompt-submit": "UserPromptSubmit", "session-end": "SessionEnd" } },
  "gemini-cli": { hint: "gemini-cli", keys: { "session-start": "SessionStart", "user-prompt-submit": "BeforeAgent", "session-end": "SessionEnd" } },
  cursor: { hint: "cursor", keys: { "session-start": "sessionStart", "session-end": "sessionEnd" } },
  // One file serves VS Code and Copilot CLI; its commands carry --harness vscode.
  vscode: { hint: "vscode", keys: { "session-start": "sessionStart", "session-end": "sessionEnd" } },
  "copilot-cli": { hint: "vscode", keys: { "session-start": "sessionStart", "session-end": "sessionEnd" } },
  windsurf: null,
  zed: null,
  opencode: null,
};

function absoluteEnvDir(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== "" && isAbsolute(value) ? value : null;
}

/** The file that holds a harness's own jubarteai hooks, or null for a harness `init` registers none in. */
export function ownHookFile(harness: HarnessId, home: string, env: NodeJS.ProcessEnv): string | null {
  switch (harness) {
    case "claude-code":
      return claudeSettingsPath(home, env);
    case "codex":
      return join(codexHome(home, env), "hooks.json");
    case "cursor":
      return join(home, ".cursor", "hooks.json");
    case "gemini-cli":
      return join(home, ".gemini", "settings.json");
    case "vscode":
    case "copilot-cli":
      return join(absoluteEnvDir(env, "COPILOT_HOME") ?? join(home, ".copilot"), "hooks", "jubarteai.json");
    default:
      return null;
  }
}

/** Every string under a `command` key anywhere in `value` (the harnesses nest hook entries differently). */
function commandStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) commandStrings(item, out);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" && typeof item === "string") out.push(item);
      else commandStrings(item, out);
    }
  }
  return out;
}

/**
 * Whether `harness`'s own hook file holds our hook for `event` (a command ending `hook <event> --harness <its id>`
 * under the event's key). Read-only and never throws: a missing, unreadable or unparsable file is "no".
 */
export function ownHookRegistered(harness: HarnessId, event: HookEvent, home: string, env: NodeJS.ProcessEnv): boolean {
  const own = OWN_HOOKS[harness];
  const key = own?.keys[event];
  const file = ownHookFile(harness, home, env);
  if (own === null || key === undefined || file === null) return false;
  try {
    const read = readJsonObject(file);
    if (read.status !== "ok") return false;
    const hooks = read.doc["hooks"];
    if (!isRecord(hooks)) return false;
    return commandStrings(hooks[key]).some((command) => isOurHookCommand(command, event, own.hint));
  } catch {
    return false;
  }
}

/** The events `init` registers a hook for in `harness`'s own hook file; empty for a harness it registers none in. */
export function ownHookEvents(harness: HarnessId): HookEvent[] {
  const keys = OWN_HOOKS[harness]?.keys ?? {};
  return HOOK_EVENTS.filter((event) => keys[event] !== undefined);
}

export function parseHookEvent(value: string | undefined): HookEvent | null {
  return HOOK_EVENTS.find((event) => event === value) ?? null;
}

/** What the handlers need from the outside world; tests replace `call` and the timeouts. */
export type HookRuntime = {
  call: typeof callTool;
  /** Network calls on session-start and user-prompt-submit (HOOK_NETWORK_TIMEOUT_MS). */
  networkTimeoutMs: number;
  /** The session-end `disconnect`. */
  endTimeoutMs: number;
  /** Aborted when the hook's overall budget runs out. */
  signal: AbortSignal;
  /** The environment the Stop hook's unattended-run check reads (process.env when omitted). */
  env?: NodeJS.ProcessEnv;
};

function bindingFor(cwd: string): Binding | null {
  try {
    return findBinding(cwd);
  } catch {
    // An invalid binding file is the user's to fix with `jubarteai link`; a hook stays silent.
    return null;
  }
}

function slugOfName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_SLUG_CHARS);
}

/**
 * The repo slug of the spec's connect description. In a linked worktree it is the origin remote's repo name
 * (the worktree folder is often a generated id), else the main checkout's folder name; elsewhere the git top
 * level's folder name, in the repo-slug form.
 */
function repoSlug(cwd: string, fallbackRoot: string): string {
  const top = gitTop(cwd);
  const worktree = top === null ? null : linkedWorktree(top);
  if (worktree !== null) {
    const origin = originSlug(worktree.commonDir);
    if (origin !== null) return slugOfName(origin);
    if (worktree.mainCheckout !== null) return slugOfName(basename(worktree.mainCheckout));
  }
  return slugOfName(basename(top ?? fallbackRoot));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentFromEnvelope(envelope: Envelope): { agentId: string; name?: string } | null {
  const result = envelope.result;
  if (!isRecord(result)) return null;
  const agentId = result["agent_id"];
  const name = result["name"];
  if (typeof agentId !== "string" || !isAgentId(agentId)) return null;
  return typeof name === "string" && name.length > 0 && name.length <= MAX_AGENT_NAME_CHARS ? { agentId, name } : { agentId };
}

/**
 * The cached agent for this session, only when it was written for the seat being used: the same test the commands apply
 * (`entryBelongsToSeat`, so an entry made under an environment key must carry that key's fingerprint), or a hook and a
 * later `jubarteai` command would disagree about whose agent it is.
 */
function cachedAgent(harness: HarnessId, sessionId: string | null, seat: ResolvedSeat): SessionEntry | null {
  if (sessionId === null) return null;
  const entry = readSession(harness, sessionId);
  return entry !== null && entryBelongsToSeat(entry, seat) ? entry : null;
}

type Handled = { harness: HarnessId; input: HookInput; seat: ResolvedSeat; binding: Binding; runtime: HookRuntime };

async function sessionStart({ harness, input, seat, binding, runtime }: Handled): Promise<string> {
  const reuse = input.source !== null && REUSE_SOURCES.includes(input.source) ? cachedAgent(harness, input.sessionId, seat) : null;
  if (reuse !== null) return composeInjection(harness, input.event, identityLine(reuse.agent_id, reuse.name), []);

  const slug = repoSlug(input.cwd, binding.root);
  const description = slug === "" ? harness : `${harness} on ${slug}`;
  const outcome = await runtime.call(seat, "connect", { description }, { timeoutMs: runtime.networkTimeoutMs, signal: runtime.signal });
  if (outcome.exitCode === 4) return formatInjection(harness, input.event, UNREACHABLE_LINE);
  if (outcome.exitCode === 3) {
    const code = outcome.envelope.code;
    return code !== undefined && LOGIN_CODES.includes(code) ? formatInjection(harness, input.event, NOT_SIGNED_IN_LINE) : "";
  }
  if (outcome.exitCode !== 0) return "";
  const agent = agentFromEnvelope(outcome.envelope);
  if (agent === null) return "";

  if (input.sessionId !== null) {
    try {
      writeSession(
        harness,
        input.sessionId,
        {
          harness,
          agent_id: agent.agentId,
          seat_id: seat.seatId,
          origin: seat.origin,
          // An environment key has no seat id; the fingerprint (never the key) is what ties the entry to it.
          ...(seat.seatId === null ? { key_fp: keyFingerprint(seat.token) } : {}),
          ...(agent.name === undefined ? {} : { name: agent.name }),
        },
        { overwrite: true },
      );
    } catch {
      // The identity line below still names the agent, so later commands can pass --agent.
    }
  }
  return composeInjection(harness, input.event, identityLine(agent.agentId, agent.name), outcome.envelope.messages, overflowSpill(harness, input.sessionId));
}

async function userPromptSubmit({ harness, input, seat, runtime }: Handled): Promise<string> {
  const entry = cachedAgent(harness, input.sessionId, seat);
  if (entry === null) return "";
  const outcome = await runtime.call(seat, "check_inbox", { agent_id: entry.agent_id }, { timeoutMs: runtime.networkTimeoutMs, signal: runtime.signal });
  if (outcome.exitCode !== 0 || outcome.envelope.messages.length === 0) return "";
  return composeInjection(harness, input.event, identityLine(entry.agent_id, entry.name), outcome.envelope.messages, overflowSpill(harness, input.sessionId));
}

async function sessionEnd({ harness, input, seat, runtime }: Handled): Promise<string> {
  const entry = cachedAgent(harness, input.sessionId, seat);
  if (entry === null) return "";
  // The cache entry stays: a later resume reactivates the same agent with its next tool call.
  await runtime.call(seat, "disconnect", { agent_id: entry.agent_id }, { timeoutMs: runtime.endTimeoutMs, signal: runtime.signal });
  return "";
}

/**
 * The Stop event (Claude Code only): ask an agent that is about to go idle to arm its inbox watcher, once. Silent when this
 * Stop is a re-entry after our own block (`stop_hook_active`, so it can't loop), when the run is unattended, when the session
 * has no agent, and when a watcher is already running: one of the session's background tasks, or a live watcher process
 * holding the per-agent lock (which also keeps an `already_watching` answer from being asked for again and again).
 */
function stopEvent({ harness, input, seat, runtime }: Handled): string {
  if (harness !== "claude-code" || input.stopHookActive) return "";
  if (unattendedReason(runtime.env ?? process.env) !== null) return "";
  const entry = cachedAgent(harness, input.sessionId, seat);
  if (entry === null) return "";
  if (hasRunningWatcher(input.backgroundTasks, entry.agent_id) || isWatchLockHeld(entry.agent_id)) return "";
  return stopReminderOutput(entry.agent_id);
}

/**
 * Runs one hook event and returns the exact stdout text ("" prints nothing). Outside a bound repo, with
 * no harness known, for a hook another harness's own registered hook duplicates, or for a harness with no
 * injection on this event, it does nothing at all (D28, I7),
 * so no network call is made.
 */
export async function runHookEvent(input: HookInput, runtime: HookRuntime): Promise<string> {
  const harness = input.harness;
  if (harness === null) return "";
  // Another harness's hook running here (Claude Code's, imported by Cursor) defers only to a hook of this harness's own
  // that is really registered: Cursor installed after init, or its hooks declined, leaves this one to do the work.
  if (input.hint !== null && input.hint !== harness && ownHookRegistered(harness, input.event, homeDir(), process.env)) return "";
  if (input.event === "stop" && harness !== "claude-code") return "";
  if (input.event !== "session-end" && input.event !== "stop" && !injectionSupported(harness, input.event)) return "";
  const binding = bindingFor(input.cwd);
  if (binding === null) return "";

  const seat = resolveSeat({ cwd: input.cwd });
  if (isResolveError(seat)) {
    return input.event === "session-start" ? formatInjection(harness, input.event, NOT_SIGNED_IN_LINE) : "";
  }
  const handled: Handled = { harness, input, seat, binding, runtime };
  switch (input.event) {
    case "session-start":
      return sessionStart(handled);
    case "user-prompt-submit":
      return userPromptSubmit(handled);
    case "session-end":
      return sessionEnd(handled);
    case "stop":
      return stopEvent(handled);
  }
}
