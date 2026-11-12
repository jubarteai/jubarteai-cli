import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { TOOL_SPECS } from "../mcp/tool-specs.js";
import { COMMANDS } from "./commands.js";
import { renderHelp, routeWith } from "./router.js";

function sink(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => text };
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await routeWith(COMMANDS, argv, { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd: "/work" });
  return { code, out: out.text(), err: err.text() };
}

const ACCOUNT = ["login", "logout", "status"];
const TOOL_COMMAND_NAMES = TOOL_SPECS.map((spec) => spec.command);

describe("COMMANDS", () => {
  it("has unique, well-formed names and a valid group", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(["account", "tools", "setup", "internal"]).toContain(command.group);
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("registers the account commands, connect, exactly the spec 5.3 tool commands, call and inbox, in help order", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([...ACCOUNT, ...TOOL_COMMAND_NAMES, "call", "inbox"]);
    expect(TOOL_COMMAND_NAMES).toHaveLength(16);
    expect(TOOL_COMMAND_NAMES[0]).toBe("connect");
    expect(COMMANDS.filter((command) => command.group === "account").map((command) => command.name)).toEqual(ACCOUNT);
  });

  it("lists every registered command in --help", async () => {
    const { code, out, err } = await run(["--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const command of COMMANDS) {
      expect(out).toMatch(new RegExp(`^  ${command.name} +\\S`, "m"));
    }
    expect(out.indexOf("Account:")).toBeLessThan(out.indexOf("Tools:"));
    expect(renderHelp(COMMANDS, { all: false })).toBe(out);
  });

  it.each(COMMANDS.map((command) => command.name))("%s --help prints its usage and exits 0", async (name) => {
    const { code, out, err } = await run([name, "--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(`Usage:\n  jubarteai ${name}`);
    expect(out).toContain("Global options:");
  });

  it("search-knowledge --help prints its flags", async () => {
    const { out } = await run(["search-knowledge", "--help"]);
    for (const flag of TOOL_SPECS.find((spec) => spec.command === "search-knowledge")?.flags ?? []) {
      if (flag.hidden !== true) expect(out).toContain(`--${flag.name}`);
    }
    expect(out).toContain("--json");
  });
});
