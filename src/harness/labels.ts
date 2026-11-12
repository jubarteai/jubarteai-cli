import type { HarnessId } from "../session/harness-env.js";

/** The names people know the harnesses by; the checklist and the timeline group rows under these. No adapter import, so the UI stays light. */
export const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  zed: "Zed",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  "copilot-cli": "Copilot CLI",
};
