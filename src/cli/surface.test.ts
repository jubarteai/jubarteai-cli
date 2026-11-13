// The 1.x surface (STABILITY.md): every command, alias, flag and flag type, the global flags and the exit codes recorded in
// surface-1.0.json must still exist. Adding a command or a flag is fine; renaming or removing one fails here. To record the
// additions of a minor release, regenerate the file with `JUBARTEAI_RECORD_SURFACE=1 npx vitest run src/cli/surface.test.ts`
// and read the diff: it only ever grows within 1.x.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ExitCode } from "../errors.js";
import { GLOBAL_FLAGS } from "./args.js";
import { COMMANDS } from "./commands.js";

type Surface = {
  commands: Record<string, { group: string; flags: Record<string, string> }>;
  aliases: Record<string, string>;
  globalFlags: Record<string, string>;
  exitCodes: Record<string, number>;
};

const FILE = new URL("./surface-1.0.json", import.meta.url);

function current(): Surface {
  const commands: Surface["commands"] = {};
  const aliases: Surface["aliases"] = {};
  for (const command of COMMANDS) {
    commands[command.name] = { group: command.group, flags: Object.fromEntries(command.flags.map((flag) => [flag.name, flag.type]).sort(([a], [b]) => String(a).localeCompare(String(b)))) };
    // Tool commands also answer to their snake_case MCP tool name.
    if (command.group === "tools" && command.name.includes("-")) aliases[command.name.replace(/-/g, "_")] = command.name;
  }
  return {
    commands: Object.fromEntries(Object.entries(commands).sort(([a], [b]) => a.localeCompare(b))),
    aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))),
    globalFlags: Object.fromEntries(GLOBAL_FLAGS.map((flag) => [flag.name, flag.type])),
    exitCodes: { ...ExitCode },
  };
}

describe("the 1.x command and flag surface", () => {
  if (process.env["JUBARTEAI_RECORD_SURFACE"] === "1") {
    it("records the surface", () => {
      writeFileSync(FILE, `${JSON.stringify(current(), null, 2)}\n`);
    });
    return;
  }
  const recorded = JSON.parse(readFileSync(FILE, "utf8")) as Surface;
  const now = current();

  it("still has every recorded command, in the same group", () => {
    for (const [name, command] of Object.entries(recorded.commands)) {
      expect(now.commands[name], `command ${name} was removed or renamed`).toBeDefined();
      expect(now.commands[name]?.group, `command ${name} changed group`).toBe(command.group);
    }
  });

  it("still has every recorded flag, with the same type", () => {
    for (const [name, command] of Object.entries(recorded.commands)) {
      for (const [flag, type] of Object.entries(command.flags)) {
        expect(now.commands[name]?.flags[flag], `--${flag} of ${name} was removed, renamed or retyped`).toBe(type);
      }
    }
  });

  it("still has every recorded global flag and snake_case alias", () => {
    for (const [flag, type] of Object.entries(recorded.globalFlags)) expect(now.globalFlags[flag], `global --${flag}`).toBe(type);
    for (const [alias, target] of Object.entries(recorded.aliases)) expect(now.aliases[alias], `alias ${alias}`).toBe(target);
  });

  it("keeps the exit codes 0 to 5 with the same meaning", () => {
    expect(recorded.exitCodes).toEqual(now.exitCodes);
    expect(Object.values(now.exitCodes).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("lists the commands the stability page names", () => {
    for (const name of ["init", "update", "uninstall", "doctor", "status", "login", "logout", "link", "completion", "connect", "inbox", "hook"]) {
      expect(recorded.commands[name], name).toBeDefined();
    }
  });
});
