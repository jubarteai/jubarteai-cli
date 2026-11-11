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

const SETUP = ["init", "link", "doctor", "update"];
const ACCOUNT = ["login", "logout", "status"];
const TOOL_COMMAND_NAMES = TOOL_SPECS.map((spec) => spec.command);
/** Every command of spec 5.3-5.5 a person sees in plain `--help` (hook is internal). */
const PUBLIC_COMMANDS = [...SETUP, ...ACCOUNT, ...TOOL_COMMAND_NAMES, "call", "inbox"];

function listed(out: string, name: string): boolean {
  return new RegExp(`^  ${name} +\\S`, "m").test(out);
}

describe("COMMANDS", () => {
  it("has unique, well-formed names and a valid group", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(["account", "tools", "setup", "internal"]).toContain(command.group);
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("registers setup, account, connect, exactly the spec 5.3 tool commands, call, inbox and hook, in help order", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([...PUBLIC_COMMANDS, "hook"]);
    expect(TOOL_COMMAND_NAMES).toHaveLength(16);
    expect(TOOL_COMMAND_NAMES[0]).toBe("connect");
    expect(COMMANDS.filter((command) => command.group === "setup").map((command) => command.name)).toEqual(SETUP);
    expect(COMMANDS.filter((command) => command.group === "account").map((command) => command.name)).toEqual(ACCOUNT);
    expect(COMMANDS.filter((command) => command.group === "internal").map((command) => command.name)).toEqual(["hook"]);
  });

  it("lists every public command in --help, Setup first, and leaves hook out", async () => {
    const { code, out, err } = await run(["--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const name of PUBLIC_COMMANDS) expect(listed(out, name), name).toBe(true);
    expect(listed(out, "hook")).toBe(false);
    expect(out).not.toContain("Internal");
    expect(out.indexOf("Setup:")).toBeLessThan(out.indexOf("Account:"));
    expect(out.indexOf("Account:")).toBeLessThan(out.indexOf("Tools:"));
    expect(out.indexOf("  init ")).toBeLessThan(out.indexOf("  link "));
    expect(out.indexOf("  link ")).toBeLessThan(out.indexOf("  doctor "));
    expect(out.indexOf("  doctor ")).toBeLessThan(out.indexOf("  update "));
    expect(renderHelp(COMMANDS, { all: false })).toBe(out);
  });

  it("--help --all adds hook under an Internal heading, after every other group", async () => {
    const { code, out, err } = await run(["--help", "--all"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const name of [...PUBLIC_COMMANDS, "hook"]) expect(listed(out, name), name).toBe(true);
    expect(out).toContain("Internal");
    expect(out.indexOf("Tools:")).toBeLessThan(out.indexOf("Internal"));
    expect(out.indexOf("Internal")).toBeLessThan(out.indexOf("  hook "));
    expect(renderHelp(COMMANDS, { all: true })).toBe(out);
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

  it("init --help documents every init flag", async () => {
    const { code, out, err } = await run(["init", "--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const flag of ["workspace", "no-browser", "paste", "share-binding", "private-binding", "keep-mcp", "no-hooks", "no-permissions", "yes"]) {
      expect(out, flag).toContain(`--${flag}`);
    }
  });

  it("link, doctor and update --help show their own flags", async () => {
    expect((await run(["link", "--help"])).out).toContain("--share-binding");
    expect((await run(["link", "--help"])).out).toContain("--private-binding");
    expect((await run(["doctor", "--help"])).out).toContain("--json");
    const update = (await run(["update", "--help"])).out;
    for (const flag of ["check", "self-update", "keep-mcp"]) expect(update, flag).toContain(`--${flag}`);
  });
});
