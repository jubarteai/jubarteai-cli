import { CLI_NAME } from "../constants.js";
import { GLOBAL_FLAGS } from "./args.js";
import type { FlagSpec } from "./args.js";
import type { CommandDef, CommandGroup } from "./commands.js";

/**
 * Help lists the groups in this order: Setup first, then Account, then Tools, then Internal (spec §5.5: `hook` is
 * documented under "Internal"). Plain --help names the internal commands on one line; --help --all lists them in full.
 */
const GROUP_TITLES: ReadonlyArray<{ group: CommandGroup; title: string }> = [
  { group: "setup", title: "Setup" },
  { group: "account", title: "Account" },
  { group: "tools", title: "Tools" },
  { group: "internal", title: "Internal (used by hooks and shims)" },
];

function flagLines(specs: readonly FlagSpec[], includeHidden: boolean): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  for (const spec of specs) {
    if (spec.hidden === true && !includeHidden) continue;
    let syntax = `--${spec.name}`;
    if (spec.type === "string" || spec.type === "string[]") syntax += " <value>";
    else if (spec.type === "number") syntax += " <number>";
    else if (spec.type === "json") syntax += " <json|@file|->";
    const description = spec.type === "string[]" ? `${spec.description} (repeatable)` : spec.description;
    lines.push([syntax, description]);
    if (spec.file === true && spec.type !== "boolean") {
      lines.push([`--${spec.name}-file <path|->`, `Read ${spec.name} from a file (- for stdin)`]);
    }
  }
  return lines;
}

function renderColumns(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0);
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

export function renderHelp(commands: readonly CommandDef[], opts: { all: boolean }): string {
  const sections: string[] = [
    `${CLI_NAME} - command-line interface for JubarteAI`,
    `Usage:\n  ${CLI_NAME} <command> [options]\n  ${CLI_NAME} --help | --version`,
  ];
  for (const { group, title } of GROUP_TITLES) {
    const members = commands.filter((command) => command.group === group);
    if (members.length === 0) continue;
    if (group === "internal" && !opts.all) {
      sections.push(`${title}: ${members.map((command) => command.name).join(", ")} (not for direct use; details: ${CLI_NAME} --help --all)`);
      continue;
    }
    sections.push(`${title}:\n${renderColumns(members.map((command): [string, string] => [command.name, command.summary]))}`);
  }
  sections.push(`Global options:\n${renderColumns(flagLines(GLOBAL_FLAGS, false))}`);
  sections.push(`Run "${CLI_NAME} <command> --help" for a command's options.`);
  return `${sections.join("\n\n")}\n`;
}

export function renderCommandHelp(command: CommandDef): string {
  const names = new Set(command.flags.map((spec) => spec.name));
  const globals = GLOBAL_FLAGS.filter((spec) => !names.has(spec.name));
  const sections = [`Usage:\n  ${CLI_NAME} ${command.usage ?? `${command.name} [options]`}`, command.summary];
  const own = flagLines(command.flags, false);
  if (own.length > 0) sections.push(`Options:\n${renderColumns(own)}`);
  sections.push(`Global options:\n${renderColumns(flagLines(globals, false))}`);
  return `${sections.join("\n\n")}\n`;
}
