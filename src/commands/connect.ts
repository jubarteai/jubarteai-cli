import { CliError, UsageError } from "../errors.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import type { ParsedArgs } from "../cli/args.js";
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { callTool } from "../mcp/client.js";
import type { Envelope } from "../mcp/client.js";
import { flagsToArgs } from "../mcp/flags-to-args.js";
import { findToolSpec } from "../mcp/tool-specs.js";
import type { ToolSpec } from "../mcp/tool-specs.js";
import { isAgentId, keyFingerprint, writeSession } from "../session/cache.js";
import { sessionFromEnv } from "../session/harness-env.js";
import { redactSecrets } from "../output.js";
import { commandForTool, emit, rejectPositionals, seatFor } from "./tool.js";

const CONNECT_SPEC = ((): ToolSpec => {
  const spec = findToolSpec("connect");
  if (spec === undefined) throw new Error("the connect tool spec is missing");
  return spec;
})();

function agentFromEnvelope(envelope: Envelope): { agentId: string; name?: string } | null {
  const result = envelope.result;
  if (typeof result !== "object" || result === null) return null;
  const agentId = (result as Record<string, unknown>)["agent_id"];
  const name = (result as Record<string, unknown>)["name"];
  if (typeof agentId !== "string" || !isAgentId(agentId)) return null;
  return typeof name === "string" && name.length > 0 && name.length <= 200 ? { agentId, name } : { agentId };
}

/**
 * Remembers the new agent for this harness session, unless the session already has one (the first
 * agent a session was given stays its agent). Hints go to stderr; the envelope on stdout is untouched.
 */
function rememberAgent(ctx: CommandContext, seat: ResolvedSeat, envelope: Envelope): void {
  const agent = agentFromEnvelope(envelope);
  if (agent === null) return;
  const session = sessionFromEnv();
  if (session === null) {
    ctx.stderr.write(`No session id in the environment, so nothing was remembered: pass --agent ${agent.agentId} on every later command.\n`);
    return;
  }
  try {
    const identity = { origin: seat.origin, seatId: seat.seatId, token: seat.token };
    const { written } = writeSession(
      session.harness,
      session.sessionId,
      {
        harness: session.harness,
        agent_id: agent.agentId,
        seat_id: seat.seatId,
        origin: seat.origin,
        ...(seat.seatId === null ? { key_fp: keyFingerprint(seat.token) } : {}),
        ...(agent.name === undefined ? {} : { name: agent.name }),
      },
      { overwrite: false, seat: identity },
    );
    ctx.stderr.write(
      written
        ? "Agent cached for this session: later commands use it without --agent.\n"
        : "Kept the existing agent for this session, so later commands still use it. Pass --agent <id> to act as the new one.\n",
    );
  } catch (error) {
    const reason = error instanceof CliError ? redactSecrets(error.message) : "Could not write the session cache.";
    ctx.stderr.write(`${reason} Pass --agent ${agent.agentId} on every later command.\n`);
  }
}

async function runConnect(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (ctx.globals.agent !== undefined) {
    throw new UsageError("connect always registers a new agent; --agent does not apply to it.");
  }
  rejectPositionals(args);
  const toolArgs = flagsToArgs(CONNECT_SPEC, args);
  const seat = seatFor(ctx);
  const outcome = await callTool(seat, "connect", toolArgs);
  const code = emit(ctx, outcome, [seat.token]);
  if (outcome.exitCode === 0) rememberAgent(ctx, seat, outcome.envelope);
  return code;
}

export const connectCommand: CommandDef = {
  ...commandForTool(CONNECT_SPEC, runConnect),
  usage: "connect [--description <text>]",
};
