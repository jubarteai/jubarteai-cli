// Which agent a tool command acts as (spec §4 "Agent"): --agent, else this session's cached agent.
import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { safeForDisplay } from "../output.js";
import { entryBelongsToSeat, isAgentId, readSession } from "./cache.js";
import { sessionFromEnv } from "./harness-env.js";

export const NO_AGENT_MESSAGE = 'No agent for this session. Run: jubarteai connect --description "…"';

/**
 * `--agent` (a UUID) first. Otherwise the session cache, but only an entry written for the seat
 * being used: its origin and seat id must equal the seat's (an environment key has no seat id, so
 * the entry must carry that key's fingerprint instead). An entry for another account is never used. Neither → exit 2 with the connect hint.
 */
export function resolveAgent(opts: { flag?: string; seat: ResolvedSeat }): { agentId: string } | { error: string; exitCode: 2 } {
  if (opts.flag !== undefined) {
    const flag = opts.flag.trim();
    if (!isAgentId(flag)) {
      return { error: `--agent must be an agent id (a UUID), not "${safeForDisplay(opts.flag)}".`, exitCode: 2 };
    }
    return { agentId: flag };
  }

  const session = sessionFromEnv();
  if (session !== null) {
    const entry = readSession(session.harness, session.sessionId);
    if (entry !== null && entryBelongsToSeat(entry, opts.seat)) {
      return { agentId: entry.agent_id };
    }
  }
  return { error: NO_AGENT_MESSAGE, exitCode: 2 };
}
