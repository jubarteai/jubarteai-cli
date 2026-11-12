import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { routeWith } from "../cli/router.js";
import { COMMANDS } from "../cli/commands.js";
import { HARNESS_IDS } from "../session/harness-env.js";
import { SHELLS, completionCommand, completionScript, describeCommands } from "./completion.js";

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const code = await routeWith(COMMANDS, argv, { stdout, stderr, stdin: new PassThrough(), cwd: process.cwd() });
  return { code, out, err };
}

const publicNames = COMMANDS.filter((command) => command.group !== "internal").map((command) => command.name);

describe("completion scripts", () => {
  for (const shell of SHELLS) {
    it(`${shell}: names every public command and flag, the harness ids for --skip-harness, and no internal command`, () => {
      const script = completionScript(shell, COMMANDS);
      for (const name of publicNames) expect(script, name).toContain(name);
      expect(describeCommands(COMMANDS).map((command) => command.name)).not.toContain("hook");
      for (const id of HARNESS_IDS) expect(script, id).toContain(id);
      for (const flag of ["--skip-harness", "--show-changes", "--keep-login", "--plain", "--verbose", "--workspace", "--pretty"]) expect(script, flag).toContain(shell === "fish" ? flag.slice(2) : flag);
    });
  }

  it("is built from the registry: a new command or flag shows up with no other change", () => {
    const registry = [...COMMANDS, { name: "brand-new", summary: "A new one", group: "setup" as const, flags: [{ name: "fresh-flag", type: "boolean" as const, description: "x" }], run: async () => 0 }];
    for (const shell of SHELLS) {
      const script = completionScript(shell, registry);
      expect(script).toContain("brand-new");
      expect(script).toContain(shell === "fish" ? "fresh-flag" : "--fresh-flag");
    }
  });

  it("leaves out hidden flags and internal commands", () => {
    const info = describeCommands([
      { name: "x", summary: "s", group: "setup", flags: [{ name: "shown", type: "boolean", description: "d" }, { name: "secret", type: "boolean", description: "d", hidden: true }], run: async () => 0 },
      { name: "hook", summary: "s", group: "internal", flags: [], run: async () => 0 },
    ]);
    expect(info.map((command) => command.name)).toEqual(["x"]);
    expect(info[0]?.flags.map((flag) => flag.name)).toContain("shown");
    expect(info[0]?.flags.map((flag) => flag.name)).not.toContain("secret");
  });

  it("quotes descriptions with apostrophes and colons so the script stays valid", () => {
    const registry = [{ name: "odd", summary: "It's a: test", group: "setup" as const, flags: [{ name: "x", type: "boolean" as const, description: "don't [do] it: really" }], run: async () => 0 }];
    for (const shell of ["bash", "zsh"] as const) {
      const check = spawnSync(shell, ["-n"], { input: completionScript(shell, registry), encoding: "utf8" });
      expect(check.status, `${shell}: ${check.stderr}`).toBe(0);
    }
  });
});

describe("syntax checks with the shells that are installed", () => {
  const available = (shell: string): boolean => spawnSync(shell, ["--version"], { stdio: "ignore" }).status === 0 || shell === "bash" || shell === "zsh";
  for (const shell of ["bash", "zsh"] as const) {
    it.skipIf(process.platform === "win32" || !available(shell))(`${shell} -n accepts the script`, () => {
      const check = spawnSync(shell, ["-n"], { input: completionScript(shell, COMMANDS), encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
    });
  }

  it("fish -n accepts the script (skipped loudly when fish is not installed)", () => {
    const probe = spawnSync("fish", ["--version"], { stdio: "ignore" });
    if (probe.error !== undefined || probe.status !== 0) {
      console.warn("fish completion syntax check skipped: fish is not installed here");
      return;
    }
    const check = spawnSync("fish", ["-n"], { input: completionScript("fish", COMMANDS), encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
  });

  it("PowerShell parses the script (skipped loudly when pwsh is not installed)", () => {
    const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (probe.error !== undefined || probe.status !== 0) {
      console.warn("PowerShell completion syntax check skipped: pwsh is not installed here");
      return;
    }
    const script = completionScript("powershell", COMMANDS);
    const check = spawnSync("pwsh", ["-NoProfile", "-Command", "$null = [scriptblock]::Create([Console]::In.ReadToEnd()); 'ok'"], { input: script, encoding: "utf8" });
    expect(check.stdout.trim(), check.stderr).toBe("ok");
  });
});

describe("the completion command", () => {
  it("prints the script to stdout and nothing to stderr", async () => {
    const result = await run(["completion", "bash"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("complete -F _jubarteai jubarteai");
    expect(result.err).toBe("");
  });

  it("an unknown shell is suggested and exits 2; no shell is a usage error", async () => {
    const typo = await run(["completion", "zhs"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain('Did you mean "zsh"?');
    expect(typo.out).toBe("");
    expect((await run(["completion"])).code).toBe(2);
    expect((await run(["completion", "bash", "zsh"])).code).toBe(2);
  });

  it("never touches a profile: the source only writes to stdout", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./completion.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/writeFile|appendFile|\.bashrc|\.zshrc|homeDir/);
    expect(completionCommand.group).toBe("setup");
  });
});
