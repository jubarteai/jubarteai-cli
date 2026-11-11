// `jubarteai hook pre-tool-use` (spec I6, §6.3, review R-S12): the deny-only guard registered as a `preToolUse` hook in
// the shared ~/.copilot/hooks/jubarteai.json, which Copilot CLI and VS Code's Copilot harness both read.
//
// Neither harness sets a variable the CLI could use to refuse login, logout, link, init or update from an agent, and
// Copilot CLI's rules match programs other than git and gh by name, so a session approval of any jubarteai command
// approves those five too. GitHub's hooks reference: "For `preToolUse`, if any hook returns "deny", the tool is
// blocked", whatever was approved. So this hook answers a deny for a shell tool call whose command names one of the
// five, and `{}` (no decision: the normal permission flow) for everything else. It never answers "allow".
//
// It is best effort, not a sandbox: a command hidden in a script file or a shell variable is not seen, nor a program word
// the shell builds by glob or brace expansion (`jubarteai* login`, `/opt/homebrew/bin/jubartea? login`, `{jubarteai,} login`,
// `npx ./*.tgz login`; spec I6): only a glob for the npm pack tarball is matched. Quoting is undone before matching,
// so `jubarteai "login"`, `j"ubarteai" login`, `jubarteai \login`, `jubarteai $'login'` and PowerShell's
// ``jubarteai l`ogin`` match, and the program may follow any shell separator or close a lookup, so chained, `$(…)`,
// backtick, path, `$(command -v jubarteai) login` and `(Get-Command jubarteai) login` forms match too. Matching errs
// toward a deny: text that only mentions a person command after the program name (a commit message, the title or
// query of the agent's own `jubarteai create-knowledge`/`search-knowledge`, a directory named jubarteai followed by
// `init`) is refused as well, and the reason says to reword it.
//
// The matcher is a word-level scan, not one regex (review R-S13, R-S17, R-S18, R-S19): each reading is split once into
// words and shell separators and walked left to right, so it is linear by construction and one long command can't keep
// the hook busy until the harness's timeout lets the call through (GitHub fails a timed-out `preToolUse` hook open).
// After the program come flags the way `npm exec`/`npm x` parse them after the package name: `--flag=value`, or
// `--flag value` with the value as the next word (a bare `--` takes none), so `npm exec jubarteai --loglevel silent
// login` runs the person command and is denied. A program word is tested on its own, so a package spec or flag value
// that itself names the package (`npx jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz login`,
// `--prefix=../jubarteai-cli`) is one word and can't hide the command after it. The package's `npm pack` tarball is the
// program too (`npx ./jubarteai-0.1.0.tgz login`), and a redirection between the program and its command is skipped
// (`jubarteai 2>/dev/null login`). The work is bounded: arguments past a scan budget (each string's characters plus a
// fixed cost per value walked and per JSON parse attempt) or nested too deep are denied as too large to check rather
// than scanned level after level or string after string (review rounds 9 and 11).
//
// Pure: no network, no file reads, no binding lookup. It runs in every repo, bound or not, because login and logout
// change user-level credentials (the stated exception to I7's bound-repo rule).
import { GUARD_SCAN_BUDGET, GUARD_SCAN_MAX_DEPTH, GUARD_SCAN_PARSE_COST, GUARD_SCAN_VALUE_COST } from "../constants.js";
import { AGENT_COMMANDS, PERSON_COMMANDS } from "../harness/agent-commands.js";

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

/** The commands the guard refuses. */
const PERSON = new Set<string>(PERSON_COMMANDS);

/** The agent commands: a word after a flag that names one is the subcommand, not the flag's value. */
const AGENT = new Set<string>(AGENT_COMMANDS.map((command) => command.toLowerCase()));

/**
 * A reading split into words and shell separators (whitespace dropped): one pass, linear. A single character class
 * under `+`, never an alternation group: V8 keeps a backtrack entry per repetition of a group, so a group here would
 * overflow the stack on a multi-megabyte word, and the hook fails open on an exception.
 */
const PIECES = /[;&|()`]|[^\s;&|()`]+/g;

/**
 * A redirection's own `&` or `|` (`2>&1`, `>&2`, `&>/dev/null`, `>|out`), folded into a plain `>`/`<` before the split
 * so the redirection stays one word instead of reading as a separator. Linear: no quantifier.
 */
const REDIRECTION_AMP = /([<>])[&|]|&(>)/g;

/** The one-character pieces PIECES returns as separators. */
const SEPARATORS = new Set([";", "&", "|", "(", ")", "`"]);

/** Separators the program may be followed by when it closes a lookup: `$(which jubarteai) login`, a backtick. */
const CLOSERS = new Set([")", "`"]);

/**
 * A word that runs `jubarteai`: the name at the word's start or after `<`, `>`, `{`, `}`, `$`, `=` or a path separator,
 * with an optional `.cmd`/`.exe`/`.ps1`/`.js`/`.mjs` extension or an `@version` (npx: a range, a tag or a tarball URL,
 * whatever it holds) and nothing else after it. So `/usr/local/bin/jubarteai`, `C:/…/jubarteai.cmd`, `jubarteai@>=1` and
 * `jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz` are the program, and `jubarteai-cli`,
 * `myjubarteai` and `/tmp/my-jubarteai-cache` are not. Case-insensitive: macOS and Windows file systems run `JubarteAI`
 * as well. Tested on one word at a time; each failed attempt ends right after the name and `.*` runs only on a match,
 * so it is linear in the word.
 */
const PROGRAM_WORD = /(?:^|[<>{}$=/\\])jubarteai(?:\.(?:cmd|exe|ps1|js|mjs))?(?:@.*)?$/i;

/**
 * The file name `npm pack` gives the package, `jubarteai-<version>.tgz`: `npx ./jubarteai-0.1.0.tgz login`,
 * `npx file:/tmp/jubarteai-0.1.0.tgz login` or a registry tarball URL run the CLI's one bin without `jubarteai` as a
 * word of its own (review R-S2, round 9). A glob in place of the version (`npx ./jubarteai-*.tgz login`) is the
 * program too, since bash expands it before npx starts (review R-S2, round 10). Tested on the word's last segment
 * (after `:`, a path separator or a redirection/brace/`$`/`=` character), so `jubarteai-cli-0.1.0.tgz` and
 * `my-jubarteai-1.0.0.tgz` are not the program. Any other glob or brace expansion is not seen, for the tarball
 * (`./*.tgz`, `./jubarte?i-0.1.0.tgz`) or the program (`jubarteai*`, `{jubarteai,}`): spec I6 records it rather than
 * widening the match, since a glob can't be told from a mention without expanding it (review round 11 R-S2, round 12
 * R-S3).
 */
const TARBALL_SEGMENT = /^jubarteai(?:-[\d*?[]|[*?[]).*\.tgz$/i;

/** Where a word's last segment starts: after the last character a program name may follow. */
const SEGMENT_START = /[<>{}$=/\\:]/;

/** Whether a word runs `jubarteai`: the program name (PROGRAM_WORD) or the package's npm pack tarball. */
function isProgramWord(word: string): boolean {
  if (PROGRAM_WORD.test(word)) return true;
  if (!/\.tgz$/i.test(word)) return false;
  let start = word.length;
  while (start > 0 && !SEGMENT_START.test(word.charAt(start - 1))) start -= 1;
  return TARBALL_SEGMENT.test(word.slice(start));
}

/**
 * A redirection word (`2>/dev/null`, `>out`, `<in`, `2>&1`, `&>log`, PowerShell's `*>$null`): bash and PowerShell
 * accept one anywhere in a simple command, so between the program and its command it is skipped, not read as the
 * command (review R-S3, round 9). Anchored at the word's start, so linear.
 */
const REDIRECTION = /^(?:\d+|\*)?[<>]/;

/** A redirection operator standing alone (`2>`, `>>`, `*>`, `>&` once folded): its target is the next word, skipped too. */
const BARE_REDIRECTION = /^(?:\d+|\*)?[<>]+$/;

/** A word's command part, lowercased: what comes before a redirection or brace (`login>out` is `login`). */
function commandPart(word: string): string {
  const cut = word.search(/[<>{}]/);
  return (cut === -1 ? word : word.slice(0, cut)).toLowerCase();
}

/**
 * Where the scan is: outside a jubarteai call, right after the program (a lookup's `)` or backtick may follow), among
 * its flags, or right after a flag that may take the next word as its value.
 */
type ScanState = "outside" | "program" | "flags" | "flagValue";

/** The person command one reading runs, or null. One left-to-right pass over its pieces. */
function scanReading(reading: string): string | null {
  let state: ScanState = "outside";
  // A bare redirection operator was just skipped, so this word is its target (`jubarteai 2> /dev/null login`).
  let redirectionTarget = false;
  for (const [piece] of reading.replace(REDIRECTION_AMP, "$1$2").matchAll(PIECES)) {
    // A program word starts a new call wherever it appears, a flag's value included, so no piece is walked twice.
    if (isProgramWord(piece)) {
      state = "program";
      redirectionTarget = false;
      continue;
    }
    if (state === "outside") continue;
    if (SEPARATORS.has(piece)) {
      state = state === "program" && CLOSERS.has(piece) ? "flags" : "outside";
      redirectionTarget = false;
      continue;
    }
    if (redirectionTarget) {
      redirectionTarget = false;
      continue;
    }
    if (REDIRECTION.test(piece)) {
      redirectionTarget = BARE_REDIRECTION.test(piece);
      continue;
    }
    if (piece.startsWith("-")) {
      // `--flag=value` carries its value and a bare `--` takes none; `--flag` may take the next word.
      state = piece === "--" || piece.includes("=") ? "flags" : "flagValue";
      continue;
    }
    const command = commandPart(piece);
    if (PERSON.has(command)) return command;
    // After a flag, a word that is not a subcommand is that flag's value (`--loglevel silent`); scan on past it.
    if (state === "flagValue" && !AGENT.has(command)) {
      state = "flags";
      continue;
    }
    // The subcommand is an agent command, or something else: no decision for this call.
    state = "outside";
  }
  return null;
}

/**
 * The texts a shell could run once quoting is undone: quotes dropped (`jubarteai "login"` → `jubarteai login`), with a
 * `$` before a quote dropped too (bash's `$'login'`). A backslash is a POSIX escape (`jubarteai \login`) but a Windows
 * path separator (`C:\npm\jubarteai.cmd login`), and a backtick is a POSIX command substitution but PowerShell's escape
 * character (``l`ogin`` is `login`), so three readings are returned: POSIX (backslashes dropped, backticks spaced out),
 * Windows paths (backslashes as `/`), and PowerShell (backticks dropped, backslashes as `/`).
 */
function readings(text: string): [string, string, string] {
  const bare = text.replace(/\$(?=["'])/g, "").replace(/["']/g, "");
  const spaced = bare.replace(/`/g, " ` ");
  return [spaced.replace(/\\/g, ""), spaced.replace(/\\/g, "/"), bare.replace(/`/g, "").replace(/\\/g, "/")];
}

/** The person command a piece of command text runs, or null. */
export function personCommandIn(text: string): string | null {
  for (const reading of readings(text)) {
    const command = scanReading(reading);
    if (command !== null) return command;
  }
  return null;
}

/** The strings collected from tool arguments for scanning, and what collecting them cost (GUARD_SCAN_BUDGET's units). */
interface Collected {
  strings: string[];
  cost: number;
}

/**
 * Whether a trimmed string could parse as a JSON object or array: it starts and ends with a matching bracket. Anything
 * else would only throw, and a thrown exception is the costliest step of a parse attempt (review R-S1, round 11).
 */
function looksLikeJsonContainer(trimmed: string): boolean {
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  return (first === "[" && last === "]") || (first === "{" && last === "}");
}

/**
 * Every string anywhere in `value`, object keys included (tool arguments nest differently per harness). A JSON-looking
 * string that parses as an object or array is walked into as well, so what it holds is scanned unescaped
 * (`"jubarteai \u006cogin"`). Below the top level its raw text is scanned too: a shell runs that text, not the parsed
 * strings, and re-reads `$(…)` or a backtick across JSON string boundaries, so `["$(npm exec jubarteai --cache ", " login)"]`
 * runs `login` although no single string holds it (review R-S1, round 10). The top level is the arguments themselves
 * (Copilot CLI's `toolArgs` JSON string), the runtime's wrapper rather than anything a shell runs, so it is only parsed.
 * Every value walked costs GUARD_SCAN_VALUE_COST, every string its length on top, and every parse attempt
 * GUARD_SCAN_PARSE_COST; false means the arguments cost more than `budget` or nest deeper than GUARD_SCAN_MAX_DEPTH.
 * JSON nested level after level inside a large argument, or millions of tiny strings, would otherwise push the work into
 * the hook's timeout, which fails open, and a value never walked could hold the command (review R-S1, rounds 9 and 11).
 * The cost is charged before the work it stands for, so a payload over budget is refused after at most a budget's work.
 */
function collectStrings(value: unknown, into: Collected, budget: number, depth = 0): boolean {
  if (depth > GUARD_SCAN_MAX_DEPTH) return false;
  into.cost += GUARD_SCAN_VALUE_COST;
  if (typeof value === "string") {
    into.cost += value.length;
    if (into.cost > budget) return false;
    const trimmed = value.trim();
    if (looksLikeJsonContainer(trimmed)) {
      into.cost += GUARD_SCAN_PARSE_COST;
      if (into.cost > budget) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not JSON (a brace group, a test expression): scanned as it is, below.
      }
      if (parsed !== null && typeof parsed === "object") {
        if (depth > 0) into.strings.push(value);
        return collectStrings(parsed, into, budget, depth + 1);
      }
    }
    into.strings.push(value);
    return true;
  }
  if (into.cost > budget) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every((item) => collectStrings(item, into, budget, depth + 1));
  return Object.entries(value).every(([key, item]) => collectStrings(key, into, budget, depth + 1) && collectStrings(item, into, budget, depth + 1));
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

/** Whether the call runs a shell command: a known shell tool name, or arguments (`argsObject`'s) with a string `command`. */
function isShellCall(toolName: unknown, parsedArgs: Record<string, unknown> | null): boolean {
  if (typeof toolName === "string" && SHELL_TOOL_NAMES.includes(toolName.toLowerCase())) return true;
  return typeof parsedArgs?.["command"] === "string";
}

/**
 * The strings in the tool arguments, or null past the scan budget or nesting cap. camelCase `toolArgs` sent as a JSON
 * string was already parsed by argsObject, so it is charged as collectStrings would charge it (the string and one parse
 * attempt) and its object walked one level down, rather than parsed a second time.
 */
function argumentStrings(args: unknown, parsedArgs: Record<string, unknown> | null, budget: number): string[] | null {
  const collected: Collected = { strings: [], cost: 0 };
  if (typeof args === "string" && parsedArgs !== null) {
    collected.cost = GUARD_SCAN_VALUE_COST + args.length + GUARD_SCAN_PARSE_COST;
    if (collected.cost > budget || !collectStrings(parsedArgs, collected, budget, 1)) return null;
  } else if (!collectStrings(args, collected, budget)) {
    return null;
  }
  return collected.strings;
}

function deny(command: string): ToolGuardOutput {
  return {
    permissionDecision: "deny",
    permissionDecisionReason:
      `jubarteai ${command} changes the saved account, the repo binding or harness files, so an agent may not run it. ` +
      `Ask the person to run "jubarteai ${command}" themselves in a terminal. ` +
      `(If this command only mentions it, for example in a commit message or the text of a jubarteai knowledge entry or search, ` +
      `reword it, e.g. "the ${command} command".)`,
  };
}

/** The answer for a payload over the guard's read cap or scan budget: what it can't read, it can't clear. */
const TOO_LARGE: ToolGuardOutput = Object.freeze({
  permissionDecision: "deny",
  permissionDecisionReason:
    "This tool call is too large (or too deeply nested) for the JubarteAI guard to check for jubarteai login, logout, link, init or update. " +
    "Split the command into smaller ones.",
});

/**
 * The decision for one `preToolUse` payload (camelCase `toolName`/`toolArgs` or snake_case `tool_name`/`tool_input`).
 * `tooLarge` means stdin went past the guard's read cap (GUARD_INPUT_MAX_BYTES, far beyond what a model emits as one
 * tool call): the unread rest could hold a person command anywhere, so the call is denied rather than scanned in part
 * (review R-S14). Below the cap the whole payload is read and parsed, however the command is padded. A shell call whose
 * arguments cost more than `scanBudget` to scan (GUARD_SCAN_BUDGET: characters plus a fixed cost per value and per
 * JSON parse attempt), or nest deeper than GUARD_SCAN_MAX_DEPTH, is denied the same way, so the scan stays bounded
 * (review R-S1, rounds 9 and 11). Anything
 * unparsable or unrecognised is `{}`: the guard never blocks a call it can read and finds nothing in.
 */
export function toolGuardDecision(raw: string, tooLarge = false, scanBudget = GUARD_SCAN_BUDGET): ToolGuardOutput {
  if (tooLarge) return TOO_LARGE;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(payload)) return {};
  const toolName = payload["toolName"] ?? payload["tool_name"];
  const args = payload["toolArgs"] ?? payload["tool_input"];
  const parsedArgs = argsObject(args);
  if (!isShellCall(toolName, parsedArgs)) return {};
  try {
    const strings = argumentStrings(args, parsedArgs, scanBudget);
    if (strings === null) return TOO_LARGE;
    for (const text of strings) {
      const command = personCommandIn(text);
      if (command !== null) return deny(command);
    }
  } catch {
    // A shell call the scan couldn't finish (an engine limit such as the stack or memory) is not cleared: the hook's
    // own catch would answer `{}` and let it through.
    return TOO_LARGE;
  }
  return {};
}
