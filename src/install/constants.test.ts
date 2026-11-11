import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NODE_FLOORS } from "../node-floor.js";
import {
  AGENTS_MD_MARKERS,
  SKILL_AGENT_DIRS,
  SKILL_NAME,
  SKILL_REPO,
  SKILLS_CLI_MIN_NODE,
  SKILLS_CLI_VERSION,
  agentsMdSnippet,
  agentsMdSnippetHistory,
} from "./constants.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const SPEC = new URL("../../../docs/plans/jubarteai-cli-spec.md", import.meta.url);
const SPEC_PRESENT = existsSync(SPEC);
if (!SPEC_PRESENT) {
  // Skip loudly: a CLI checkout without the superproject cannot compare the snippet with the spec.
  console.warn(`SKIPPED: ${SPEC.pathname} not found, so the snippet asset is not compared with spec Appendix A.`);
}

/** The inside of the fenced block between the spec's snippet markers, with a trailing newline (Appendix A's rule). */
function specSnippet(): string {
  const text = readFileSync(SPEC, "utf8");
  const begin = "<!-- spec:snippet:begin -->\n```markdown\n";
  const end = "\n```\n<!-- spec:snippet:end -->";
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return `${text.slice(from + begin.length, to)}\n`;
}

describe("install constants", () => {
  it("pins the skills CLI release and names the skill repo", () => {
    expect(SKILLS_CLI_VERSION).toBe("1.7.4");
    expect(SKILL_REPO).toBe("jubarteai/jubarteai-skills");
    expect(SKILL_NAME).toBe("jubarteai");
  });

  it("raises the skills Node minimum to the CLI's own floor on the 22 line (D33)", () => {
    expect(SKILLS_CLI_MIN_NODE).toBe("22.23.4");
    expect(SKILLS_CLI_MIN_NODE).toBe(NODE_FLOORS[22]);
  });

  it("keeps the marker comments install.sh wrote", () => {
    expect(AGENTS_MD_MARKERS).toEqual({ begin: "<!-- jubarteai:begin -->", end: "<!-- jubarteai:end -->" });
  });
});

describe("SKILL_AGENT_DIRS", () => {
  it("covers every verified harness plus universal", () => {
    const ids = ["claude-code", "codex", "cursor", "github-copilot", "windsurf", "zed", "gemini-cli", "opencode", "universal"];
    expect(Object.keys(SKILL_AGENT_DIRS).sort()).toEqual([...ids].sort());
  });

  it("matches where skills@1.7.4 really writes (project dirs from its table, global dirs observed)", () => {
    expect(SKILL_AGENT_DIRS["claude-code"]).toEqual({ project: ".claude/skills", global: ".claude/skills" });
    expect(SKILL_AGENT_DIRS["windsurf"]).toEqual({ project: ".windsurf/skills", global: ".codeium/windsurf/skills" });
    // Every agent whose project dir is .agents/skills shares ~/.agents/skills for a global install,
    // not the folder its own docs row lists (~/.cursor/skills, ~/.copilot/skills, ...).
    for (const id of ["codex", "cursor", "github-copilot", "zed", "gemini-cli", "opencode", "universal"]) {
      expect(SKILL_AGENT_DIRS[id], id).toEqual({ project: ".agents/skills", global: ".agents/skills" });
    }
  });

  it("holds relative paths that stay inside the project or home folder", () => {
    for (const [id, dirs] of Object.entries(SKILL_AGENT_DIRS)) {
      for (const dir of [dirs.project, dirs.global]) {
        expect(dir, id).toMatch(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
        expect(dir.split("/"), id).not.toContain("..");
      }
    }
  });
});

describe("agents-md-snippet.md", () => {
  it("is byte-identical to the canonical text in the spec's Appendix A", (ctx) => {
    if (!SPEC_PRESENT) ctx.skip();
    expect(agentsMdSnippet()).toBe(specSnippet());
  });

  it("starts at the section heading, ends with one newline and has no carriage returns", () => {
    const snippet = agentsMdSnippet();
    expect(snippet.startsWith("## JubarteAI Agent Identity\n")).toBe(true);
    expect(snippet.endsWith("\n")).toBe(true);
    expect(snippet.endsWith("\n\n")).toBe(false);
    expect(snippet).not.toContain("\r");
  });

  it("keeps the <repo-slug> placeholder the writer fills in, and none of the markers", () => {
    const snippet = agentsMdSnippet();
    expect(snippet).toContain("<repo-slug>");
    expect(snippet).not.toContain(AGENTS_MD_MARKERS.begin);
    expect(snippet).not.toContain(AGENTS_MD_MARKERS.end);
  });

  it("is the CLI-first section, not the MCP one", () => {
    expect(agentsMdSnippet()).toContain("jubarteai echo-current-task");
    expect(agentsMdSnippet()).not.toContain("mcp__jubarteai__*` tool name");
  });
});

describe("agents-md-snippet-history.json", () => {
  it("is an array of section texts, oldest first, ending with the pre-CLI installer's section", () => {
    const history = agentsMdSnippetHistory();
    expect(history).toHaveLength(2);
    // Entry 0 is pinned in the app too (src/lib/mcp/agents-md-snippet.test.ts); entry 1 is AGENTS_MD_SNIPPET before the CLI.
    expect(sha256(history[0] ?? "")).toBe("19c7a7f8d3dff2abda4335ccab70af79e76c20ddf2bd8d15a93750077c7bf974");
    expect(sha256(history[1] ?? "")).toBe("37042af0325973dc215a8267eb0ed613359fa88b4cecff9bd26ec45eb7401fb1");
  });

  it("holds only sections that begin at the heading and use the MCP tools", () => {
    for (const entry of agentsMdSnippetHistory()) {
      expect(entry.startsWith("## JubarteAI Agent Identity\n")).toBe(true);
      expect(entry).toContain("<repo-slug>");
      expect(entry).toContain("mcp__jubarteai__*");
    }
  });

  it("does not contain the current section (it would be refreshed into itself) and has no duplicates", () => {
    const history = agentsMdSnippetHistory();
    expect(history).not.toContain(agentsMdSnippet());
    expect(history).not.toContain(agentsMdSnippet().trimEnd());
    expect(new Set(history).size).toBe(history.length);
  });

  it("rejects a file that is not an array of strings", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => '{"not":"an array"}');
    expect(() => agentsMdSnippetHistory()).toThrow("array of strings");
    vi.mocked(readFileSync).mockImplementationOnce(() => '["ok", 2]');
    expect(() => agentsMdSnippetHistory()).toThrow("array of strings");
  });
});
