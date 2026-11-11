// Which jubarteai commands a harness allowlist may pre-approve (spec §6.1 step 7, I6, review R-M1).
//
// An allowlist entry for the bare `jubarteai` command would also pre-approve the commands that change the saved
// account, the repo binding or harness files, so an agent (or a prompt-injected one) could sign in with its own key or
// rebind the repo without the person seeing a prompt. Every allowlist the CLI writes therefore names the agent
// commands below one by one, and never the person commands. The router refuses a flag before the command name (other
// than a lone --help/-h/--version), so the command name is always the second word and a per-command rule can't be
// slipped past with `jubarteai --yes init`.
//
// A harness whose rule syntax can only name the whole program (Cursor's `Shell(jubarteai)`) gets no written rule:
// the person decides from a printed line that says what it would also approve.
import { TOOL_SPECS } from "../mcp/tool-specs.js";

/** The commands that change the saved account, the repo binding or harness files: never pre-approved. */
export const PERSON_COMMANDS = ["login", "logout", "link", "init", "update"] as const;

/** Read-only commands outside the tool group that an agent is told to run (status, doctor) or uses to drain its inbox. */
const AGENT_EXTRA_COMMANDS = ["call", "inbox", "status", "doctor"] as const;

/** Every command an allowlist may pre-approve: each MCP tool command (connect included), then call, inbox, status, doctor. */
export const AGENT_COMMANDS: readonly string[] = Object.freeze([...TOOL_SPECS.map((spec) => spec.command), ...AGENT_EXTRA_COMMANDS]);

/** The flags that may stand alone after the program name: they print help or the version and run nothing. */
export const INFO_FLAGS = ["--help", "-h", "--version", "-v"] as const;

/** A command name or info flag, escaped for a regular expression (they hold only letters, digits and dashes today). */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pattern for "`program` followed by one of `words`, then a space or the end": no lookahead, so the same text is a
 * valid JavaScript (VS Code) and Rust (Zed) regular expression.
 */
export function commandPattern(program: string, words: readonly string[]): string {
  return `^${escapeRegex(program)}\\s+(?:${words.map(escapeRegex).join("|")})(?:\\s|$)`;
}

/** The regex source that matches a pre-approvable command line: an agent command or a lone info flag. */
export function agentCommandPattern(program = "jubarteai"): string {
  return commandPattern(program, [...AGENT_COMMANDS, ...INFO_FLAGS]);
}

/** The regex source that matches a person command line. */
export function personCommandPattern(program = "jubarteai"): string {
  return commandPattern(program, PERSON_COMMANDS);
}
