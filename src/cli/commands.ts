import type { ParsedArgs, FlagSpec } from "./args.js";

export type CommandContext = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  cwd: string;
  globals: { workspace?: string; agent?: string; pretty: boolean; yes: boolean };
};

export type CommandGroup = "account" | "tools" | "setup" | "internal";

export type CommandDef = {
  name: string;
  summary: string;
  group: CommandGroup;
  flags: FlagSpec[];
  /** What follows "jubarteai " in the Usage line; defaults to "<name> [options]". */
  usage?: string;
  run(ctx: CommandContext, args: ParsedArgs): Promise<number>;
};

/** Every command the CLI answers to. Later tasks add entries here and nowhere else. */
export const COMMANDS: CommandDef[] = [];
