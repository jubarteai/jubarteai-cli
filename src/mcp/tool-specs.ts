// Static specs of the 16 MCP tools, so `--help` works offline. They mirror the zod schemas in the app
// (src/lib/mcp/tools/*.ts): same tool names and the same argument names. The app's drift guard
// (e2e/cli-binary.spec.ts) compares toolSpecShape() with the live tools/list, so a tool or argument
// added on the server fails there until this file follows. Enums, ranges and required-ness stay
// the server's to enforce; the description text only tells a reader what to expect.
import type { FlagSpec } from "../cli/args.js";

export type ToolFlag = FlagSpec & { arg: string };
export type ToolSpec = {
  tool: string;
  command: string;
  summary: string;
  flags: ToolFlag[];
  needsAgent: boolean;
};

/** A flag named after its argument: `--ttl-seconds` for `ttl_seconds`. */
function flag(
  arg: string,
  type: FlagSpec["type"],
  description: string,
  extra: { file?: boolean; name?: string; negation?: string } = {},
): ToolFlag {
  const spec: ToolFlag = { name: extra.name ?? arg.replaceAll("_", "-"), arg, type, description };
  if (extra.file === true) spec.file = true;
  if (extra.negation !== undefined) spec.negation = extra.negation;
  return spec;
}

const KINDS = "knowledge | memory | decision | note | workdone";

/** The write flags create_knowledge and update_knowledge share. */
function knowledgeWriteFlags(): ToolFlag[] {
  return [
    flag("title", "string", "Entry title"),
    flag("description", "string", "Entry body", { file: true }),
    flag("branches", "string[]", "Branch label (repeat for several)"),
    flag("repositories", "string[]", "Repository slug (repeat for several)"),
    flag("refs", "string[]", "Ticket id or issue/PR URL (repeat for several)"),
    flag("tags", "string[]", "Keyword label (repeat for several)"),
    flag("kind", "string", `Entry kind: ${KINDS}`),
    flag("paths", "string[]", "Repo-relative file or folder the entry describes (repeat for several)"),
    flag("metadata", "json", "Small object: status, supersedes, related_ids (JSON, @file or -)"),
  ];
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    tool: "connect",
    command: "connect",
    summary: "Register a new agent for this session and print its agent_id",
    flags: [flag("description", "string", "What this agent is (IDE or harness, and the surface area), not the current task")],
    needsAgent: false,
  },
  {
    tool: "disconnect",
    command: "disconnect",
    summary: "Mark this agent finished; it drops out of peers' list-agents",
    flags: [],
    needsAgent: true,
  },
  {
    tool: "list_agents",
    command: "list-agents",
    summary: "List the active agents in the workspace with their tasks and claims",
    flags: [],
    needsAgent: true,
  },
  {
    tool: "echo_current_task",
    command: "echo-current-task",
    summary: "Broadcast what this agent is working on and see who overlaps",
    flags: [
      flag("title", "string", "Task title"),
      flag("description", "string", "Task description"),
      flag("tickets", "string[]", "Ticket id (repeat for several)"),
      flag("refs", "string[]", "Reference (repeat for several)"),
      flag("branches", "string[]", "Branch being worked on (repeat for several)"),
      flag("repositories", "string[]", "Repository slug (repeat for several)"),
      flag("paths", "string[]", "Repo-relative path being touched (repeat for several)"),
    ],
    needsAgent: true,
  },
  {
    tool: "search_knowledge",
    command: "search-knowledge",
    summary: "Search knowledge entries by prose query and/or metadata filters",
    flags: [
      flag("query", "string", "What you are looking for, in your own words", { file: true }),
      flag("branches", "string[]", "Only entries on this branch (repeat for several)"),
      flag("repositories", "string[]", "Only entries for this repository (repeat for several)"),
      flag("refs", "string[]", "Only entries with this ref (repeat for several)"),
      flag("kind", "string", `Only this kind: ${KINDS}`),
      flag("paths", "string[]", "Only entries touching this path (repeat for several)"),
      flag("needs_verification", "boolean", "Only entries flagged (or not flagged) for re-verification", {
        negation: "Only entries not flagged for re-verification",
      }),
      flag("include_superseded", "boolean", "Include entries another entry supersedes"),
      flag("limit", "number", "Most results to return (1-50, default 10)"),
    ],
    needsAgent: true,
  },
  {
    tool: "get_knowledge",
    command: "get-knowledge",
    summary: "Read one knowledge entry in full, by id or exact title",
    flags: [flag("id", "string", "Entry id"), flag("name", "string", "Exact entry title")],
    needsAgent: true,
  },
  {
    tool: "create_knowledge",
    command: "create-knowledge",
    summary: "Save a new knowledge entry",
    flags: knowledgeWriteFlags(),
    needsAgent: true,
  },
  {
    tool: "update_knowledge",
    command: "update-knowledge",
    summary: "Change a knowledge entry (a title or description edit re-verifies it)",
    flags: [
      flag("id", "string", "Entry id"),
      ...knowledgeWriteFlags(),
      flag("expected_updated_at", "string", "updated_at from get-knowledge: refuse the write if the entry changed since"),
    ],
    needsAgent: true,
  },
  {
    tool: "verify_knowledge",
    command: "verify-knowledge",
    summary: "Confirm a knowledge entry is still true after re-checking it",
    flags: [
      flag("id", "string", "Entry id"),
      flag("expected_updated_at", "string", "updated_at from get-knowledge: refuse if the entry changed since"),
    ],
    needsAgent: true,
  },
  {
    tool: "message_agents",
    command: "message-agents",
    summary: "Send a message to agents, reply to one, or broadcast",
    flags: [
      flag("to_agent_ids", "string[]", "Recipient agent id (repeat for several)", { name: "to" }),
      flag("all", "boolean", "Broadcast to every active agent"),
      flag("content", "string", "Message text (at most 2000 characters)", { file: true }),
      flag("priority", "string", "normal (default) | urgent"),
      flag("reply_to", "string", "Id of a message you received, to thread the reply"),
    ],
    needsAgent: true,
  },
  {
    tool: "check_inbox",
    command: "check-inbox",
    summary: "Deliver unread peer messages (raw tool call; see inbox for the friendlier form)",
    flags: [
      flag("wait_seconds", "number", "Hold the call open up to this long for a message (at most 40)"),
      flag("watch_minutes", "number", "Also issue an inbox watch for this many minutes (1-120)"),
    ],
    needsAgent: true,
  },
  {
    tool: "claim",
    command: "claim",
    summary: "Advisorily claim a resource (a path, ticket, module) so peers avoid it",
    flags: [
      flag("resource", "string", "What to claim (at most 500 characters)"),
      flag("ttl_seconds", "number", "Claim lifetime in seconds (60-7200, default 900)"),
    ],
    needsAgent: true,
  },
  {
    tool: "release",
    command: "release",
    summary: "Release a resource this agent claimed",
    flags: [flag("resource", "string", "What to release")],
    needsAgent: true,
  },
  {
    tool: "list_knowledge_gaps",
    command: "list-knowledge-gaps",
    summary: "List questions agents searched for and found nothing",
    flags: [
      flag("status", "string", "open (default) | answered | dismissed"),
      flag("limit", "number", "Most gaps to return (1-50, default 10)"),
    ],
    needsAgent: true,
  },
  {
    tool: "list_knowledge_merges",
    command: "list-knowledge-merges",
    summary: "List proposed merges of near-duplicate knowledge entries",
    flags: [
      flag("status", "string", "pending (default) | approved | rejected | stale | snoozed"),
      flag("limit", "number", "Most proposals to return (1-50, default 10)"),
    ],
    needsAgent: true,
  },
  {
    tool: "resolve_knowledge_merge",
    command: "resolve-knowledge-merge",
    summary: "Approve, reject or snooze a proposed merge",
    flags: [
      flag("id", "string", "Proposal id"),
      flag("action", "string", "approve | reject | snooze"),
      flag("title", "string", "Override the drafted title when approving"),
      flag("description", "string", "Override the drafted body when approving", { file: true }),
      flag("snooze_days", "number", "With snooze: days to park it (1-90, default 14)"),
    ],
    needsAgent: true,
  },
];

export function findToolSpec(tool: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.tool === tool);
}

/**
 * `{ tool: sorted argument names }`, what the app's drift guard compares with the live
 * tools/list: every tool's `agent_id` (when it takes one) plus the argument each flag fills.
 */
export function toolSpecShape(): Record<string, string[]> {
  const shape: Record<string, string[]> = {};
  for (const spec of TOOL_SPECS) {
    const names = spec.flags.map((f) => f.arg);
    if (spec.needsAgent) names.push("agent_id");
    shape[spec.tool] = names.sort();
  }
  return shape;
}
