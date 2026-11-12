// Which harness session this process runs in, from the environment (spec §9 column "Session variable").
// Only variables the spec marks verified or named as a fallback are read; every other harness is
// unverified (U) and so has no session id here (the hook's stdin `session_id` covers those).

export type HarnessId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "zed"
  | "gemini-cli"
  | "opencode"
  | "copilot-cli";

export const HARNESS_IDS: readonly HarnessId[] = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "gemini-cli",
  "opencode",
  "copilot-cli",
];

const MAX_SESSION_ID_CHARS = 256;

/** A session id fit to be hashed into a cache key: non-empty, bounded, printable. */
function cleanSessionId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_SESSION_ID_CHARS) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * The harness session this process was started in, or null when none is known.
 * `CLAUDE_CODE_SESSION_ID` is verified (spec §9, P3). `CODEX_THREAD_ID` is an unofficial
 * fallback for Codex. When both are set the process is nested (one harness launched inside the
 * other, so the two sessions can't be told apart from here): no session, hence no cache. The hook's
 * identity line and `--agent` cover that case, and a wrong guess would put one session's agent in
 * the other's cache.
 */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): { harness: HarnessId; sessionId: string } | null {
  const claude = cleanSessionId(env["CLAUDE_CODE_SESSION_ID"]);
  const codex = cleanSessionId(env["CODEX_THREAD_ID"]);
  if (claude !== null && codex !== null) return null;
  if (claude !== null) return { harness: "claude-code", sessionId: claude };
  if (codex !== null) return { harness: "codex", sessionId: codex };
  return null;
}
