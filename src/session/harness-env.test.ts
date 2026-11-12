import { describe, expect, it } from "vitest";

import { HARNESS_IDS, sessionFromEnv } from "./harness-env.js";

describe("sessionFromEnv", () => {
  it("reads the Claude Code session variable", () => {
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "abc-123" })).toEqual({ harness: "claude-code", sessionId: "abc-123" });
  });

  it("falls back to Codex's unofficial thread variable", () => {
    expect(sessionFromEnv({ CODEX_THREAD_ID: "thread-9" })).toEqual({ harness: "codex", sessionId: "thread-9" });
  });

  it("knows no session when both are set (a nested harness can't be told apart)", () => {
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "c", CODEX_THREAD_ID: "x" })).toBeNull();
  });

  it("knows no session for the harnesses whose variable is unverified", () => {
    expect(sessionFromEnv({ GEMINI_SESSION_ID: "g", CURSOR_SESSION_ID: "c", TERM_SESSION_ID: "t" })).toBeNull();
    expect(sessionFromEnv({})).toBeNull();
  });

  it("trims, and ignores blank, oversized or control-character values", () => {
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "  s1  " })?.sessionId).toBe("s1");
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "   " })).toBeNull();
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "x".repeat(257) })).toBeNull();
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "a\nb" })).toBeNull();
    // A bad Claude value doesn't hide a good Codex one.
    expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "a\u0000b", CODEX_THREAD_ID: "ok" })?.harness).toBe("codex");
  });

  it("lists the nine harnesses of spec §9", () => {
    expect([...HARNESS_IDS].sort()).toEqual(
      ["claude-code", "codex", "copilot-cli", "cursor", "gemini-cli", "opencode", "vscode", "windsurf", "zed"].sort(),
    );
  });
});
