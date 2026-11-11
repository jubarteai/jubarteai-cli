import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCliCommand } from "./cli-command.js";

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
  it("quotes this node and the real path of the bin script", () => {
    expect(resolveCliCommand("/usr/local/bin/node", script)).toBe(`"/usr/local/bin/node" "${script}"`);
  });

  it("follows a symlinked bin to the script it points at", () => {
    if (!posix) return;
    const link = join(dir, "link.js");
    symlinkSync(script, link);
    expect(resolveCliCommand("/usr/local/bin/node", link)).toBe(`"/usr/local/bin/node" "${script}"`);
  });

  it("uses the running process by default", () => {
    const original = process.argv[1];
    process.argv[1] = script;
    try {
      expect(resolveCliCommand()).toBe(`"${process.execPath}" "${script}"`);
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
    expect(resolveCliCommand(execPath, given === "FILE" ? script : given)).toBe("jubarteai");
  });

  it("falls back to the bare name when the script path holds a quote", () => {
    if (!posix) return;
    const odd = join(dir, 'we"ird.js');
    writeFileSync(odd, "");
    expect(resolveCliCommand("/usr/local/bin/node", odd)).toBe("jubarteai");
  });
});
