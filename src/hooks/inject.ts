// What a hook prints, per harness (spec §6.3 and §9): the identity line, the drained messages and the
// JSON or plain-stdout wrapper each harness accepts. Pure: the one write (overflowed messages) is done by the caller's `Spill`.
import { redactSecrets, safeForDisplay } from "../output.js";
import type { HarnessId } from "../session/harness-env.js";
import type { HookEvent } from "./events.js";

export const NOT_SIGNED_IN_LINE =
  "JubarteAI: not signed in here, run jubarteai login (use the MCP tools if they're available).";
export const UNREACHABLE_LINE = "JubarteAI is unreachable right now; retry with jubarteai connect later.";

/** Claude Code cuts a hook's stdout at 10,000 characters; the other capped harnesses get the same budget. */
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
const MESSAGES_PREFIX = "JubarteAI messages: ";
const NAME_MAX_CHARS = 200;

/**
 * Longest output (in characters, the wrapper included) injected into a harness. Codex has none: it
 * spills oversized hook output to disk itself, and the messages are already marked delivered, so
 * nothing may be dropped on its account.
 */
function maxOutputChars(harness: HarnessId): number {
  return harness === "codex" ? Number.POSITIVE_INFINITY : DEFAULT_MAX_OUTPUT_CHARS;
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

/** Where messages that don't fit are put, and how: `save` returns false when they could not be written. */
export type Spill = { path: string; save: (dropped: readonly unknown[]) => boolean };

function messagesLine(messages: readonly unknown[], kept: number): string {
  // The server already wrapped each content as untrusted; this only makes sure no key shape survives.
  return `${MESSAGES_PREFIX}${redactSecrets(JSON.stringify({ messages: messages.slice(0, kept) }))}`;
}

function overflowNote(dropped: number, path: string | null): string {
  const noun = dropped === 1 ? "message" : "messages";
  if (path === null) return `JubarteAI: ${dropped} more ${noun} didn't fit and could not be saved.`;
  return `JubarteAI: ${dropped} more ${noun} didn't fit; read them from ${path.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?")}`;
}

/**
 * The identity line plus, when there are any, the messages as one compact JSON line
 * (`{"messages":[…]}`). The server marked them delivered, so none may be lost: when a capped harness
 * can't take them all, whole trailing messages (never a cut one) go to `spill.path` and a line says how
 * many and where. Without a `spill`, or when saving fails, the line says they could not be saved.
 */
export function composeInjection(
  harness: HarnessId,
  event: HookEvent,
  identity: string,
  messages: readonly unknown[],
  spill?: Spill,
): string {
  if (messages.length === 0) return formatInjection(harness, event, identity);
  const limit = maxOutputChars(harness);
  const build = (kept: number, path: string | null): string => {
    const note = kept < messages.length ? `\n${overflowNote(messages.length - kept, path)}` : "";
    return formatInjection(harness, event, `${identity}\n${messagesLine(messages, kept)}${note}`);
  };

  // Start from the most messages whose own JSON could fit, so a long inbox isn't re-serialized per message.
  const sizes = messages.map((message) => JSON.stringify(message).length + 1);
  let kept = 0;
  let total = identity.length + MESSAGES_PREFIX.length;
  for (const size of sizes) {
    if (total + size > limit) break;
    total += size;
    kept += 1;
  }
  const path = spill?.path ?? null;
  let out = build(kept, path);
  while (out.length > limit && kept > 0) {
    kept -= 1;
    out = build(kept, path);
  }
  if (kept === messages.length) return out;
  if (spill !== undefined && spill.save(messages.slice(kept))) return out;
  // Not saved: the note is shorter without the path, so the same cut still fits.
  return build(kept, null);
}
