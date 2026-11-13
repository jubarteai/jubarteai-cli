import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cliCommandInfo, resolveCliCommand } from "./cli-command.js";

const posix = process.platform !== "win32";
let dir: string;
let script: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jba-clicmd-")));
  script = join(dir, "jubarteai.js");
  writeFileSync(script, "// fake bin\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveCliCommand", () => {
  // A real temp path holds backslashes on Windows, which the POSIX rule (rightly) refuses to quote.
  it.skipIf(!posix)("quotes this node and the real path of the bin script", () => {
    expect(resolveCliCommand("/usr/local/bin/node", script, "linux")).toBe(`"/usr/local/bin/node" "${script}"`);
  });

  it("follows a symlinked bin to the script it points at", () => {
    if (!posix) return;
    const link = join(dir, "link.js");
    symlinkSync(script, link);
    expect(resolveCliCommand("/usr/local/bin/node", link, "linux")).toBe(`"/usr/local/bin/node" "${script}"`);
  });

  // A real temp path holds backslashes on Windows, which the POSIX rule (rightly) refuses to quote.
  it.skipIf(!posix)("uses the running process by default", () => {
    const original = process.argv[1];
    process.argv[1] = script;
    try {
      expect(resolveCliCommand(undefined, undefined, "linux")).toBe(`"${process.execPath}" "${script}"`);
    } finally {
      if (original === undefined) process.argv.length = 1;
      else process.argv[1] = original;
    }
  });

  it.each([
    ["no script", "/usr/local/bin/node", null],
    ["an empty script", "/usr/local/bin/node", ""],
    ["a script that does not exist", "/usr/local/bin/node", "/nonexistent/jubarteai.js"],
    ["a relative node path", "node", "FILE"],
    ["a quote in the node path", '/tmp/no"de', "FILE"],
  ])("falls back to the bare name for %s", (_name, execPath, given) => {
    expect(resolveCliCommand(execPath, given === "FILE" ? script : given, "linux")).toBe("jubarteai");
  });

  it("falls back to the bare name when the script path holds a quote", () => {
    if (!posix) return;
    const odd = join(dir, 'we"ird.js');
    writeFileSync(odd, "");
    expect(resolveCliCommand("/usr/local/bin/node", odd, "linux")).toBe("jubarteai");
  });
});

describe("resolveCliCommand: where the quoted form can't work", () => {
  it("is the bare name on Windows: PowerShell can't parse two quoted words, and GUI apps inherit npm's shims on PATH", () => {
    expect(resolveCliCommand("C:\\Program Files\\nodejs\\node.exe", script, "win32")).toBe("jubarteai");
    expect(cliCommandInfo("/usr/local/bin/node", script, "win32")).toEqual({ command: "jubarteai", npx: false });
  });

  it.each(["$HOME", "a`b", "a\\b"])("is the bare name on POSIX when the script path holds %s (the shell expands it inside quotes)", (piece) => {
    if (!posix) return;
    const odd = join(dir, `x${piece}y.js`);
    writeFileSync(odd, "");
    expect(resolveCliCommand("/usr/local/bin/node", odd, "linux")).toBe("jubarteai");
    expect(resolveCliCommand("/usr/local/bin/node", odd, "darwin")).toBe("jubarteai");
  });

  it("is the bare name when node's own path holds a shell-active character", () => {
    expect(resolveCliCommand("/opt/no$de/bin/node", script, "linux")).toBe("jubarteai");
  });

  it("is the bare name, flagged as npx, for a copy inside the npx cache", () => {
    if (!posix) return;
    const cache = join(dir, ".npm", "_npx", "abc123", "node_modules", "jubarteai", "bin");
    mkdirSync(cache, { recursive: true });
    const cached = join(cache, "jubarteai.js");
    writeFileSync(cached, "");
    expect(cliCommandInfo("/usr/local/bin/node", cached, "linux")).toEqual({ command: "jubarteai", npx: true });
    expect(resolveCliCommand("/usr/local/bin/node", cached, "linux")).toBe("jubarteai");
  });

  it("recognises the npx cache by its real path, through a link", () => {
    if (!posix) return;
    const cache = join(dir, "_npx", "h", "bin");
    mkdirSync(cache, { recursive: true });
    const real = join(cache, "jubarteai.js");
    writeFileSync(real, "");
    const link = join(dir, "global-link.js");
    symlinkSync(real, link);
    expect(cliCommandInfo("/usr/local/bin/node", link, "linux").npx).toBe(true);
  });

  // A real temp path holds backslashes on Windows, which the POSIX rule (rightly) refuses to quote.
  it.skipIf(!posix)("does not flag an ordinary install as npx", () => {
    expect(cliCommandInfo("/usr/local/bin/node", script, "linux")).toEqual({ command: `"/usr/local/bin/node" "${script}"`, npx: false });
  });
});
