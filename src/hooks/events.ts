// What each hook event does (spec §6.3). Every path ends in a string to print ("" for nothing) and none
// throws for a server, network or file problem: a hook must never fail the harness (I7).
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { findBinding } from "../binding/binding.js";
import type { Binding } from "../binding/binding.js";
import type { Envelope } from "../mcp/client.js";
import { callTool } from "../mcp/client.js";
import { isAgentId, readSession, writeSession } from "../session/cache.js";
import type { SessionEntry } from "../session/cache.js";
import type { HarnessId } from "../session/harness-env.js";
import { overflowSpill } from "./overflow.js";
import { NOT_SIGNED_IN_LINE, UNREACHABLE_LINE, composeInjection, formatInjection, identityLine, injectionSupported } from "./inject.js";
import type { HookInput } from "./input.js";

export type HookEvent = "session-start" | "user-prompt-submit" | "session-end";

export const HOOK_EVENTS: readonly HookEvent[] = ["session-start", "user-prompt-submit", "session-end"];

/** `session-end` is best effort: harnesses give it about a second (spec §6.3). */
export const SESSION_END_NETWORK_TIMEOUT_MS = 1_000;

/** The `source` values on which a cached agent is reused instead of connecting a new one. */
const REUSE_SOURCES: readonly string[] = ["resume", "compact"];
/** 401 codes where "run jubarteai login" is the right hint; a billing or seat refusal is not fixed by logging in. */
const LOGIN_CODES: readonly string[] = ["invalid_api_key", "revoked_api_key", "unauthorized"];
const MAX_AGENT_NAME_CHARS = 200;
const MAX_SLUG_CHARS = 100;

/**
 * The events for which `init` registers the harness's own hook (spec §9 "Hooks"). Cursor and Devin import
 * Claude Code's hooks, so the Claude-registered hook also fires there; when the harness it detected has its
 * own hook for the event, that one does the work and this one stays out (else two agents connect per session).
 */
const OWN_HOOK_EVENTS: Readonly<Record<HarnessId, readonly HookEvent[]>> = {
  "claude-code": ["session-start", "user-prompt-submit", "session-end"],
  codex: ["session-start", "user-prompt-submit", "session-end"],
  "gemini-cli": ["session-start", "user-prompt-submit", "session-end"],
  cursor: ["session-start", "session-end"],
  vscode: ["session-start", "session-end"],
  "copilot-cli": ["session-start", "session-end"],
  windsurf: [],
  zed: [],
  opencode: [],
};

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
};

function bindingFor(cwd: string): Binding | null {
  try {
    return findBinding(cwd);
  } catch {
    // An invalid binding file is the user's to fix with `jubarteai link`; a hook stays silent.
    return null;
  }
}

/** The nearest folder at or above `start` holding `.git` (a directory, or a file for worktrees and submodules). */
function gitTopLevel(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The repo slug of the spec's connect description: the git top level's folder name, in the repo-slug form. */
function repoSlug(cwd: string, fallbackRoot: string): string {
  const root = gitTopLevel(cwd) ?? fallbackRoot;
  return basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_SLUG_CHARS);
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

/** The cached agent for this session, only when it was written for the seat being used (as `resolveAgent` does). */
function cachedAgent(harness: HarnessId, sessionId: string | null, seat: ResolvedSeat): SessionEntry | null {
  if (sessionId === null) return null;
  const entry = readSession(harness, sessionId);
  return entry !== null && entry.origin === seat.origin && entry.seat_id === seat.seatId ? entry : null;
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
        { harness, agent_id: agent.agentId, seat_id: seat.seatId, origin: seat.origin, ...(agent.name === undefined ? {} : { name: agent.name }) },
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
 * Runs one hook event and returns the exact stdout text ("" prints nothing). Outside a bound repo, with
 * no harness known, for a hook another harness's own registered hook duplicates, or for a harness with no
 * injection on this event, it does nothing at all (D28, I7),
 * so no network call is made.
 */
export async function runHookEvent(input: HookInput, runtime: HookRuntime): Promise<string> {
  const harness = input.harness;
  if (harness === null) return "";
  if (input.hint !== null && input.hint !== harness && OWN_HOOK_EVENTS[harness].includes(input.event)) return "";
  if (input.event !== "session-end" && !injectionSupported(harness, input.event)) return "";
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
  }
}
