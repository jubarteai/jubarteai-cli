// `jubarteai hook pre-tool-use` (spec I6, §6.3, review R-S12): the deny-only guard registered as a `preToolUse` hook in
// the shared ~/.copilot/hooks/jubarteai.json, which Copilot CLI and VS Code's Copilot harness both read.
//
// Neither harness sets a variable the CLI could use to refuse login, logout, link, init or update from an agent, and
// Copilot CLI's rules match programs other than git and gh by name, so a session approval of any jubarteai command
// approves those five too. GitHub's hooks reference: "For `preToolUse`, if any hook returns "deny", the tool is
// blocked", whatever was approved. So this hook answers a deny for a shell tool call whose command names one of the
// five, and `{}` (no decision: the normal permission flow) for everything else. It never answers "allow".
//
// It is best effort, not a sandbox: a command hidden in a script file or a shell variable is not seen. Quotes and
// backslashes are dropped before matching, so `jubarteai "login"`, `j"ubarteai" login` and `jubarteai \login` match,
// and the program may follow any shell separator, so chained, `$(…)`, backtick and path forms match too. Matching errs
// toward a deny: a commit message that quotes `jubarteai login` is refused as well, and the reason says why.
//
// Pure: no network, no file reads, no binding lookup. It runs in every repo, bound or not, because login and logout
// change user-level credentials (the stated exception to I7's bound-repo rule).
import { PERSON_COMMANDS } from "../harness/agent-commands.js";

/** The `hook` event name of the guard: `jubarteai hook pre-tool-use --harness vscode`. Not a session event. */
export const PRE_TOOL_USE = "pre-tool-use";

/** The hook's answer: one JSON object on stdout, exit 0. */
export type ToolGuardOutput = { permissionDecision: "deny"; permissionDecisionReason: string } | Record<string, never>;

/**
 * Tool names (lowercased) that run a shell command. `bash` and `powershell` are the Copilot runtime's (GitHub hooks
 * reference); the rest cover a harness that names its terminal tool otherwise. A tool not listed still counts as a
 * shell tool when its arguments carry a string `command` (isShellCall).
 */
export const SHELL_TOOL_NAMES: readonly string[] = Object.freeze(["bash", "powershell", "pwsh", "shell", "sh", "zsh", "terminal", "run_in_terminal", "runinterminal", "run_terminal_cmd", "run_shell_command"]);

/** The `matcher` written on the hook entry: the Copilot runtime's shell tools, so no other tool call starts a process. */
export const SHELL_TOOL_MATCHER = "bash|powershell";

/** The commands the guard refuses, as a regex alternation. */
const PERSON_ALTERNATION = PERSON_COMMANDS.join("|");

/**
 * `jubarteai` as a program (after the start, whitespace or a shell separator, or a `/`/`\` path separator), with an
 * optional `.cmd`/`.exe`/`.ps1`/`.js` extension or `@version` (npx), then any flags, then a person command as a whole
 * word. Case-insensitive: macOS and Windows file systems run `JubarteAI` as well.
 */
const PERSON_CALL = new RegExp(
  `(?:^|[\\s;&|()<>{}\`$=/\\\\])jubarteai(?:\\.(?:cmd|exe|ps1|js|mjs))?(?:@\\S*)?(?:\\s+-{1,2}[^\\s;&|()<>]*)*\\s+(${PERSON_ALTERNATION})(?=$|[\\s;&|()<>{}\`])`,
  "i",
);

/**
 * The text a shell would see once quoting is undone: quotes dropped (`jubarteai "login"` → `jubarteai login`) and a
 * backtick spaced out. A backslash is a POSIX escape (`jubarteai \login`) but a Windows path separator
 * (`C:\npm\jubarteai.cmd login`), so both readings are returned.
 */
function unquoted(text: string): [string, string] {
  const bare = text.replace(/["']/g, "").replace(/`/g, " ` ");
  return [bare.replace(/\\/g, ""), bare.replace(/\\/g, "/")];
}

/** The person command a piece of command text runs, or null. */
export function personCommandIn(text: string): string | null {
  for (const reading of unquoted(text)) {
    const match = PERSON_CALL.exec(reading);
    if (match !== null) return (match[1] ?? "").toLowerCase();
  }
  return null;
}

/** Every string anywhere in `value` (tool arguments nest differently per harness); a JSON-looking string is parsed first. */
function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof value === "string") {
    out.push(value);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        stringsIn(JSON.parse(trimmed) as unknown, out, depth + 1);
      } catch {
        // Not JSON: the string itself was already collected.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) stringsIn(item, out, depth + 1);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The tool arguments as an object when they are one (camelCase `toolArgs` may be a JSON string), else null. */
function argsObject(args: unknown): Record<string, unknown> | null {
  if (isRecord(args)) return args;
  if (typeof args !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether the call runs a shell command: a known shell tool name, or arguments with a string `command`. */
function isShellCall(toolName: unknown, args: unknown): boolean {
  if (typeof toolName === "string" && SHELL_TOOL_NAMES.includes(toolName.toLowerCase())) return true;
  return typeof argsObject(args)?.["command"] === "string";
}

function deny(command: string): ToolGuardOutput {
  return {
    permissionDecision: "deny",
    permissionDecisionReason:
      `jubarteai ${command} changes the saved account, the repo binding or harness files, so an agent may not run it. ` +
      `Ask the person to run "jubarteai ${command}" themselves in a terminal. ` +
      `(If this command only mentions it, for example in a commit message, reword it.)`,
  };
}

/**
 * The decision for one `preToolUse` payload (camelCase `toolName`/`toolArgs` or snake_case `tool_name`/`tool_input`).
 * `truncated` means stdin went past the read cap: the prefix is then scanned as plain text, so padding a command can't
 * slip it past the guard. Anything unparsable or unrecognised is `{}`: the guard never blocks a call it can't read.
 */
export function toolGuardDecision(raw: string, truncated = false): ToolGuardOutput {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (!truncated) return {};
    const command = personCommandIn(raw);
    return command === null ? {} : deny(command);
  }
  if (!isRecord(payload)) return {};
  const toolName = payload["toolName"] ?? payload["tool_name"];
  const args = payload["toolArgs"] ?? payload["tool_input"];
  if (!isShellCall(toolName, args)) return {};
  for (const text of stringsIn(args)) {
    const command = personCommandIn(text);
    if (command !== null) return deny(command);
  }
  return {};
}
