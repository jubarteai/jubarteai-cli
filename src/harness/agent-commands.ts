// Which jubarteai commands a harness allowlist may pre-approve (spec §6.1 step 7, I6, review R-M1).
//
// An allowlist entry for the bare `jubarteai` command would also pre-approve the commands that change the saved
// account, the repo binding or harness files, so an agent (or a prompt-injected one) could sign in with its own key or
// rebind the repo without the person seeing a prompt. Every allowlist the CLI writes therefore names the agent
// commands below one by one, and never the person commands. The router refuses a flag before the command name (other
// than a lone --help/-h/--version), so the command name is always the second word and a per-command rule can't be
// slipped past with `jubarteai --yes init`.
//
// A harness whose rule syntax can only name the whole program (Cursor's `Shell(jubarteai)`), that matches programs other
// than git and gh by name (Copilot CLI), or whose matching is not verified (Windsurf), gets no written rule: the person
// decides from printed lines that say what a whole-program rule would also approve (PERSON_COMMAND_LIST). Copilot CLI
// prints no rule at all; its guard is the deny-only preToolUse hook (hooks/tool-guard.ts). A printed rule, like a
// written one, names agent commands only (AGENT_RULE_WORDS) or denies the person commands; a table test over every
// adapter holds them to that.
import { TOOL_SPECS } from "../mcp/tool-specs.js";

/** The commands that change the saved account, the repo binding or harness files: never pre-approved. */
export const PERSON_COMMANDS = ["login", "logout", "link", "init", "update"] as const;

/** The person commands as prose, for printed caveats: "login, logout, link, init and update". */
export const PERSON_COMMAND_LIST = `${PERSON_COMMANDS.slice(0, -1).join(", ")} and ${PERSON_COMMANDS[PERSON_COMMANDS.length - 1]}`;

/** Read-only commands outside the tool group that an agent is told to run (status, doctor) or uses to drain its inbox. */
const AGENT_EXTRA_COMMANDS = ["call", "inbox", "status", "doctor"] as const;

/** Every command an allowlist may pre-approve: each MCP tool command (connect included), then call, inbox, status, doctor. */
export const AGENT_COMMANDS: readonly string[] = Object.freeze([...TOOL_SPECS.map((spec) => spec.command), ...AGENT_EXTRA_COMMANDS]);

/** The flags that may stand alone after the program name: they print help or the version and run nothing. */
export const INFO_FLAGS = ["--help", "-h", "--version", "-v"] as const;

/**
 * The words a per-command allow entry (Gemini, OpenCode) names after the program: each agent command, then
 * the long info flags. `jubarteai --help` is what the skill tells every agent to run first; the router answers a lone
 * info flag before any command runs, so approving it approves nothing else.
 */
export const AGENT_RULE_WORDS: readonly string[] = Object.freeze([...AGENT_COMMANDS, "--help", "--version"]);

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
