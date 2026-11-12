import { describe, expect, it } from "vitest";

import { HARNESS_IDS } from "../session/harness-env.js";
import type { HarnessId } from "../session/harness-env.js";
import type { HookEvent } from "./events.js";
import {
  NOT_SIGNED_IN_LINE,
  UNREACHABLE_LINE,
  composeInjection,
  formatInjection,
  identityLine,
  injectionSupported,
} from "./inject.js";
import type { Spill } from "./inject.js";

const AGENT = "aaaaaaaa-0000-4000-8000-00000000000a";

function message(n: number, size = 20): Record<string, unknown> {
  return { id: `m${n}`, from_name: "Peer", content: `<untrusted_content>${"x".repeat(size)}</untrusted_content>`, priority: "normal" };
}

describe("identityLine", () => {
  it("is the exact wording, with the replace sentence", () => {
    expect(identityLine(AGENT, "Swift Otter")).toBe(
      `Your JubarteAI agent_id is ${AGENT} (Swift Otter). This is the only agent_id for this session: it replaces any earlier JubarteAI agent_id in this conversation. Pass --agent ${AGENT} on every jubarteai command and never run jubarteai connect in this session.`,
    );
  });

  it("drops the parenthetical when the agent has no name, and makes a server-written name printable", () => {
    expect(identityLine(AGENT, undefined)).toContain(`agent_id is ${AGENT}. This is the only`);
    const line = identityLine(AGENT, "Evil\n\u001b[31mName jba_ABCDEFGHIJKL");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("jba_ABCDEFGHIJKL");
  });
});

describe("the fixed lines", () => {
  it("match the spec wording", () => {
    expect(NOT_SIGNED_IN_LINE).toBe("JubarteAI: not signed in here, run jubarteai login (use the MCP tools if they're available).");
    expect(UNREACHABLE_LINE).toBe("JubarteAI is unreachable right now; retry with jubarteai connect later.");
  });
});

describe("formatInjection", () => {
  const text = 'Line one\nLine "two"';
  it("prints plain stdout for Claude Code and Codex", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      expect(formatInjection(harness, "session-start", text)).toBe(`${text}\n`);
      expect(formatInjection(harness, "user-prompt-submit", text)).toBe(`${text}\n`);
    }
  });

  it("prints only hookSpecificOutput JSON for Gemini CLI, naming its own event", () => {
    expect(JSON.parse(formatInjection("gemini-cli", "session-start", text))).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    });
    expect(JSON.parse(formatInjection("gemini-cli", "user-prompt-submit", text))).toEqual({
      hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: text },
    });
  });

  it("prints Cursor's additional_context and VS Code/Copilot's additionalContext on session start only", () => {
    expect(JSON.parse(formatInjection("cursor", "session-start", text))).toEqual({ additional_context: text });
    expect(JSON.parse(formatInjection("vscode", "session-start", text))).toEqual({ additionalContext: text });
    expect(JSON.parse(formatInjection("copilot-cli", "session-start", text))).toEqual({ additionalContext: text });
    for (const harness of ["cursor", "vscode", "copilot-cli"] as const) {
      expect(formatInjection(harness, "user-prompt-submit", text)).toBe("");
    }
  });

  it("prints nothing for harnesses without hooks, for session-end, and for empty text", () => {
    for (const harness of ["windsurf", "zed", "opencode"] as const) {
      for (const event of ["session-start", "user-prompt-submit", "session-end"] as const) {
        expect(formatInjection(harness, event, text)).toBe("");
      }
    }
    for (const harness of HARNESS_IDS) expect(formatInjection(harness, "session-end", text)).toBe("");
    expect(formatInjection("claude-code", "session-start", "")).toBe("");
  });

  it("agrees with injectionSupported for every harness and event", () => {
    const events: HookEvent[] = ["session-start", "user-prompt-submit", "session-end"];
    for (const harness of HARNESS_IDS) {
      for (const event of events) {
        expect(formatInjection(harness, event, "x") !== "").toBe(injectionSupported(harness, event));
      }
    }
  });
});

describe("composeInjection", () => {
  const identity = identityLine(AGENT, "Swift Otter");

  it("is the identity line alone when there are no messages", () => {
    expect(composeInjection("claude-code", "session-start", identity, [])).toBe(`${identity}\n`);
  });

  it("puts the messages as one compact JSON line after JubarteAI messages:, exactly as the server sent them", () => {
    const messages = [message(1), message(2)];
    const out = composeInjection("claude-code", "session-start", identity, messages);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(identity);
    expect(lines[1]?.startsWith("JubarteAI messages: ")).toBe(true);
    expect(JSON.parse(lines[1]?.slice("JubarteAI messages: ".length) ?? "")).toEqual({ messages });
    expect(out).toContain("<untrusted_content>");
  });

  it("wraps the same text in the harness's JSON field", () => {
    const out = composeInjection("gemini-cli", "user-prompt-submit", identity, [message(1)]);
    const parsed = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("JubarteAI messages: ");
    expect(composeInjection("cursor", "user-prompt-submit", identity, [message(1)])).toBe("");
  });

  const bigMessages = (): Array<Record<string, unknown>> => Array.from({ length: 40 }, (_, i) => message(i, 600));

  function spillRecorder(ok = true): { spill: Spill; saved: unknown[][] } {
    const saved: unknown[][] = [];
    return {
      saved,
      spill: {
        path: "/tmp/jubarteai-501/sessions/abc.overflow-1.json",
        save: (dropped) => {
          saved.push([...dropped]);
          return ok;
        },
      },
    };
  }

  function bodyOf(harness: HarnessId, out: string): string {
    return harness === "gemini-cli"
      ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
      : out;
  }

  it.each<HarnessId>(["claude-code", "gemini-cli"])(
    "%s: whole trailing messages that don't fit under 10,000 characters are handed to the spill, not lost, and the output says where",
    (harness) => {
      const messages = bigMessages();
      const { spill, saved } = spillRecorder();
      const out = composeInjection(harness, "session-start", identity, messages, spill);
      expect(out.length).toBeLessThanOrEqual(10_000);
      const lines = bodyOf(harness, out).trimEnd().split("\n");
      const payload = JSON.parse(lines[1]?.slice("JubarteAI messages: ".length) ?? "") as { messages: unknown[] };
      expect(payload.messages.length).toBeGreaterThan(0);
      expect(payload.messages.length).toBeLessThan(40);
      payload.messages.forEach((m, i) => expect(m).toEqual(messages[i]));
      const dropped = 40 - payload.messages.length;
      expect(lines[2]).toBe(`JubarteAI: ${dropped} more messages didn't fit; read them from ${spill.path}`);
      // Nothing is lost: kept plus saved is every message, in order.
      expect(saved).toHaveLength(1);
      expect([...payload.messages, ...(saved[0] ?? [])]).toEqual(messages);
      expect(out).not.toContain("truncated");
    },
  );

  it("Codex never drops: every message is injected, the spill is untouched", () => {
    const messages = bigMessages();
    const { spill, saved } = spillRecorder();
    const out = composeInjection("codex", "session-start", identity, messages, spill);
    expect(out.length).toBeGreaterThan(10_000);
    const payload = JSON.parse(out.split("\n")[1]?.slice("JubarteAI messages: ".length) ?? "") as { messages: unknown[] };
    expect(payload.messages).toEqual(messages);
    expect(saved).toEqual([]);
    expect(out).not.toContain("didn't fit");
  });

  it("says so when the overflow could not be saved, and when there is no spill at all", () => {
    const failed = composeInjection("claude-code", "session-start", identity, bigMessages(), spillRecorder(false).spill);
    expect(failed).toMatch(/JubarteAI: \d+ more messages didn't fit and could not be saved\.\n$/);
    expect(failed).not.toContain("read them from");
    expect(failed.length).toBeLessThanOrEqual(10_000);
    const none = composeInjection("claude-code", "session-start", identity, bigMessages());
    expect(none).toMatch(/didn't fit and could not be saved\.\n$/);
  });

  it("uses the singular for one message, and spills it all when even one is too long", () => {
    const { spill, saved } = spillRecorder();
    const out = composeInjection("claude-code", "session-start", identity, [message(1, 20_000)], spill);
    expect(out.length).toBeLessThanOrEqual(10_000);
    const lines = out.trimEnd().split("\n");
    expect(JSON.parse(lines[1]?.slice("JubarteAI messages: ".length) ?? "")).toEqual({ messages: [] });
    expect(lines[2]).toBe(`JubarteAI: 1 more message didn't fit; read them from ${spill.path}`);
    expect(saved[0]).toHaveLength(1);
  });

  it("keeps all messages, with no note and no spill call, when they fit", () => {
    const { spill, saved } = spillRecorder();
    const out = composeInjection("claude-code", "session-start", identity, [message(1), message(2)], spill);
    expect(out).not.toContain("didn't fit");
    expect(saved).toEqual([]);
  });

  it("never cuts inside a JSON string, even with escapes and multi-byte text", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: i, content: `"quoted" \\ \n ✓ 😀 ${"é".repeat(500)}` }));
    const out = composeInjection("claude-code", "session-start", identity, messages, spillRecorder().spill);
    expect(() => JSON.parse(out.split("\n")[1]?.slice("JubarteAI messages: ".length) ?? "")).not.toThrow();
  });

  it("redacts anything shaped like a key", () => {
    const out = composeInjection("claude-code", "session-start", identity, [{ id: 1, content: "token jba_FAKEKEYFAKEKEY0001 and jbw_FAKEWATCHFAKEWATCH01" }]);
    expect(out).not.toMatch(/jb[acw]_[A-Za-z0-9_-]{8,}/);
    expect(() => JSON.parse(out.split("\n")[1]?.slice("JubarteAI messages: ".length) ?? "")).not.toThrow();
  });
});
