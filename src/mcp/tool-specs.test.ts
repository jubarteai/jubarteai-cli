import { describe, expect, it } from "vitest";

import { GLOBAL_FLAGS } from "../cli/args.js";
import { findToolSpec, TOOL_SPECS, toolSpecShape } from "./tool-specs.js";

// What the app's src/lib/mcp/tools/*.ts register today (the argument names of each zod schema).
const APP_SHAPE: Record<string, string[]> = {
  claim: ["agent_id", "resource", "ttl_seconds"],
  check_inbox: ["agent_id", "wait_seconds", "watch_minutes"],
  connect: ["description"],
  create_knowledge: ["agent_id", "branches", "description", "kind", "metadata", "paths", "refs", "repositories", "tags", "title"],
  disconnect: ["agent_id"],
  echo_current_task: ["agent_id", "branches", "description", "paths", "refs", "repositories", "tickets", "title"],
  get_knowledge: ["agent_id", "id", "name"],
  list_agents: ["agent_id"],
  list_knowledge_gaps: ["agent_id", "limit", "status"],
  list_knowledge_merges: ["agent_id", "limit", "status"],
  message_agents: ["agent_id", "all", "content", "priority", "reply_to", "to_agent_ids"],
  release: ["agent_id", "resource"],
  resolve_knowledge_merge: ["action", "agent_id", "description", "id", "snooze_days", "title"],
  search_knowledge: ["agent_id", "branches", "include_superseded", "kind", "limit", "needs_verification", "paths", "query", "refs", "repositories"],
  update_knowledge: ["agent_id", "branches", "description", "expected_updated_at", "id", "kind", "metadata", "paths", "refs", "repositories", "tags", "title"],
  verify_knowledge: ["agent_id", "expected_updated_at", "id"],
};

describe("TOOL_SPECS", () => {
  it("covers exactly the 16 tools the app registers, with their argument names", () => {
    expect(Object.keys(APP_SHAPE)).toHaveLength(16);
    expect(toolSpecShape()).toEqual(APP_SHAPE);
  });

  it("lists every argument name sorted", () => {
    for (const [tool, names] of Object.entries(toolSpecShape())) expect(names, tool).toEqual([...names].sort());
  });

  it("names flags in kebab-case after the argument, except message-agents' --to", () => {
    for (const spec of TOOL_SPECS) {
      for (const flag of spec.flags) {
        const expected = spec.tool === "message_agents" && flag.arg === "to_agent_ids" ? "to" : flag.arg.replaceAll("_", "-");
        expect(flag.name, `${spec.tool}.${flag.arg}`).toBe(expected);
      }
    }
  });

  it("has unique command names and flag names, none colliding with a global flag or --json", () => {
    expect(new Set(TOOL_SPECS.map((s) => s.command)).size).toBe(TOOL_SPECS.length);
    const reserved = new Set([...GLOBAL_FLAGS.map((f) => f.name), "json"]);
    for (const spec of TOOL_SPECS) {
      const names = spec.flags.map((f) => f.name);
      expect(new Set(names).size, spec.tool).toBe(names.length);
      for (const name of names) expect(reserved.has(name), `${spec.tool} --${name}`).toBe(false);
    }
  });

  it("gives the long-text flags a --x-file form and no others", () => {
    const withFile = TOOL_SPECS.flatMap((s) => s.flags.filter((f) => f.file === true).map((f) => `${s.tool}.${f.arg}`)).sort();
    expect(withFile).toEqual(
      ["create_knowledge.description", "message_agents.content", "resolve_knowledge_merge.description", "search_knowledge.query", "update_knowledge.description"].sort(),
    );
  });

  it("types the flags as the schemas do (arrays repeat, booleans toggle, metadata is JSON)", () => {
    const type = (tool: string, arg: string) => findToolSpec(tool)?.flags.find((f) => f.arg === arg)?.type;
    expect(type("create_knowledge", "branches")).toBe("string[]");
    expect(type("message_agents", "to_agent_ids")).toBe("string[]");
    expect(type("message_agents", "all")).toBe("boolean");
    expect(type("search_knowledge", "needs_verification")).toBe("boolean");
    expect(type("search_knowledge", "limit")).toBe("number");
    expect(type("claim", "ttl_seconds")).toBe("number");
    expect(type("create_knowledge", "metadata")).toBe("json");
  });

  it("marks connect as the only tool that takes no agent", () => {
    expect(TOOL_SPECS.filter((s) => !s.needsAgent).map((s) => s.tool)).toEqual(["connect"]);
  });
});
