import { describe, expect, it } from "vitest";

import { AGENT_COMMANDS, PERSON_COMMANDS } from "../harness/agent-commands.js";
import { SHELL_TOOL_MATCHER, personCommandIn, toolGuardDecision } from "./tool-guard.js";

/** A Copilot CLI payload: camelCase, `toolArgs` as the JSON string the runtime sends for a shell call. */
const camel = (command: string, toolName = "bash"): string => JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/r", toolName, toolArgs: JSON.stringify({ command, description: "x" }) });
/** The PascalCase `PreToolUse` alias: snake_case, Claude tool name, parsed `tool_input`. */
const snake = (command: string, toolName = "Bash"): string => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: toolName, tool_input: { command } });

const denied = (raw: string): boolean => "permissionDecision" in toolGuardDecision(raw);

/** Spellings an agent (or an injected prompt) could use to run a person command. `%s` is the command; a function builds the line. */
const PERSON_FORMS: ReadonlyArray<string | ((command: string) => string)> = [
  "jubarteai %s",
  "jubarteai %s --with-token",
  "echo jba_x | jubarteai %s --with-token",
  "jubarteai inbox && jubarteai %s",
  "jubarteai inbox;jubarteai %s",
  "jubarteai inbox || jubarteai %s",
  "echo $(jubarteai %s)",
  "echo `jubarteai %s`",
  "(jubarteai %s)",
  'jubarteai "%s"',
  "jubarteai '%s' --yes",
  'j"ubarteai" %s',
  "jubarteai \\%s",
  "/usr/local/bin/jubarteai %s",
  '"/opt/node/bin/node" "/opt/jubarteai/bin/jubarteai.js" %s',
  "npx -y jubarteai@latest %s",
  "C:\\Users\\me\\AppData\\Roaming\\npm\\jubarteai.cmd %s",
  "& jubarteai %s",
  "JubarteAI %s",
  "jubarteai --yes %s",
  'bash -c "jubarteai %s"',
  "cd /r\njubarteai %s",
  // A path lookup (review R-S15): the program is followed by `)` or a backtick, not whitespace.
  "$(which jubarteai) %s",
  '"$(command -v jubarteai)" %s --yes',
  "`command -v jubarteai` %s",
  "& (Get-Command jubarteai) %s",
  // bash ANSI-C and locale quoting.
  "jubarteai $'%s'",
  'jubarteai $"%s"',
  // PowerShell's backtick escape inside the word.
  (command) => `jubarteai ${command.slice(0, 1)}\`${command.slice(1)}`,
  (command) => `& jub\`arteai ${command}`,
  "npm exec jubarteai -- %s",
  // npm exec / npm x parse flags after the package name themselves, so a flag with a value or a version range still
  // runs the person command (review R-S17).
  "npm exec jubarteai --loglevel=silent %s",
  "npm exec --yes jubarteai --registry=https://registry.npmjs.org %s",
  "npm x jubarteai --prefer-online=true %s",
  'npx "jubarteai@>=1" %s',
  "npx 'jubarteai@<2' %s",
  "npm exec jubarteai@https://x/y.tgz %s",
  // npm also takes a flag's value from the next word (review R-S18): npm 11 runs `login` for each of these.
  "npm exec jubarteai --loglevel silent %s",
  "npm x jubarteai --cache /tmp/c %s",
  "npm exec jubarteai --loglevel silent --cache /tmp/c %s",
  "npm exec jubarteai --yes -- %s",
  // A package spec or flag value that itself names the package is one word and hides nothing (review R-S19).
  "npx jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz %s",
  "npx --yes jubarteai@file:/tmp/jubarteai-1.0.0.tgz %s",
  "npm exec jubarteai --prefix=../jubarteai-cli %s",
  "npm exec jubarteai --cache=/tmp/my-jubarteai-cache %s",
  "npm exec jubarteai --prefix ../jubarteai-cli %s",
  // Redirection or a brace right after the command word.
  "{ jubarteai %s>/dev/null; }",
];

const render = (form: string | ((command: string) => string), command: string): string => (typeof form === "string" ? form.replace("%s", command) : form(command));

describe("toolGuardDecision: denies every person command, whatever the spelling", () => {
  for (const command of PERSON_COMMANDS) {
    for (const form of PERSON_FORMS) {
      const line = render(form, command);
      it(`${JSON.stringify(line)}`, () => {
        const camelOut = toolGuardDecision(camel(line));
        expect(camelOut).toEqual({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining(`jubarteai ${command}`) });
        expect(denied(snake(line))).toBe(true);
        expect(denied(camel(line, "powershell"))).toBe(true);
      });
    }
  }

  it("reads toolArgs given as an object as well as a JSON string", () => {
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: { command: "jubarteai login" } }))).toBe(true);
  });

  it("a tool with another name counts as a shell when its arguments carry a command string", () => {
    expect(denied(JSON.stringify({ toolName: "run_in_terminal", toolArgs: { command: "jubarteai init --yes" } }))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "someNewShell", toolArgs: { command: "jubarteai link" } }))).toBe(true);
  });

  it("finds a command however much padding comes before it (the payload is parsed whole; review R-S14)", () => {
    expect(denied(camel(`echo ${"x".repeat(2 * 1024 * 1024)}; jubarteai login`))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ description: "y".repeat(2 * 1024 * 1024), command: "jubarteai link" }) }))).toBe(true);
  });

  it("denies a payload the hook read only in part, whatever the part holds", () => {
    expect(toolGuardDecision('{"toolName":"bash","toolArgs":"{\\"command\\":\\"echo hi', true)).toEqual({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("too large") });
  });
});

describe("toolGuardDecision: linear time (review R-S13)", () => {
  /** Milliseconds `fn` takes. The bounds below are far above linear time and far below the old exponential/quadratic. */
  const time = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it("a run of flag tokens before a failed match, then a later person command: a deny, quickly", () => {
    for (const flag of ["--a", "-a", "--", "-"]) {
      const line = `echo jubarteai ${`${flag} `.repeat(60)}x; jubarteai login`;
      let out: unknown;
      expect(time(() => (out = toolGuardDecision(camel(line)))), flag).toBeLessThan(1_000);
      expect(out, flag).toMatchObject({ permissionDecision: "deny" });
    }
  });

  it("a long run of flags with values, then a person command: a deny, quickly (review R-S17)", () => {
    const line = `echo jubarteai ${"--a=b ".repeat(60_000)}x; jubarteai ${"--a=b ".repeat(60_000)}login`;
    let out: unknown;
    expect(time(() => (out = toolGuardDecision(camel(line))))).toBeLessThan(2_000);
    expect(out).toMatchObject({ permissionDecision: "deny" });
  });

  it("one long token holding many program names (paths, versions, lookups) stays linear", () => {
    const units = ["--x/jubarteai ", "jubarteai@x/", "/jubarteai/", "--x=jubarteai ", "$(jubarteai)", " jubarteai \t", "--x=/jubarteai ", "jubarteai@>=", "jubarteai --a=b ", "-->jubarteai ", "jubarteai@jubarteai@", "jubarteai --a b ", "jubarteai --a login ", "=jubarteai --a b c ", "jubarteai -- ", "jubarteai@x/jubarteai-1.tgz --a ", "jubarteai --a jubarteai ", "x/jubarteai-cli "];
    for (const unit of units) {
      const line = unit.repeat(Math.ceil(400_000 / unit.length));
      expect(time(() => toolGuardDecision(camel(line))), unit).toBeLessThan(2_000);
    }
  });
});

describe("toolGuardDecision: makes no decision otherwise", () => {
  const agentLines = [...AGENT_COMMANDS.map((command) => `jubarteai ${command} --agent 11111111-1111-4111-8111-111111111111`), "jubarteai --help", "jubarteai --version", "jubarteai"];

  for (const line of agentLines) {
    it(`${JSON.stringify(line)} → {}`, () => {
      expect(toolGuardDecision(camel(line))).toEqual({});
      expect(toolGuardDecision(snake(line))).toEqual({});
    });
  }

  it("an agent command after npm's flags, with or without a value or `--` (review R-S18)", () => {
    for (const line of [
      "npm exec jubarteai -- search-knowledge --query update",
      "npm exec jubarteai --yes search-knowledge --query update",
      "npm exec jubarteai --loglevel silent inbox --agent 11111111-1111-4111-8111-111111111111",
      "npx jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz inbox",
      "npm exec jubarteai --prefix=../jubarteai-cli -- echo-current-task --title login",
    ]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("other programs and lookalike words", () => {
    for (const line of ["git status", "jubarteai-cli login", "myjubarteai login", "jubarteai loginx", "jubarteai inbox --login", "echo jubarteai", "npm run login", "ls /tmp/my-jubarteai-cache login", "jubarteai; login", "jubarteai | login", "jubarteai@1 inbox && echo login", "jubarteai search-knowledge --query \"how does init work\""]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("a non-shell tool that only mentions a person command (an edit, a new file, a view)", () => {
    expect(toolGuardDecision(JSON.stringify({ toolName: "edit", toolArgs: { path: "README.md", old_str: "a", new_str: "run jubarteai login" } }))).toEqual({});
    expect(toolGuardDecision(JSON.stringify({ toolName: "create", toolArgs: { path: "setup.sh", file_text: "jubarteai init --yes" } }))).toEqual({});
    expect(toolGuardDecision(snake("jubarteai login", "Write").replace('"command"', '"content"'))).toEqual({});
  });

  it("anything it can't read: empty, not JSON, not an object, no tool", () => {
    for (const raw of ["", "not json", "[]", "null", "42", JSON.stringify({ toolArgs: { path: "x" } })]) {
      expect(toolGuardDecision(raw), raw).toEqual({});
    }
    expect(toolGuardDecision("jubarteai login")).toEqual({});
  });

  it("never answers allow, for any line", () => {
    const lines = [...agentLines, ...PERSON_COMMANDS.flatMap((command) => PERSON_FORMS.map((form) => render(form, command)))];
    for (const line of lines) {
      const out = toolGuardDecision(camel(line));
      expect(Object.keys(out).length === 0 || (out as { permissionDecision?: string }).permissionDecision === "deny", line).toBe(true);
    }
  });
});

describe("personCommandIn and the matcher", () => {
  it("names the command it found, lowercased", () => {
    expect(personCommandIn("JUBARTEAI LOGIN")).toBe("login");
    expect(personCommandIn("jubarteai update --check")).toBe("update");
    expect(personCommandIn("jubarteai inbox")).toBeNull();
  });

  it("the entry's matcher names the Copilot runtime's shell tools and is a valid anchored regex", () => {
    const re = new RegExp(`^(?:${SHELL_TOOL_MATCHER})$`);
    expect(re.test("bash")).toBe(true);
    expect(re.test("powershell")).toBe(true);
    expect(re.test("edit")).toBe(false);
  });
});
