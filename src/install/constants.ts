import { readFileSync } from "node:fs";

// Values the install and update steps share. Ported from the app's
// src/lib/mcp/ide-configs.ts (the old install.sh / update.sh constants).

/**
 * The exact `skills` CLI release `init` and `update` run (`npx -y skills@<this> add ...`). Pinned so a
 * new release can't change what the CLI does, or the Node it needs, under users without a CLI release.
 * Bumping it: run `npm view skills@<v> engines`, re-derive SKILL_AGENT_DIRS below, and update the Node floor tests.
 */
export const SKILLS_CLI_VERSION = "1.7.4";

/**
 * The oldest Node the skill-install step runs on. skills@1.7.4 declares `engines.node >=22.20.0`, but D33 raised
 * the floor to the patched release of each LTS line (22.23.4 on the 22 line), and the CLI refuses to start below
 * it. This is raised to match (D33), and the skill step compares the running Node against it.
 * Must stay equal to NODE_FLOORS[22] in ../node-floor.ts (constants.test.ts checks).
 */
export const SKILLS_CLI_MIN_NODE = "22.23.4";

export const SKILL_REPO = "jubarteai/jubarteai-skills";
export const SKILL_NAME = "jubarteai";

/**
 * Where `skills@SKILLS_CLI_VERSION add -a <agent>` puts the skill, per `-a` id: `project` is relative to the
 * project root, `global` (`add -g`) relative to the home directory.
 *
 * Re-derived on 2026-11-10 by running skills@1.7.4 itself in a throwaway HOME and project, once per agent
 * (`add <dir> -a <id> -y` and `add <dir> -g -a <id> -y`), and reading where SKILL.md landed. The agent ids and
 * project dirs match the package's own table (`docs/agents.md`, P2 finding 9). The global dirs follow what
 * the CLI writes, not that table: for every agent whose project dir is `.agents/skills` (cursor, github-copilot,
 * codex, zed, gemini-cli, opencode, universal) a global install goes to the shared `~/.agents/skills`, never to
 * the agent's own folder the table lists (`~/.cursor/skills`, `~/.copilot/skills`, `~/.gemini/skills`,
 * `~/.config/opencode/skills`). That is what the app's old table said (spike S1b), so it matches the old values
 * for cursor and github-copilot and the doc table was the stale side. windsurf and claude-code have their own dirs.
 * `universal` stays for callers that group agents sharing one dir.
 */
export const SKILL_AGENT_DIRS: Readonly<Record<string, { project: string; global: string }>> = {
  "claude-code": { project: ".claude/skills", global: ".claude/skills" },
  codex: { project: ".agents/skills", global: ".agents/skills" },
  cursor: { project: ".agents/skills", global: ".agents/skills" },
  "github-copilot": { project: ".agents/skills", global: ".agents/skills" },
  windsurf: { project: ".windsurf/skills", global: ".codeium/windsurf/skills" },
  zed: { project: ".agents/skills", global: ".agents/skills" },
  "gemini-cli": { project: ".agents/skills", global: ".agents/skills" },
  opencode: { project: ".agents/skills", global: ".agents/skills" },
  universal: { project: ".agents/skills", global: ".agents/skills" },
};

/**
 * The comments the installer wraps around the section it writes into AGENTS.md, so `update` can find exactly
 * that span later and tell it apart from text the user wrote around it. Invisible when rendered.
 */
export const AGENTS_MD_MARKERS = {
  begin: "<!-- jubarteai:begin -->",
  end: "<!-- jubarteai:end -->",
} as const;

const SNIPPET_ASSET = new URL("../../assets/agents-md-snippet.md", import.meta.url);
const HISTORY_ASSET = new URL("../../assets/agents-md-snippet-history.json", import.meta.url);

/**
 * The section as shipped: from `## JubarteAI Agent Identity` to the end, with a trailing newline, and its
 * `<repo-slug>` placeholder still in place (the writer fills it in). Byte-identical to Appendix A of the spec.
 */
export function agentsMdSnippet(): string {
  return readFileSync(SNIPPET_ASSET, "utf8");
}

/**
 * Every section an earlier installer wrote, oldest first, exactly as rendered before the `<repo-slug>`
 * substitution; the last entry is the section of the app's pre-CLI installer. `update` replaces a section only
 * when it is byte-identical to one of these (slug filled in): any other text is the user's. When the snippet
 * changes, append the old text here before editing the asset.
 */
export function agentsMdSnippetHistory(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(HISTORY_ASSET, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("assets/agents-md-snippet-history.json must be an array of strings");
  }
  return parsed;
}
