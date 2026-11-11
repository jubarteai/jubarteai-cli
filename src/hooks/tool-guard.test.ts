import { describe, expect, it } from "vitest";

import { AGENT_COMMANDS, PERSON_COMMANDS } from "../harness/agent-commands.js";
import { SHELL_TOOL_MATCHER, personCommandIn, toolGuardDecision } from "./tool-guard.js";

/** A Copilot CLI payload: camelCase, `toolArgs` as the JSON string the runtime sends for a shell call. */
const camel = (command: string, toolName = "bash"): string => JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/r", toolName, toolArgs: JSON.stringify({ command, description: "x" }) });
/** The PascalCase `PreToolUse` alias: snake_case, Claude tool name, parsed `tool_input`. */
const snake = (command: string, toolName = "Bash"): string => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: toolName, tool_input: { command } });

const denied = (raw: string, truncated = false): boolean => "permissionDecision" in toolGuardDecision(raw, truncated);

/** Spellings an agent (or an injected prompt) could use to run a person command. `%s` is the command. */
const PERSON_FORMS: readonly string[] = [
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
];

describe("toolGuardDecision: denies every person command, whatever the spelling", () => {
  for (const command of PERSON_COMMANDS) {
    for (const form of PERSON_FORMS) {
      const line = form.replace("%s", command);
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

  it("scans a truncated payload as plain text, so padding can't push a command past the read cap", () => {
    const prefix = `{"toolName":"bash","toolArgs":"{\\"command\\":\\"jubarteai login --with-token ${"x".repeat(50)}`;
    expect(denied(prefix, true)).toBe(true);
    expect(denied(`{"toolName":"bash","toolArgs":"{\\"command\\":\\"jubarteai inbox ${"x".repeat(50)}`, true)).toBe(false);
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

  it("other programs and lookalike words", () => {
    for (const line of ["git status", "jubarteai-cli login", "myjubarteai login", "jubarteai loginx", "jubarteai inbox --login", "echo jubarteai", "npm run login", "jubarteai search-knowledge --query \"how does init work\""]) {
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
    const lines = [...agentLines, ...PERSON_COMMANDS.flatMap((command) => PERSON_FORMS.map((form) => form.replace("%s", command)))];
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
