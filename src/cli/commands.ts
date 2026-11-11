import { callCommand } from "../commands/call.js";
import { connectCommand } from "../commands/connect.js";
import { doctorCommand } from "../commands/doctor.js";
import { hookCommand } from "../commands/hook.js";
import { inboxCommand } from "../commands/inbox.js";
import { initCommand } from "../commands/init.js";
import { linkCommand } from "../commands/link.js";
import { loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/logout.js";
import { statusCommand } from "../commands/status.js";
import { TOOL_COMMANDS } from "../commands/tool.js";
import { updateCommand } from "../commands/update.js";
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
 * Every command the CLI answers to, in help order: setup (init, link, doctor, update), account, connect, the tool
 * commands in spec 5.3 order, call, inbox, then the internal hook command (listed only by `--help --all`).
 */
export const COMMANDS: CommandDef[] = [
  initCommand,
  linkCommand,
  doctorCommand,
  updateCommand,
  loginCommand,
  logoutCommand,
  statusCommand,
  connectCommand,
  ...TOOL_COMMANDS,
  callCommand,
  inboxCommand,
  hookCommand,
];
