// What a hook prints, per harness (spec §6.3 and §9): the identity line, the drained messages and the
// JSON or plain-stdout wrapper each harness accepts. Pure: no I/O, no clock.
import { redactSecrets, safeForDisplay } from "../output.js";
import type { HarnessId } from "../session/harness-env.js";
import type { HookEvent } from "./events.js";

export const NOT_SIGNED_IN_LINE =
  "JubarteAI: not signed in here, run jubarteai login (use the MCP tools if they're available).";
export const UNREACHABLE_LINE = "JubarteAI is unreachable right now; retry with jubarteai connect later.";

/** Claude Code cuts a hook's stdout at 10,000 characters. */
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
/** Codex's limit is about 2,500 tokens; a conservative character budget below it. */
const CODEX_MAX_OUTPUT_CHARS = 6_000;
const MESSAGES_PREFIX = "JubarteAI messages: ";
const NAME_MAX_CHARS = 200;

/** Longest output (in characters, the wrapper included) a harness is known to accept. */
function maxOutputChars(harness: HarnessId): number {
  return harness === "codex" ? CODEX_MAX_OUTPUT_CHARS : DEFAULT_MAX_OUTPUT_CHARS;
}

/** The identity line (spec §6.3, wording fixed). The name is server text: made printable first. */
export function identityLine(agentId: string, name: string | undefined): string {
  const label = name === undefined || name === "" ? "" : ` (${safeForDisplay(name, NAME_MAX_CHARS)})`;
  return (
    `Your JubarteAI agent_id is ${agentId}${label}. ` +
    "This is the only agent_id for this session: it replaces any earlier JubarteAI agent_id in this conversation. " +
    `Pass --agent ${agentId} on every jubarteai command and never run jubarteai connect in this session.`
  );
}

/** Whether `harness` can take injected context on `event` (spec §9). session-end never injects. */
export function injectionSupported(harness: HarnessId, event: HookEvent): boolean {
  if (event === "session-end") return false;
  switch (harness) {
    case "claude-code":
    case "codex":
    case "gemini-cli":
      return true;
    case "cursor":
    case "vscode":
    case "copilot-cli":
      return event === "session-start";
    case "windsurf":
    case "zed":
    case "opencode":
      return false;
  }
}

/**
 * The exact bytes to write to stdout for `text` on this harness, or "" when the harness has no
 * injection for this event (or `text` is empty). Claude Code and Codex read plain stdout; Gemini CLI
 * accepts only its `hookSpecificOutput` JSON; Cursor and VS Code/Copilot CLI have their own field.
 */
export function formatInjection(harness: HarnessId, event: HookEvent, text: string): string {
  if (text === "" || !injectionSupported(harness, event)) return "";
  switch (harness) {
    case "claude-code":
    case "codex":
      return `${text}\n`;
    case "gemini-cli":
      return `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event === "session-start" ? "SessionStart" : "BeforeAgent",
          additionalContext: text,
        },
      })}\n`;
    case "cursor":
      return `${JSON.stringify({ additional_context: text })}\n`;
    case "vscode":
    case "copilot-cli":
      return `${JSON.stringify({ additionalContext: text })}\n`;
    case "windsurf":
    case "zed":
    case "opencode":
      return "";
  }
}

function messagesLine(messages: readonly unknown[], kept: number): string {
  const dropped = messages.length - kept;
  const payload = dropped === 0 ? { messages: messages.slice(0, kept) } : { messages: messages.slice(0, kept), truncated: dropped };
  // The server already wrapped each content as untrusted; this only makes sure no key shape survives.
  return `${MESSAGES_PREFIX}${redactSecrets(JSON.stringify(payload))}`;
}

/**
 * The identity line plus, when there are any, the messages as one compact JSON line
 * (`{"messages":[…]}`, plus `"truncated":N` when trailing messages had to be dropped to stay under the
 * harness's output limit). Whole messages are dropped, never cut, so the JSON is always valid.
 */
export function composeInjection(harness: HarnessId, event: HookEvent, identity: string, messages: readonly unknown[]): string {
  if (messages.length === 0) return formatInjection(harness, event, identity);
  const limit = maxOutputChars(harness);
  const build = (kept: number): string => formatInjection(harness, event, `${identity}\n${messagesLine(messages, kept)}`);

  // Start from the most messages whose own JSON could fit, so a long inbox isn't re-serialized per message.
  const sizes = messages.map((message) => JSON.stringify(message).length + 1);
  let kept = 0;
  let total = identity.length + MESSAGES_PREFIX.length;
  for (const size of sizes) {
    if (total + size > limit) break;
    total += size;
    kept += 1;
  }
  let out = build(kept);
  while (out.length > limit && kept > 0) {
    kept -= 1;
    out = build(kept);
  }
  return out;
}
