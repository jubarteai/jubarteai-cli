import { CLI_NAME, cliVersion } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { redactSecrets, safeForDisplay, transportErrorEnvelope, writeJson } from "../output.js";
import { GLOBAL_FLAGS, parseArgs } from "./args.js";
import type { FlagSpec, ParsedArgs } from "./args.js";
import { COMMANDS } from "./commands.js";
import type { CommandContext, CommandDef } from "./commands.js";
import { renderCommandHelp, renderHelp } from "./help.js";

export { renderCommandHelp, renderHelp };

export type RouteContext = Omit<CommandContext, "globals">;

const HELP_ALL_FLAG: FlagSpec = { name: "all", type: "boolean", description: "With --help, also list internal commands", hidden: true };
const UNEXPECTED_ERROR = `${CLI_NAME}: unexpected error`;
const USAGE_HINT = `Run "${CLI_NAME} --help" for usage.`;
const TRANSPORT_CODES: Readonly<Record<number, string>> = { 3: "auth_error", 4: "network_error", 5: "not_signed_in" };

/** Splits argv at the command name: the first token that is not a flag or a global flag's value. */
function splitAtCommand(argv: readonly string[]): { head: string[]; command: string | undefined; tail: string[] } {
  const valueFlags = new Set(GLOBAL_FLAGS.filter((spec) => spec.type !== "boolean").map((spec) => `--${spec.name}`));
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      if (valueFlags.has(token)) i += 1;
      continue;
    }
    return { head: argv.slice(0, i), command: token, tail: argv.slice(i + 1) };
  }
  return { head: [...argv], command: undefined, tail: [] };
}

/**
 * The flags allowed before the command name: they print help or the version and run nothing, so a harness rule that
 * names a command by its second word (`Bash(jubarteai init *)`, a regex on `jubarteai <command>`) can't be slipped past
 * with `jubarteai --yes init` (review R-S8).
 */
const HEAD_INFO_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "--version", "-v", "--all"]);
const HEAD_RUNS_NOTHING: ReadonlySet<string> = new Set(["--help", "-h", "--version", "-v"]);

/** Throws unless `head` is empty or only info flags, with one that prints help or the version. */
function checkHead(head: readonly string[], command: string): void {
  if (head.length === 0) return;
  if (head.every((token) => HEAD_INFO_FLAGS.has(token)) && head.some((token) => HEAD_RUNS_NOTHING.has(token))) return;
  throw new UsageError(`Put flags after the command name: ${CLI_NAME} ${safeForDisplay(command)} [options].`);
}

function hasHelpToken(args: readonly string[]): boolean {
  for (const token of args) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}

function errnoCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) return code;
  }
  return null;
}

function reportError(error: unknown, command: CommandDef | undefined, ctx: RouteContext, pretty: boolean): number {
  if (error instanceof CliError) {
    const message = redactSecrets(error.message);
    ctx.stderr.write(`${message}\n`);
    if (error instanceof UsageError) ctx.stderr.write(`${USAGE_HINT}\n`);
    if (command?.group === "tools" && (error.exitCode === 3 || error.exitCode === 4 || error.exitCode === 5)) {
      writeJson(ctx.stdout, transportErrorEnvelope(error.code ?? TRANSPORT_CODES[error.exitCode] ?? "error", message), { pretty });
    }
    return error.exitCode;
  }
  // Anything else may carry request headers or keys in its message: say nothing about it.
  const code = errnoCode(error);
  ctx.stderr.write(`${UNEXPECTED_ERROR}${code === null ? "" : ` (${code})`}.\n`);
  return ExitCode.SERVER_ERROR;
}

/** Routes argv through `commands`. Exported so tests can inject a registry. */
export async function routeWith(commands: readonly CommandDef[], argv: string[], ctx: RouteContext): Promise<number> {
  let command: CommandDef | undefined;
  let pretty = false;
  try {
    const split = splitAtCommand(argv);

    if (split.command === undefined) {
      const top = parseArgs(argv, [...GLOBAL_FLAGS, HELP_ALL_FLAG]);
      if (top.positionals.length > 0) throw new UsageError(`Unknown command "${safeForDisplay(top.positionals[0] as string)}".`);
      const extra = argv.find((token) => token !== "--" && !HEAD_INFO_FLAGS.has(token));
      if (extra !== undefined) throw new UsageError(`${safeForDisplay(extra)} needs a command: ${CLI_NAME} <command> [options].`);
      if (top.flags.version === true) {
        ctx.stdout.write(`${cliVersion()}\n`);
        return ExitCode.OK;
      }
      ctx.stdout.write(renderHelp(commands, { all: top.flags.all === true }));
      return ExitCode.OK;
    }

    checkHead(split.head, split.command);
    const headFlags = parseArgs(split.head, [...GLOBAL_FLAGS, HELP_ALL_FLAG]).flags;
    command = commands.find((candidate) => candidate.name === split.command);
    if (command === undefined) throw new UsageError(`Unknown command "${safeForDisplay(split.command)}".`);

    const ownNames = new Set(command.flags.map((spec) => spec.name));
    const specs = [...command.flags, ...GLOBAL_FLAGS.filter((spec) => !ownNames.has(spec.name))];
    const helpAsked = headFlags.help === true || hasHelpToken(split.tail);
    let parsed: ParsedArgs = { flags: {}, positionals: [] };
    if (!helpAsked) parsed = parseArgs(split.tail, specs);
    const flags = { ...headFlags, ...parsed.flags };
    pretty = flags.pretty === true;

    if (flags.version === true) {
      ctx.stdout.write(`${cliVersion()}\n`);
      return ExitCode.OK;
    }
    if (helpAsked) {
      ctx.stdout.write(renderCommandHelp(command));
      return ExitCode.OK;
    }

    const globals: CommandContext["globals"] = { pretty, yes: flags.yes === true };
    if (typeof flags.workspace === "string") globals.workspace = flags.workspace;
    if (typeof flags.agent === "string") globals.agent = flags.agent;
    return await command.run({ ...ctx, globals }, { flags, positionals: parsed.positionals });
  } catch (error) {
    return reportError(error, command, ctx, pretty);
  }
}

export async function route(argv: string[], ctx: RouteContext): Promise<number> {
  return routeWith(COMMANDS, argv, ctx);
}
