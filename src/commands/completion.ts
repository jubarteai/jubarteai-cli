// `jubarteai completion bash|zsh|fish|powershell`: prints a static completion script built from the command registry, so it
// can never drift from the commands. It reads nothing from the machine, never edits a profile (the README shows the line
// to add), and lists only public commands and non-hidden flags.
import type { FlagSpec, ParsedArgs } from "../cli/args.js";
import { GLOBAL_FLAGS } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { suggest } from "../cli/suggest.js";
import { CLI_NAME } from "../constants.js";
import { UsageError } from "../errors.js";
import { HARNESS_IDS } from "../session/harness-env.js";

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

type FlagInfo = { name: string; description: string };
type CommandInfo = { name: string; summary: string; flags: FlagInfo[] };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A visible flag, then its `--no-<name>` form when the spec says that form is the one people type. */
function flagInfos(specs: readonly FlagSpec[]): FlagInfo[] {
  return specs
    .filter((spec) => spec.hidden !== true)
    .flatMap((spec) => {
      const info: FlagInfo[] = [{ name: spec.name, description: oneLine(spec.description) }];
      if (spec.type === "boolean" && spec.negation !== undefined) info.push({ name: `no-${spec.name}`, description: oneLine(spec.negation) });
      return info;
    });
}

/** The public commands with their flags (own, then the global ones), in help order. */
export function describeCommands(commands: readonly CommandDef[]): CommandInfo[] {
  const globals = flagInfos(GLOBAL_FLAGS);
  return commands
    .filter((command) => command.group !== "internal")
    .map((command) => {
      const own = flagInfos(command.flags);
      const ownNames = new Set(own.map((flag) => flag.name));
      return { name: command.name, summary: oneLine(command.summary), flags: [...own, ...globals.filter((flag) => !ownNames.has(flag.name))] };
    });
}

/** Single-quoted for POSIX shells. */
const sq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
/** Single-quoted for PowerShell. */
const psq = (text: string): string => `'${text.replace(/'/g, "''")}'`;

export function bashScript(info: readonly CommandInfo[]): string {
  const names = info.map((command) => command.name).join(" ");
  const cases = info.map((command) => `    ${command.name}) opts=${sq(command.flags.map((flag) => `--${flag.name}`).join(" "))} ;;`).join("\n");
  return `# bash completion for ${CLI_NAME}
_${CLI_NAME}() {
  local cur prev cmd opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W ${sq(names)} -- "$cur") )
    return
  fi
  if [ "$prev" = "--skip-harness" ]; then
    COMPREPLY=( $(compgen -W ${sq(HARNESS_IDS.join(" "))} -- "$cur") )
    return
  fi
  cmd="\${COMP_WORDS[1]}"
  opts=""
  case "$cmd" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _${CLI_NAME} ${CLI_NAME}
`;
}

export function zshScript(info: readonly CommandInfo[]): string {
  const commands = info.map((command) => `    ${sq(`${command.name}:${command.summary.replace(/:/g, "\\:")}`)}`).join("\n");
  const cases = info
    .map((command) => {
      const args = command.flags
        .map((flag) => `        ${sq(`--${flag.name}[${flag.description.replace(/[[\]]/g, "")}]${flag.name === "skip-harness" ? `:harness:(${HARNESS_IDS.join(" ")})` : ""}`)}`)
        .join(" \\\n");
      return `    ${command.name})\n      _arguments \\\n${args}\n      ;;`;
    })
    .join("\n");
  return `#compdef ${CLI_NAME}
# zsh completion for ${CLI_NAME}
_${CLI_NAME}() {
  local -a commands
  commands=(
${commands}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[2] in
${cases}
  esac
}
compdef _${CLI_NAME} ${CLI_NAME}
`;
}

export function fishScript(info: readonly CommandInfo[]): string {
  const lines: string[] = [`# fish completion for ${CLI_NAME}`, `complete -c ${CLI_NAME} -f`];
  for (const command of info) lines.push(`complete -c ${CLI_NAME} -n '__fish_use_subcommand' -a ${command.name} -d ${sq(command.summary)}`);
  for (const command of info) {
    for (const flag of command.flags) {
      const values = flag.name === "skip-harness" ? ` -x -a ${sq(HARNESS_IDS.join(" "))}` : "";
      lines.push(`complete -c ${CLI_NAME} -n '__fish_seen_subcommand_from ${command.name}' -l ${flag.name} -d ${sq(flag.description)}${values}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function powershellScript(info: readonly CommandInfo[]): string {
  const commands = info.map((command) => `    ${psq(command.name)} = ${psq(command.summary)}`).join("\n");
  const flags = info.map((command) => `    ${psq(command.name)} = @(${command.flags.map((flag) => psq(`--${flag.name}`)).join(", ")})`).join("\n");
  return `# PowerShell completion for ${CLI_NAME}
Register-ArgumentCompleter -Native -CommandName ${CLI_NAME} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = [ordered]@{
${commands}
  }
  $flags = @{
${flags}
  }
  $harnesses = @(${HARNESS_IDS.map(psq).join(", ")})
  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $candidates = @()
  if ($words.Count -le 1 -or ($words.Count -eq 2 -and $wordToComplete -ne '')) {
    $candidates = @($commands.Keys)
  } elseif ($words.Count -ge 2 -and $words[-1] -eq '--skip-harness' -and $wordToComplete -eq '') {
    $candidates = $harnesses
  } elseif ($words.Count -ge 3 -and $words[-2] -eq '--skip-harness') {
    $candidates = $harnesses
  } elseif ($flags.ContainsKey($words[1])) {
    $candidates = $flags[$words[1]]
  }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function completionScript(shell: Shell, commands: readonly CommandDef[]): string {
  const info = describeCommands(commands);
  switch (shell) {
    case "bash":
      return bashScript(info);
    case "zsh":
      return zshScript(info);
    case "fish":
      return fishScript(info);
    case "powershell":
      return powershellScript(info);
  }
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const [shell, ...extra] = args.positionals;
  if (shell === undefined || extra.length > 0) throw new UsageError(`completion needs one shell: ${SHELLS.join(", ")}. Example: ${CLI_NAME} completion zsh`);
  const known = SHELLS.find((candidate) => candidate === shell.toLowerCase());
  if (known === undefined) {
    const near = suggest(shell, SHELLS);
    throw new UsageError(`Unknown shell "${shell.slice(0, 40).replace(/[^\w.-]/g, "?")}".${near === null ? "" : ` Did you mean "${near}"?`} Known: ${SHELLS.join(", ")}.`);
  }
  // Imported here, not at the top: the registry lists this command, so a static import would be a cycle.
  const { COMMANDS } = await import("../cli/commands.js");
  ctx.stdout.write(completionScript(known, COMMANDS));
  return 0;
}

export const completionCommand: CommandDef = {
  name: "completion",
  summary: "Print a shell completion script (bash, zsh, fish or powershell); it never edits your profile",
  group: "setup",
  usage: "completion <bash|zsh|fish|powershell>",
  flags: [],
  run,
};
