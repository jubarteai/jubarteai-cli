import { describe, expect, it } from "vitest";

import { COMMANDS } from "../cli/commands.js";
import { AGENT_COMMANDS, AGENT_RULE_WORDS, INFO_FLAGS, PERSON_COMMANDS, PERSON_COMMAND_LIST, agentCommandPattern, commandPattern, personCommandPattern } from "./agent-commands.js";
import { SHELL_TOOL_ENTRIES } from "./gemini-cli.js";
import { COMMAND_PATTERNS } from "./opencode.js";

const APPROVED = [
  "jubarteai search-knowledge --query x",
  "jubarteai connect",
  "jubarteai inbox --wait 30",
  "jubarteai call search_knowledge --json @args.json",
  "jubarteai status",
  "jubarteai --help",
  "jubarteai --version",
];
const PERSON = [
  "jubarteai login --with-token",
  "jubarteai link --workspace x",
  "jubarteai init --yes",
  "jubarteai update",
  "jubarteai logout",
  "jubarteai --yes init",
  "jubarteai --workspace x link",
];

describe("agent and person commands", () => {
  it("classify every registered command except the internal hook", () => {
    const classified = new Set<string>([...AGENT_COMMANDS, ...PERSON_COMMANDS]);
    const unclassified = COMMANDS.filter((command) => command.group !== "internal" && !classified.has(command.name)).map((c) => c.name);
    expect(unclassified).toEqual([]);
    // A name in both lists would make the allowlist approve a person command.
    expect(AGENT_COMMANDS.filter((name) => (PERSON_COMMANDS as readonly string[]).includes(name))).toEqual([]);
    // Every listed command exists.
    const names = new Set(COMMANDS.map((command) => command.name));
    for (const name of [...AGENT_COMMANDS, ...PERSON_COMMANDS]) expect(names.has(name), name).toBe(true);
  });

  it("the agent pattern approves the tool commands and info flags, never a person command", () => {
    const agent = new RegExp(agentCommandPattern());
    for (const line of APPROVED) expect(agent.test(line), line).toBe(true);
    for (const line of PERSON) expect(agent.test(line), line).toBe(false);
    // A prefix of a command name is not that command.
    expect(agent.test("jubarteai connectx")).toBe(false);
    expect(agent.test("jubarteai")).toBe(false);
  });

  it("the person pattern matches each person command and no agent command", () => {
    const person = new RegExp(personCommandPattern());
    for (const name of PERSON_COMMANDS) {
      expect(person.test(`jubarteai ${name}`)).toBe(true);
      expect(person.test(`jubarteai ${name} --yes`)).toBe(true);
    }
    for (const line of APPROVED) expect(person.test(line), line).toBe(false);
  });

  it("uses no lookaround, so the same text is a valid Rust regex (Zed)", () => {
    for (const source of [agentCommandPattern(), personCommandPattern()]) expect(source).not.toMatch(/\(\?[=!<]/);
  });

  it("escapes the program name", () => {
    expect(new RegExp(commandPattern("a.b", ["x"])).test("aXb x")).toBe(false);
    expect(INFO_FLAGS).toEqual(["--help", "-h", "--version", "-v"]);
  });

  it("no pre-approvable word is a prefix of a person command (prefix matchers have no word boundary)", () => {
    // The reverse (update-knowledge starts with update) only makes a prefix-matched deny entry stricter: never an approval.
    for (const word of AGENT_RULE_WORDS) {
      for (const person of PERSON_COMMANDS) expect(person.startsWith(word), `${word} / ${person}`).toBe(false);
    }
    expect(PERSON_COMMAND_LIST).toBe("login, logout, link, init, update and uninstall");
  });

  it("no OpenCode glob matches a person command line (`*` matches any characters, none included)", () => {
    const glob = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s");
    const globs = COMMAND_PATTERNS.map(glob);
    for (const line of [...PERSON, ...PERSON_COMMANDS.map((c) => `jubarteai ${c}`)]) expect(globs.some((g) => g.test(line)), line).toBe(false);
    for (const line of APPROVED) expect(globs.some((g) => g.test(line)), line).toBe(true);
  });

  it("Gemini and OpenCode pre-approve `jubarteai --help` and `--version`, which the skill tells every agent to run", () => {
    expect(SHELL_TOOL_ENTRIES).toContain("run_shell_command(jubarteai --help)");
    expect(SHELL_TOOL_ENTRIES).toContain("run_shell_command(jubarteai --version)");
    expect(COMMAND_PATTERNS).toContain("jubarteai --help*");
    expect(COMMAND_PATTERNS).toContain("jubarteai --version*");
  });
});
