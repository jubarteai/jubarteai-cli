import { describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import type { FlagSpec } from "../cli/args.js";
import { UsageError } from "../errors.js";
import { flagsToArgs } from "./flags-to-args.js";
import { findToolSpec } from "./tool-specs.js";
import type { ToolSpec } from "./tool-specs.js";

const JSON_FLAG: FlagSpec = { name: "json", type: "json", description: "" };

function spec(tool: string): ToolSpec {
  const found = findToolSpec(tool);
  if (found === undefined) throw new Error(`no spec ${tool}`);
  return found;
}

function args(tool: string, argv: string[], readStdin?: () => Buffer): Record<string, unknown> {
  const s = spec(tool);
  return flagsToArgs(s, parseArgs(argv, [...s.flags, JSON_FLAG], readStdin === undefined ? {} : { readStdin }));
}

describe("flagsToArgs", () => {
  it("maps each flag to its snake_case argument with the right type", () => {
    expect(
      args("search_knowledge", ["--query", "how do hooks work", "--branches", "main", "--branches", "dev", "--kind", "workdone", "--needs-verification", "--limit", "5"]),
    ).toEqual({ query: "how do hooks work", branches: ["main", "dev"], kind: "workdone", needs_verification: true, limit: 5 });
  });

  it("sends an explicit false for --no-x, and nothing for a flag that was not given", () => {
    expect(args("search_knowledge", ["--no-include-superseded"])).toEqual({ include_superseded: false });
    expect(args("search_knowledge", [])).toEqual({});
  });

  it("maps message-agents --to to to_agent_ids and --reply-to to reply_to", () => {
    expect(args("message_agents", ["--to", "a", "--to", "b", "--content", "hi", "--reply-to", "m1", "--priority", "urgent"])).toEqual({
      to_agent_ids: ["a", "b"],
      content: "hi",
      reply_to: "m1",
      priority: "urgent",
    });
  });

  it("parses --metadata as an object", () => {
    expect(args("create_knowledge", ["--metadata", '{"status":"done","related_ids":["x"]}'])).toEqual({
      metadata: { status: "done", related_ids: ["x"] },
    });
  });

  it("reads a long value from stdin with --x-file -", () => {
    expect(args("create_knowledge", ["--description-file", "-"], () => Buffer.from("line one\nline two"))).toEqual({ description: "line one\nline two" });
  });

  it("takes the whole object from --json and lets flags override its keys", () => {
    expect(args("claim", ["--json", '{"resource":"a","ttl_seconds":60,"extra":1}', "--resource", "b"])).toEqual({
      resource: "b",
      ttl_seconds: 60,
      extra: 1,
    });
  });

  it("passes unknown keys in --json through and keeps a literal __proto__ key as data", () => {
    const result = args("claim", ["--json", '{"__proto__":{"polluted":true},"resource":"r"}']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(JSON.stringify(result)).toContain('"__proto__"');
  });

  it("rejects a --json that is not an object", () => {
    expect(() => args("claim", ["--json", "[1,2]"])).toThrow(UsageError);
    expect(() => args("claim", ["--json", "null"])).toThrow(UsageError);
    expect(() => args("claim", ["--json", '"text"'])).toThrow(UsageError);
  });

  it("leaves agent_id to the caller", () => {
    expect(args("list_agents", [])).not.toHaveProperty("agent_id");
  });
});
