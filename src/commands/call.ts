import type { CommandDef } from "../cli/commands.js";
import { UsageError } from "../errors.js";
import { safeForDisplay } from "../output.js";
import { callTool } from "../mcp/client.js";
import { findToolSpec } from "../mcp/tool-specs.js";
import { JSON_FLAG, agentFor, emit, seatFor } from "./tool.js";

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * `jubarteai call <tool> --json …`: any tool by name, including one this CLI version doesn't know.
 * A tool the CLI knows keeps its rules (a tool that takes an agent needs one). For an unknown tool
 * `agent_id` is filled from --agent / the session cache when one resolves and left alone otherwise.
 * It never touches the session cache: use `connect` to register an agent.
 */
export const callCommand: CommandDef = {
  name: "call",
  summary: "Call any MCP tool by name with --json arguments",
  group: "tools",
  flags: [JSON_FLAG],
  usage: "call <tool> [--json <json|@file|->]",
  async run(ctx, args) {
    const [tool, extra] = args.positionals;
    if (tool === undefined) throw new UsageError("call needs a tool name, like: jubarteai call list_agents");
    if (extra !== undefined) throw new UsageError(`Unexpected argument "${safeForDisplay(extra)}".`);
    if (!TOOL_NAME_RE.test(tool)) throw new UsageError(`"${safeForDisplay(tool)}" is not a tool name.`);

    const base = args.flags["json"];
    if (base !== undefined && (typeof base !== "object" || base === null || Array.isArray(base))) {
      throw new UsageError('--json must be a JSON object, like {"limit":5}.');
    }
    const toolArgs: Record<string, unknown> = base === undefined ? {} : { ...(base as Record<string, unknown>) };

    const known = findToolSpec(tool);
    if (known !== undefined && !known.needsAgent && ctx.globals.agent !== undefined) {
      throw new UsageError(`${tool} registers a new agent; --agent does not apply to it.`);
    }
    const seat = seatFor(ctx);
    if (known === undefined || known.needsAgent) {
      const agentId = agentFor(ctx, seat, toolArgs["agent_id"], { required: known !== undefined });
      if (agentId !== undefined) toolArgs["agent_id"] = agentId;
    }
    return emit(ctx, await callTool(seat, tool, toolArgs), [seat.token]);
  },
};
