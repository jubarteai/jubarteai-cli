import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { cliVersion } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import type { ParsedArgs } from "./args.js";
import type { CommandContext, CommandDef } from "./commands.js";
import { renderCommandHelp, renderHelp, routeWith } from "./router.js";

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

type Seen = { globals: CommandContext["globals"]; args: ParsedArgs } | null;

function harness(commands: CommandDef[]) {
  const out = sink();
  const err = sink();
  const run = (argv: string[]) =>
    routeWith(commands, argv, { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd: "/work" });
  return { run, out: out.text, err: err.text };
}

function command(overrides: Partial<CommandDef> & Pick<CommandDef, "name">, seen?: { value: Seen }): CommandDef {
  return {
    summary: `${overrides.name} summary`,
    group: "tools",
    flags: [],
    run: async (ctx, args) => {
      if (seen !== undefined) seen.value = { globals: ctx.globals, args };
      return 0;
    },
    ...overrides,
  };
}

const SECRET = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKE0002";

describe("routeWith: help and version", () => {
  const registry = [
    command({ name: "search", summary: "Search knowledge", group: "tools", flags: [{ name: "query", type: "string", description: "What to look for" }] }),
    command({ name: "login", summary: "Sign in", group: "account" }),
    command({ name: "init", summary: "Connect a repo", group: "setup" }),
    command({ name: "hook", summary: "Harness hook entry", group: "internal" }),
  ];

  it("prints the version for --version anywhere, exit 0", async () => {
    for (const argv of [["--version"], ["-v"], ["search", "--version"], ["--pretty", "--version"]]) {
      const h = harness(registry);
      expect(await h.run(argv)).toBe(0);
      expect(h.out()).toBe(`${cliVersion()}\n`);
      expect(h.err()).toBe("");
    }
  });

  it("prints grouped help with no arguments and for --help, hiding internal commands", async () => {
    for (const argv of [[], ["--help"], ["-h"]]) {
      const h = harness(registry);
      expect(await h.run(argv)).toBe(0);
      const text = h.out();
      expect(text).toContain("Usage:");
      expect(text).toContain("Account:");
      expect(text).toContain("Tools:");
      expect(text).toContain("Setup:");
      expect(text.indexOf("Setup:")).toBeLessThan(text.indexOf("Account:"));
      expect(text.indexOf("Account:")).toBeLessThan(text.indexOf("Tools:"));
      expect(text).toContain("Search knowledge");
      expect(text).toContain("--workspace <value>");
      expect(text).not.toContain("Internal");
      expect(text).not.toContain("Harness hook entry");
      expect(h.err()).toBe("");
    }
  });

  it("--help --all lists internal commands", async () => {
    const h = harness(registry);
    expect(await h.run(["--help", "--all"])).toBe(0);
    expect(h.out()).toContain("Internal (used by hooks and shims):");
    expect(h.out()).toContain("Harness hook entry");
  });

  it("help works with an empty registry (no command sections)", async () => {
    const h = harness([]);
    expect(await h.run(["--help"])).toBe(0);
    expect(h.out()).toContain("Global options:");
    expect(h.out()).not.toContain("Account:");
  });

  it("<cmd> --help prints that command's flags and does not run it", async () => {
    const seen = { value: null as Seen };
    const h = harness([
      command(
        { name: "search", usage: "search --query <text>", flags: [{ name: "query", type: "string", description: "What to look for", file: true }, { name: "tag", type: "string[]", description: "Tags" }] },
        seen,
      ),
    ]);
    expect(await h.run(["search", "--help"])).toBe(0);
    const text = h.out();
    expect(text).toContain("jubarteai search --query <text>");
    expect(text).toContain("--query <value>");
    expect(text).toContain("--query-file <path|->");
    expect(text).toContain("Tags (repeatable)");
    expect(text).toContain("--workspace");
    expect(seen.value).toBeNull();
  });

  it("<cmd> --help wins over other flag errors and works as -h and before the command", async () => {
    for (const argv of [["search", "--bogus", "--help"], ["search", "-h"], ["--help", "search"]]) {
      const h = harness([command({ name: "search" })]);
      expect(await h.run(argv)).toBe(0);
      expect(h.out()).toContain("Usage:\n  jubarteai search [options]");
    }
  });

  it("a flag the command defines replaces the global of the same name in its help", () => {
    const text = renderCommandHelp(command({ name: "x", flags: [{ name: "agent", type: "string", description: "Custom agent" }] }));
    expect(text.match(/--agent/g)?.length).toBe(1);
    expect(text).toContain("Custom agent");
  });

  it("renderHelp omits hidden flags", () => {
    expect(renderHelp([], { all: false })).not.toContain("--all");
  });
});

describe("routeWith: dispatch", () => {
  it("accepts global flags before and after the command and hands them to the command", async () => {
    const seen = { value: null as Seen };
    const h = harness([command({ name: "search", flags: [{ name: "query", type: "string", description: "q" }] }, seen)]);
    expect(await h.run(["--workspace", "acme", "search", "--query", "x", "--pretty", "--agent=agent-1", "--yes", "extra"])).toBe(0);
    expect(seen.value?.globals).toEqual({ workspace: "acme", agent: "agent-1", pretty: true, yes: true });
    expect(seen.value?.args.flags.query).toBe("x");
    expect(seen.value?.args.positionals).toEqual(["extra"]);
  });

  it("defaults the globals", async () => {
    const seen = { value: null as Seen };
    const h = harness([command({ name: "search" }, seen)]);
    await h.run(["search"]);
    expect(seen.value?.globals).toEqual({ pretty: false, yes: false });
  });

  it("returns the command's exit code", async () => {
    const h = harness([command({ name: "check", run: async () => 2 })]);
    expect(await h.run(["check"])).toBe(2);
  });

  it("a global flag's value is not mistaken for the command name", async () => {
    const seen = { value: null as Seen };
    const h = harness([command({ name: "search" }, seen)]);
    expect(await h.run(["--workspace", "search", "search"])).toBe(0);
    expect(seen.value?.globals.workspace).toBe("search");
  });

  it("passes the process context through", async () => {
    let cwd = "";
    const h = harness([command({ name: "where", run: async (ctx) => ((cwd = ctx.cwd), 0) })]);
    await h.run(["where"]);
    expect(cwd).toBe("/work");
  });
});

describe("routeWith: usage errors", () => {
  it("unknown command → stderr, exit 2, nothing on stdout", async () => {
    const h = harness([command({ name: "search" })]);
    expect(await h.run(["bogus"])).toBe(2);
    expect(h.err()).toContain('Unknown command "bogus"');
    expect(h.out()).toBe("");
  });

  it("an unknown command that looks like a key is redacted", async () => {
    const h = harness([]);
    expect(await h.run([SECRET])).toBe(2);
    expect(h.err()).not.toContain(SECRET);
    expect(h.err()).not.toContain("FAKEFAKE");
  });

  it("an unknown command name is rendered without control characters", async () => {
    for (const argv of [["bad\u001b[2Jname"], ["--pretty", "bad\u009bname\u007f"]]) {
      const h = harness([]);
      expect(await h.run(argv)).toBe(2);
      expect(h.err()).toContain('Unknown command "bad');
      // eslint-disable-next-line no-control-regex
      expect(h.err().replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it("unknown flags (top level, before the command, after it) → exit 2 naming the flag", async () => {
    for (const [argv, flag] of [
      [["--nope"], "--nope"],
      [["--nope", "search"], "--nope"],
      [["search", "--nope"], "--nope"],
    ] as const) {
      const h = harness([command({ name: "search" })]);
      expect(await h.run([...argv])).toBe(2);
      expect(h.err()).toContain(`Unknown flag ${flag}`);
      expect(h.out()).toBe("");
    }
  });

  it("a value-less global string flag → exit 2", async () => {
    const h = harness([command({ name: "search" })]);
    expect(await h.run(["search", "--workspace"])).toBe(2);
    expect(h.err()).toContain("--workspace needs a value");
  });

  it("a UsageError thrown by a command → exit 2 with the usage hint", async () => {
    const h = harness([command({ name: "x", run: async () => Promise.reject(new UsageError("Missing --query.")) })]);
    expect(await h.run(["x"])).toBe(2);
    expect(h.err()).toContain("Missing --query.");
    expect(h.err()).toContain('Run "jubarteai --help" for usage.');
  });
});

describe("routeWith: errors from commands", () => {
  const throwing = (error: unknown, group: CommandDef["group"] = "tools") =>
    command({ name: "boom", group, run: async () => Promise.reject(error) });

  it.each([
    [3, "invalid_api_key", "That key was revoked."],
    [4, "network_error", "Could not reach JubarteAI."],
    [5, "not_signed_in", "Not signed in. Run: jubarteai login"],
  ] as const)("a tools command's CliError %i → exit code, stderr message and one JSON envelope line", async (exitCode, code, message) => {
    const h = harness([throwing(new CliError(message, exitCode, code))]);
    expect(await h.run(["boom"])).toBe(exitCode);
    expect(h.err()).toBe(`${message}\n`);
    expect(h.out()).toBe(`{"messages":[],"error":${JSON.stringify(message)},"code":"${code}"}\n`);
  });

  it("falls back to a default envelope code when the error has none, and honours --pretty", async () => {
    const h = harness([throwing(new CliError("Down.", ExitCode.NETWORK))]);
    expect(await h.run(["boom", "--pretty"])).toBe(4);
    expect(JSON.parse(h.out())).toEqual({ messages: [], error: "Down.", code: "network_error" });
    expect(h.out()).toContain('\n  "messages"');
  });

  it("exit 1 CliError → no envelope; non-tools commands never get one", async () => {
    const a = harness([throwing(new CliError("Server said no.", ExitCode.SERVER_ERROR))]);
    expect(await a.run(["boom"])).toBe(1);
    expect(a.out()).toBe("");
    const b = harness([throwing(new CliError("Not signed in.", ExitCode.NO_SEAT), "account")]);
    expect(await b.run(["boom"])).toBe(5);
    expect(b.out()).toBe("");
    expect(b.err()).toContain("Not signed in.");
  });

  it("redacts a key that slipped into a CliError message", async () => {
    const h = harness([throwing(new CliError(`bad key ${SECRET}`, ExitCode.AUTH, "invalid_api_key"))]);
    expect(await h.run(["boom"])).toBe(3);
    expect(h.err()).not.toContain(SECRET);
    expect(h.out()).not.toContain(SECRET);
  });

  it("any other error → exit 1 with a fixed line that never echoes the error", async () => {
    const error = Object.assign(new Error(`Authorization: Bearer ${SECRET}`), { stack: `Error: ${SECRET}\n    at x`, headers: { authorization: SECRET } });
    const h = harness([throwing(error)]);
    expect(await h.run(["boom"])).toBe(1);
    expect(h.err()).toBe("jubarteai: unexpected error.\n");
    expect(h.out()).toBe("");
  });

  it("names only a system error code for a failed system call", async () => {
    const h = harness([throwing(Object.assign(new Error(`open /home/x/${SECRET}`), { code: "ENOENT" }))]);
    expect(await h.run(["boom"])).toBe(1);
    expect(h.err()).toBe("jubarteai: unexpected error (ENOENT).\n");
  });

  it("handles a thrown non-Error", async () => {
    const h = harness([throwing(SECRET)]);
    expect(await h.run(["boom"])).toBe(1);
    expect(h.err()).not.toContain(SECRET);
  });
});
