// The 15 tool commands that map one to one onto an MCP tool (`connect` has its own file), and the helpers
// connect, call and inbox share: seat and agent resolution, and printing an envelope safely.
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import type { FlagSpec, ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { CliError, UsageError } from "../errors.js";
import { redactSecrets, safeForDisplay, writeJson } from "../output.js";
import { callTool } from "../mcp/client.js";
import type { CallOutcome, Envelope } from "../mcp/client.js";
import { flagsToArgs } from "../mcp/flags-to-args.js";
import { TOOL_SPECS } from "../mcp/tool-specs.js";
import type { ToolFlag, ToolSpec } from "../mcp/tool-specs.js";
import { resolveAgent } from "../session/agent.js";

export const JSON_FLAG: FlagSpec = {
  name: "json",
  type: "json",
  description: "The whole argument object (JSON, @file or -); flags given as well override its keys",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The seat a command talks as (spec §4); throws the exit-5 (or binding-problem exit-2) refusal otherwise. */
export function seatFor(ctx: CommandContext): ResolvedSeat {
  const resolved = resolveSeat({ workspace: ctx.globals.workspace, cwd: ctx.cwd });
  if (isResolveError(resolved)) throw new CliError(resolved.error, resolved.exitCode);
  return resolved;
}

/**
 * The agent a command acts as: `--agent`, else an `agent_id` the caller put in `--json`, else the
 * session cache. `required: false` (a tool this CLI doesn't know) leaves it out when nothing resolves.
 */
export function agentFor(
  ctx: CommandContext,
  seat: ResolvedSeat,
  fromJson: unknown,
  opts: { required: boolean },
): string | undefined {
  if (fromJson !== undefined && typeof fromJson !== "string") throw new UsageError("agent_id in --json must be a string.");
  const flag = ctx.globals.agent ?? fromJson;
  const resolved = resolveAgent(flag === undefined ? { seat } : { flag, seat });
  if ("agentId" in resolved) return resolved.agentId;
  if (opts.required || flag !== undefined) throw new CliError(resolved.error, resolved.exitCode, "usage");
  return undefined;
}

function scrubString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.split(secret).join("[redacted]");
  return out;
}

function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, secrets)]));
  return value;
}

/**
 * A copy of the envelope that is safe to print: the inbox watch's `jbw_` token removed (and the
 * copy of it inside `watch.command`), and that token and the seat's own key replaced wherever
 * else they appear.
 */
export function printableEnvelope(envelope: Envelope, secrets: readonly string[]): Envelope {
  const copy = structuredClone(envelope);
  const known = [...secrets];
  if (isRecord(copy.result) && isRecord(copy.result["watch"])) {
    const watch = copy.result["watch"];
    // The token is a secret wherever it turns up in the envelope, not only where the server put it.
    if (typeof watch["token"] === "string") known.push(watch["token"]);
    delete watch["token"];
    if (typeof watch["command"] === "string") watch["command"] = redactSecrets(watch["command"]);
  }
  return scrubDeep(copy, known) as Envelope;
}

/** Prints the outcome's envelope (one JSON line on stdout) and, for a transport or auth failure, the message on stderr. */
export function emit(ctx: CommandContext, outcome: CallOutcome, secrets: readonly string[]): number {
  const envelope = printableEnvelope(outcome.envelope, secrets);
  writeJson(ctx.stdout, envelope, { pretty: ctx.globals.pretty });
  if ((outcome.exitCode === 3 || outcome.exitCode === 4 || outcome.exitCode === 5) && typeof envelope.error === "string") {
    ctx.stderr.write(`${redactSecrets(envelope.error)}\n`);
  }
  return outcome.exitCode;
}

export function rejectPositionals(args: ParsedArgs): void {
  const [first] = args.positionals;
  if (first !== undefined) throw new UsageError(`Unexpected argument "${safeForDisplay(first)}".`);
}

async function runTool(ctx: CommandContext, spec: ToolSpec, args: ParsedArgs): Promise<number> {
  rejectPositionals(args);
  const toolArgs = flagsToArgs(spec, args);
  const seat = seatFor(ctx);
  if (spec.needsAgent) toolArgs["agent_id"] = agentFor(ctx, seat, toolArgs["agent_id"], { required: true });
  return emit(ctx, await callTool(seat, spec.tool, toolArgs), [seat.token]);
}

function toFlagSpec(flag: ToolFlag): FlagSpec {
  const out: FlagSpec = { name: flag.name, type: flag.type, description: flag.description };
  if (flag.file === true) out.file = true;
  if (flag.hidden === true) out.hidden = true;
  if (flag.negation !== undefined) out.negation = flag.negation;
  return out;
}

/** The command for one tool: its flags (minus the internal `arg` name) plus --json. */
export function commandForTool(spec: ToolSpec, run: CommandDef["run"]): CommandDef {
  const flags = spec.flags.map(toFlagSpec);
  return { name: spec.command, summary: spec.summary, group: "tools", flags: [...flags, JSON_FLAG], run };
}

/** Every tool but connect (connect.ts), in the order of spec §5.3. */
export const TOOL_COMMANDS: CommandDef[] = TOOL_SPECS.filter((spec) => spec.tool !== "connect").map((spec) =>
  commandForTool(spec, (ctx, args) => runTool(ctx, spec, args)),
);
