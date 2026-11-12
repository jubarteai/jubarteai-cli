import { callCommand } from "../commands/call.js";
import { connectCommand } from "../commands/connect.js";
import { inboxCommand } from "../commands/inbox.js";
import { loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/logout.js";
import { statusCommand } from "../commands/status.js";
import { TOOL_COMMANDS } from "../commands/tool.js";
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

/**
 * Every command the CLI answers to. Later tasks add entries here and nowhere else. Help lists each group's
 * commands in this order: account first, then connect, the tool commands in spec §5.3 order, call, inbox.
 */
export const COMMANDS: CommandDef[] = [
  loginCommand,
  logoutCommand,
  statusCommand,
  connectCommand,
  ...TOOL_COMMANDS,
  callCommand,
  inboxCommand,
];
