import { describe, expect, it } from "vitest";

import { harnessFromHint, parseHookInput } from "./input.js";

const CWD = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const FALLBACK = process.platform === "win32" ? "C:\\fallback" : "/fallback";

function parse(stdin: unknown, hint: Parameters<typeof parseHookInput>[1] = "claude-code", env: NodeJS.ProcessEnv = {}) {
  const raw = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  return parseHookInput(raw, hint, "session-start", env, FALLBACK);
}

describe("parseHookInput", () => {
  it("reads a Claude Code SessionStart payload", () => {
    expect(parse({ session_id: "s-1", cwd: CWD, source: "resume", hook_event_name: "SessionStart" })).toEqual({
      harness: "claude-code",
      hint: "claude-code",
      event: "session-start",
      sessionId: "s-1",
      source: "resume",
      cwd: CWD,
      stopHookActive: false,
      backgroundTasks: [],
    });
  });

  it("falls back to the given cwd when stdin names none, or a relative or odd one", () => {
    expect(parse({ session_id: "s" }).cwd).toBe(FALLBACK);
    expect(parse({ session_id: "s", cwd: "relative/dir" }).cwd).toBe(FALLBACK);
    expect(parse({ session_id: "s", cwd: `${CWD}\u0000x` }).cwd).toBe(FALLBACK);
    expect(parse({ session_id: "s", cwd: 7 }).cwd).toBe(FALLBACK);
  });

  it("uses Cursor's first workspace root when there is no cwd", () => {
    expect(parse({ conversation_id: "c", cursor_version: "1.0", workspace_roots: [CWD, FALLBACK] }).cwd).toBe(CWD);
  });

  it("reads the session id from session_id, sessionId or conversation_id, in that order", () => {
    expect(parse({ session_id: "a", sessionId: "b" }).sessionId).toBe("a");
    expect(parse({ sessionId: "b", conversation_id: "c" }).sessionId).toBe("b");
    expect(parse({ conversation_id: "c" }).sessionId).toBe("c");
  });

  it("refuses unusable session ids and falls back to the environment only for the same harness", () => {
    expect(parse({ session_id: "x".repeat(300) }).sessionId).toBeNull();
    expect(parse({ session_id: "has\nnewline" }).sessionId).toBeNull();
    expect(parse({ session_id: "   " }).sessionId).toBeNull();
    expect(parse({}, "claude-code", { CLAUDE_CODE_SESSION_ID: "env-1" }).sessionId).toBe("env-1");
    expect(parse({}, "codex", { CLAUDE_CODE_SESSION_ID: "env-1" }).sessionId).toBeNull();
    expect(parse({}, "codex", { CODEX_THREAD_ID: "thread-1" }).sessionId).toBe("thread-1");
  });

  it("accepts only a plain word as the source", () => {
    expect(parse({ source: "startup" }).source).toBe("startup");
    expect(parse({ source: "fork" }).source).toBe("fork");
    expect(parse({ source: "bad value" }).source).toBeNull();
    expect(parse({ source: "x\ny" }).source).toBeNull();
    expect(parse({ source: 3 }).source).toBeNull();
    expect(parse({}).source).toBeNull();
  });

  it("returns nulls, never throws, for malformed or non-object stdin", () => {
    for (const raw of ["", "not json", "[1,2]", "null", "\"s\"", "{"]) {
      expect(parse(raw)).toEqual({ harness: "claude-code", hint: "claude-code", event: "session-start", sessionId: null, source: null, cwd: FALLBACK, stopHookActive: false, backgroundTasks: [] });
    }
  });
});

describe("harness detection (spec §6.3)", () => {
  it("uses the --harness hint when nothing else says otherwise", () => {
    expect(parse({ session_id: "s" }, "codex").harness).toBe("codex");
    expect(parse({ session_id: "s" }, "gemini-cli").harness).toBe("gemini-cli");
  });

  it("lets Cursor's stdin shape win over a Claude Code hint", () => {
    const input = parse({ cursor_version: "1.7", conversation_id: "c-1", session_id: "s" }, "claude-code");
    expect(input.harness).toBe("cursor");
    expect(input.hint).toBe("claude-code");
  });

  it("needs both Cursor fields", () => {
    expect(parse({ cursor_version: "1.7" }, "claude-code").harness).toBe("claude-code");
    expect(parse({ conversation_id: "c" }, "claude-code").harness).toBe("claude-code");
  });

  it("lets DEVIN_PROJECT_DIR win over the hint (Devin is the Windsurf product)", () => {
    expect(parse({ session_id: "s" }, "claude-code", { DEVIN_PROJECT_DIR: "/p" }).harness).toBe("windsurf");
    expect(parse({ session_id: "s" }, "claude-code", { DEVIN_PROJECT_DIR: "" }).harness).toBe("claude-code");
  });

  it("falls back to the harness of the session variable, then to null", () => {
    expect(parse({}, null, { CODEX_THREAD_ID: "t" }).harness).toBe("codex");
    expect(parse({}, null, {}).harness).toBeNull();
  });
});

describe("harnessFromHint", () => {
  it("accepts a known harness id only", () => {
    expect(harnessFromHint("cursor")).toBe("cursor");
    expect(harnessFromHint("emacs")).toBeNull();
    expect(harnessFromHint(undefined)).toBeNull();
    expect(harnessFromHint(true)).toBeNull();
  });

  it("reads the Stop payload's re-entry flag and background tasks, bounded", () => {
    expect(parse({}).stopHookActive).toBe(false);
    expect(parse({ stop_hook_active: true }).stopHookActive).toBe(true);
    expect(parse({ stop_hook_active: "true" }).stopHookActive).toBe(false);
    expect(parse({}).backgroundTasks).toEqual([]);
    expect(parse({ background_tasks: [{ type: "shell", status: "running", command: "sleep 1", id: "x" }, "junk"] }).backgroundTasks).toEqual([
      { type: "shell", status: "running", command: "sleep 1" },
    ]);
    expect(parse({ background_tasks: "no" }).backgroundTasks).toEqual([]);
  });
});
