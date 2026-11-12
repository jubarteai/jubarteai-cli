import { UsageError } from "./errors.js";

// Spec I6: harness and security files, the saved account and the repo binding change only with the consent of the
// person at the keyboard. A coding agent's shell commands are often pre-approved (`Bash(jubarteai *)`), so an agent —
// or a prompt-injected one — can type `--yes` or pipe a key just as well as a person can. When the CLI runs inside an
// agent's shell, those flags therefore stop counting as consent: the commands that change the account or the binding
// refuse, and applyPlan skips every sensitive step instead of applying it on `--yes` (review R-M1).
//
// A terminal on standard input proves nothing: VS Code, Zed and the Cursor IDE run an agent's commands in a real
// pseudo-terminal, and an agent that can type a command can answer a prompt there too. So an agent variable always marks
// an agent session, whatever stdin is. The cost is that a person who types `!jubarteai login` inside Claude Code or
// Gemini CLI is refused too; the refusal tells them to use their own terminal (review round 2, R-M1). VS Code and Zed
// set no variable the CLI can tell from a person's own terminal in the same editor, so there the protection is the
// allowlist itself: init never pre-approves login, logout, link, init or update (src/harness/agent-commands.ts).

/**
 * Variables a coding agent sets in the environment of the shell commands it runs. Any one of them marks an agent
 * session. A person who sees a false positive runs the command in their own terminal, which is what the refusal asks
 * for anyway.
 */
export const AGENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "GEMINI_CLI",
  "OPENCODE",
  "CURSOR_AGENT",
  "AI_AGENT",
] as const;

/** The variable that marks this process as running inside a coding agent's shell, or null. */
export function agentSessionVar(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of AGENT_SESSION_VARS) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false") return name;
  }
  return null;
}

/** The fixed refusal for a command that changes the saved account or the binding. */
export function agentSessionRefusal(command: string): UsageError {
  return new UsageError(
    `jubarteai ${command} changes your JubarteAI account or this repo's workspace, so it needs you, not an agent. Run it yourself in a terminal.`,
  );
}

/** Throws the refusal when this process runs inside an agent's shell. */
export function refuseInAgentSession(command: string, env: NodeJS.ProcessEnv = process.env): void {
  if (agentSessionVar(env) !== null) throw agentSessionRefusal(command);
}
