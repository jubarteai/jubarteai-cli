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

/** Whether `shell` can be started here. A runner without zsh (Ubuntu) or fish skips that shell's syntax check. */
function installed(shell: string): boolean {
  if (process.platform === "win32") return false; // bash on a Windows runner may be WSL's stub; these checks are POSIX-only.
  const probe = spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
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

  it("lists the --no- form of a boolean whose negated form is the one people type, and of no other flag", () => {
    const info = describeCommands(COMMANDS);
    const flagsOf = (name: string) => (info.find((command) => command.name === name)?.flags ?? []).map((flag) => flag.name);
    expect(flagsOf("update")).toEqual(expect.arrayContaining(["self-update", "no-self-update"]));
    expect(flagsOf("search-knowledge")).toEqual(expect.arrayContaining(["needs-verification", "no-needs-verification"]));
    // Ordinary booleans keep one entry: no --no-json, --no-yes, --no-check.
    expect(flagsOf("update")).not.toContain("no-check");
    expect(flagsOf("update")).not.toContain("no-yes");
    expect(flagsOf("search-knowledge")).not.toContain("no-json");
    // A flag that is itself named no-… is never doubled into --no-no-….
    for (const command of info) for (const flag of command.flags) expect(flag.name).not.toMatch(/^no-no-/);
    for (const shell of SHELLS) {
      const script = completionScript(shell, COMMANDS);
      expect(script, shell).toContain(shell === "fish" ? "-l no-self-update" : "--no-self-update");
      expect(script, shell).toContain(shell === "fish" ? "-l no-needs-verification" : "--no-needs-verification");
    }
  });

  it("each listed --no- form is one the parser accepts", async () => {
    for (const command of describeCommands(COMMANDS)) {
      for (const flag of command.flags.filter((f) => f.name.startsWith("no-"))) {
        const result = await run([command.name, `--${flag.name}`, "--help"]);
        expect(result.err, `${command.name} --${flag.name}`).not.toContain("Unknown");
        expect(result.code, `${command.name} --${flag.name}`).toBe(0);
      }
    }
  });

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
    for (const shell of (["bash", "zsh"] as const).filter(installed)) {
      const check = spawnSync(shell, ["-n"], { input: completionScript(shell, registry), encoding: "utf8" });
      expect(check.status, `${shell}: ${check.stderr}`).toBe(0);
    }
  });
});

describe("syntax checks with the shells that are installed", () => {
  for (const shell of ["bash", "zsh"] as const) {
    it.skipIf(!installed(shell))(`${shell} -n accepts the script`, () => {
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

  // One pwsh start, not a probe and then a parse: a cold pwsh takes seconds on a CI runner, and two of them overran
  // vitest's 5 s default on Ubuntu. ENOENT means pwsh is not installed, and the check is skipped loudly.
  it("PowerShell parses the script (skipped loudly when pwsh is not installed)", { timeout: 60_000 }, () => {
    const script = completionScript("powershell", COMMANDS);
    const check = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$null = [scriptblock]::Create([Console]::In.ReadToEnd()); 'ok'"], {
      input: script,
      encoding: "utf8",
      timeout: 55_000,
    });
    if ((check.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      console.warn("PowerShell completion syntax check skipped: pwsh is not installed here");
      return;
    }
    expect(check.error, "pwsh did not finish").toBeUndefined();
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
