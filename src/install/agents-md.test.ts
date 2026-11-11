import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, summarize, type StepResult } from "../safe-edit/plan.js";
import { AGENTS_MD_MARKERS, agentsMdSnippet, agentsMdSnippetHistory } from "./constants.js";
import { inspectInstructions, notProjectReason, planInstructionSteps, type InstructionOptions } from "./agents-md.js";

// The scenarios below are ported from the app's update.sh and install.sh tests
// (src/lib/update-script/instructions.test.ts, src/lib/install-script.test.ts). Each carries a
// `// ported: <old test name>` comment. They ran the bash scripts in a sandbox; these run the TypeScript steps in one.

const POSIX = process.platform !== "win32";
const SLUG = "demo";
const { begin: BEGIN, end: END } = AGENTS_MD_MARKERS;
const CURRENT_URL = "https://github.com/jubarteai/jubarteai-skills/blob/main/AGENTS.md";

/** install.sh trimmed blanks at both ends of the snippet, then filled in the slug. */
const trimBlanks = (s: string): string => s.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
const rendered = (snippet: string): string => trimBlanks(snippet).split("<repo-slug>").join(SLUG);
const CURRENT = rendered(agentsMdSnippet());
const OLD = agentsMdSnippetHistory().map(rendered);
const SECTION = `${BEGIN}\n${CURRENT}\n${END}`;
const MARKED_OLD = (i: number): string => `${BEGIN}\n${OLD[i]}\n${END}`;
const HISTORY_INDEXES = agentsMdSnippetHistory().map((_, i) => i);

let base: string;
let home: string;
let proj: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

function git(args: string[], cwd = proj): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-agentsmd-")));
  home = join(base, "home");
  proj = join(home, "demo");
  mkdirSync(proj, { recursive: true, mode: 0o755 });
  chmodSync(home, 0o700);
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  git(["init", "-q", "."]);
  git(["remote", "add", "origin", "git@github.com:acme/demo.git"]);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  rmSync(base, { recursive: true, force: true });
});

const at = (name: string): string => join(proj, name);
function put(name: string, content: string, mode?: number): string {
  const file = at(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
  return file;
}
const read = (name: string): string => readFileSync(at(name), "utf8");
const exists = (name: string): boolean => {
  try {
    lstatSync(at(name));
    return true;
  } catch {
    return false;
  }
};
const backdate = (...files: string[]): void => {
  const old = new Date("2020-01-01T00:00:00Z");
  for (const f of files) utimesSync(f, old, old);
};

/** Every file in the project (not .git) with its bytes, mode and mtime: a rewrite shows even when the bytes are equal. */
function snapshot(): Record<string, { content: string; mode: number; mtimeMs: number }> {
  const out: Record<string, { content: string; mode: number; mtimeMs: number }> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = statSync(full);
        out[relative(proj, full)] = { content: readFileSync(full, "utf8"), mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(proj);
  return out;
}

type Ran = { ids: string[]; results: StepResult[]; by: (id: string) => StepResult };
async function run(mode: "init" | "update", opts: Partial<InstructionOptions> = {}): Promise<Ran> {
  const steps = planInstructionSteps(proj, { mode, ...opts });
  const results: StepResult[] = [];
  for (const step of steps) results.push(await step.apply());
  const by = (id: string): StepResult => {
    const hit = results.find((r) => r.id === id);
    if (hit === undefined) throw new Error(`no step ${id}; ran ${steps.map((s) => s.id).join(", ")}`);
    return hit;
  };
  return { ids: steps.map((s) => s.id), results, by };
}

describe("missing", () => {
  // ported: appends the marked section to an existing AGENTS.md: original bytes, a blank line, the section (what install.sh writes)
  it("appends the marked section to an existing AGENTS.md: original bytes, a blank line, the section", async () => {
    const original = "# Demo\n\nBuild with make.\n";
    put("AGENTS.md", original);
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${original}\n\n${SECTION}\n`);
    expect(r.by("agents-md")).toMatchObject({ status: "configured", detail: "appended" });
    // No CLAUDE.md is invented for a Claude Code that reads AGENTS.md itself (or is not installed).
    expect(exists("CLAUDE.md")).toBe(false);
  });

  // ported: creates AGENTS.md as exactly the marked section when there is none
  it("creates AGENTS.md as exactly the marked section when there is none", async () => {
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
    expect(r.by("agents-md")).toMatchObject({ status: "configured", detail: "created" });
    // A new file is 0644 whatever the umask.
    if (POSIX) expect(statSync(at("AGENTS.md")).mode & 0o777).toBe(0o644);
  });

  // ported: writes the same bytes install.sh does, on both the create and the append path
  it("init and update write the same AGENTS.md bytes, on the create and the append path", async () => {
    const original = "# Demo\n\nBuild with make.\n";
    for (const seed of [null, original]) {
      rmSync(at("AGENTS.md"), { force: true });
      rmSync(at("CLAUDE.md"), { force: true });
      if (seed !== null) put("AGENTS.md", seed);
      await run("init");
      const viaInit = read("AGENTS.md");
      rmSync(at("AGENTS.md"), { force: true });
      rmSync(at("CLAUDE.md"), { force: true });
      if (seed !== null) put("AGENTS.md", seed);
      await run("update");
      expect(read("AGENTS.md")).toBe(viaInit);
      expect(viaInit).toBe(seed === null ? `${SECTION}\n` : `${seed}\n\n${SECTION}\n`);
    }
  });

  // ported: is not planned or written when only CLAUDE.md carries the section (the install.sh cross-file guard)
  // ported: CLAUDE.md already holds the section: reported as already covered, AGENTS.md is not created and CLAUDE.md is untouched
  it("adds nothing when only CLAUDE.md carries the section (the cross-file guard), and says it is covered", async () => {
    put("CLAUDE.md", `# Claude\n\n${CURRENT}\n`);
    const before = snapshot();
    expect(planInstructionSteps(proj, { mode: "update" })).toEqual([]);
    const r = await run("init");
    expect(r.ids).toEqual(["agents-md"]);
    expect(r.by("agents-md")).toMatchObject({ status: "already configured", detail: "the section is in CLAUDE.md" });
    expect(exists("AGENTS.md")).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  // ported: cross-file guard: pre-existing CLAUDE.md with a JubarteAI section blocks AGENTS.md creation
  it("a CLAUDE.md that only mentions JubarteAI also blocks AGENTS.md creation, and is reported, not changed", async () => {
    put("AGENTS.md", "# Demo\n");
    put("CLAUDE.md", "# Claude\n\nJubarteAI: connect first.\n");
    const r = await run("update");
    expect(r.ids).toEqual([]);
    expect(read("AGENTS.md")).toBe("# Demo\n");
    expect(read("CLAUDE.md")).toBe("# Claude\n\nJubarteAI: connect first.\n");
    expect(inspectInstructions(proj).reports).toEqual([
      `CLAUDE.md: mentions JubarteAI without the standard section — left as it is; the current section is at ${CURRENT_URL}`,
    ]);
  });
});

describe("known-old", () => {
  // ported: replaces history entry %i, unmarked in the middle of the file, with the marked current section; the bytes around it are identical
  it.each(HISTORY_INDEXES)("replaces history entry %i, unmarked in the middle of the file, with the marked current section", async (i) => {
    const head = "# Demo\n\nRules above.\n\n";
    const tail = "\n\n## Other notes\n\nRules below, no trailing newline";
    put("AGENTS.md", `${head}${OLD[i]}${tail}`);
    expect(inspectInstructions(proj).agentsMd).toBe("known-old");
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${head}${SECTION}${tail}`);
    expect(r.by("agents-md")).toMatchObject({ status: "configured", detail: "refreshed" });
    expect(inspectInstructions(proj).agentsMd).toBe("current");
  });

  // ported: replaces history entry %i inside the markers: only the inner text changes
  it.each(HISTORY_INDEXES)("replaces history entry %i inside the markers: only the inner text changes", async (i) => {
    const head = "# Demo\n\nBefore.\n\n";
    const tail = "\n\nAfter.\n";
    put("AGENTS.md", `${head}${MARKED_OLD(i)}${tail}`);
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${head}${SECTION}${tail}`);
    expect(r.by("agents-md").detail).toBe("refreshed");
  });

  // ported: matches an old section as the installer wrote it, with the project's own repo slug
  it("matches an old section as the installer wrote it, with the project's own repo slug", async () => {
    git(["remote", "set-url", "origin", "git@github.com:acme/other-repo.git"]);
    const old = trimBlanks(agentsMdSnippetHistory()[0] ?? "")
      .split("<repo-slug>")
      .join("other-repo");
    put("AGENTS.md", `${old}\n`);
    await run("update");
    expect(read("AGENTS.md")).toBe(`${BEGIN}\n${trimBlanks(agentsMdSnippet()).split("<repo-slug>").join("other-repo")}\n${END}\n`);
  });

  it("does not match an old section written for another slug: it is customised text, left alone", async () => {
    put("AGENTS.md", `${trimBlanks(agentsMdSnippetHistory()[0] ?? "").split("<repo-slug>").join("someone-elses-repo")}\n`);
    const before = snapshot();
    const r = await run("update");
    expect(r.ids).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj).agentsMd).toBe("edited");
  });

  // ported: replaces a section that lives only in CLAUDE.md, in CLAUDE.md, and does not create AGENTS.md
  it("replaces a section that lives only in CLAUDE.md, in CLAUDE.md, and does not create AGENTS.md", async () => {
    const head = "# Claude rules\n\n";
    const tail = "\n\nMore.\n";
    put("CLAUDE.md", `${head}${OLD[0]}${tail}`);
    const r = await run("update");
    expect(read("CLAUDE.md")).toBe(`${head}${SECTION}${tail}`);
    expect(exists("AGENTS.md")).toBe(false);
    expect(r.ids).toEqual(["claude-md-section"]);
    expect(r.by("claude-md-section")).toMatchObject({ status: "configured", detail: "refreshed" });
  });

  // ported: refreshes both files when both carry an old section
  it("refreshes both files when both carry an old section", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    put("CLAUDE.md", `# C\n\n${OLD[0]}\n`);
    await run("update");
    expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
    expect(read("CLAUDE.md")).toBe(`# C\n\n${SECTION}\n`);
  });

  // ported: keeps the file mode and leaves no temp file behind
  it.skipIf(!POSIX)("keeps the file mode and leaves no temp file behind", async () => {
    put("AGENTS.md", `${OLD[0]}\n`, 0o600);
    await run("update");
    expect(statSync(at("AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(readdirSync(proj).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  // ported: writes through a symlink to its target and keeps the link
  it.skipIf(!POSIX)("writes through a symlink to its target and keeps the link", async () => {
    const target = put("docs/agents-real.md", `${OLD[0]}\n`);
    symlinkSync("docs/agents-real.md", at("AGENTS.md"));
    await run("update");
    expect(lstatSync(at("AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(`${SECTION}\n`);
  });

  // ported: reports a file with other hard links and leaves it unchanged (the rename would split the links)
  it.skipIf(!POSIX)("reports a file with other hard links and leaves it unchanged", async () => {
    const file = put("AGENTS.md", `# Demo\n\n${OLD[0]}\n`);
    linkSync(file, join(base, "AGENTS-hard-link.md"));
    const before = readFileSync(file, "utf8");
    const r = await run("update");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).nlink).toBe(2);
    expect(r.by("agents-md")).toMatchObject({ status: "skipped", detail: "AGENTS.md has other hard links, so it was left unchanged" });
  });

  it.skipIf(!POSIX)("refuses a symlink that leads outside the home folder and leaves its target alone", async () => {
    const outside = join(base, "outside.md");
    writeFileSync(outside, `${OLD[0]}\n`);
    symlinkSync(outside, at("AGENTS.md"));
    const r = await run("update");
    expect(readFileSync(outside, "utf8")).toBe(`${OLD[0]}\n`);
    expect(r.by("agents-md")).toMatchObject({ status: "skipped" });
    expect(r.by("agents-md").detail).toContain("outside your home folder");
  });

  it.skipIf(!POSIX)("refuses a project folder that other users can write to", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    chmodSync(proj, 0o777);
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${OLD[0]}\n`);
    expect(r.by("agents-md")).toMatchObject({ status: "skipped", detail: "AGENTS.md sits in a folder that others can write to, so it was left unchanged" });
  });
});

describe("current", () => {
  // ported: leaves a %s current section alone, with no write (mtime unchanged)
  it.each([
    ["marked", `# Demo\n\n${SECTION}\n\nTail.\n`],
    ["unmarked (an install from before the markers)", `# Demo\n\n${CURRENT}\n\nTail.\n`],
  ])("leaves a %s current section alone, with no write (mtime unchanged)", async (_label, content) => {
    backdate(put("AGENTS.md", content));
    const before = snapshot();
    expect(planInstructionSteps(proj, { mode: "update" })).toEqual([]);
    const r = await run("init");
    expect(r.by("agents-md").status).toBe("already configured");
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj)).toMatchObject({ agentsMd: "current", reports: [] });
  });
});

describe("custom and mention-only", () => {
  // ported: leaves an edited marked section alone and says it is customised
  it("leaves an edited marked section alone and says it is customised", async () => {
    backdate(put("AGENTS.md", `# Demo\n\n${BEGIN}\n${CURRENT}\nOur own extra rule.\n${END}\n`));
    const before = snapshot();
    const r = await run("init");
    expect(r.by("agents-md")).toMatchObject({ status: "skipped", detail: "customised, left as it is" });
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj)).toEqual({
      agentsMd: "edited",
      claudeMdImport: "n/a",
      reports: [`AGENTS.md: customised JubarteAI section — compare with the current one at ${CURRENT_URL} by hand`],
    });
  });

  // ported: leaves a hand-written section under the standard heading alone (unmarked custom)
  it("leaves a hand-written section under the standard heading alone", async () => {
    backdate(put("AGENTS.md", "# Demo\n\n## JubarteAI Agent Identity\n\nOur own words. Connect first.\n"));
    const before = snapshot();
    await run("init");
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj).reports).toHaveLength(1);
    expect(inspectInstructions(proj).reports[0]).toContain("customised JubarteAI section");
  });

  // ported: treats unbalanced or reordered markers as customised, never touching them
  it("treats unbalanced or reordered markers as customised, never touching them", async () => {
    for (const content of [
      `${BEGIN}\n${OLD[0]}\n`,
      `${END}\n${OLD[0]}\n${BEGIN}\n`,
      `${BEGIN}\n${OLD[0]}\n${END}\n${BEGIN}\n${OLD[0]}\n${END}\n`,
      `${BEGIN}\r\n${OLD[0]}\r\n${END}\r\n`,
    ]) {
      put("AGENTS.md", content);
      const r = await run("update");
      expect(r.ids).toEqual([]);
      expect(read("AGENTS.md")).toBe(content);
      expect(inspectInstructions(proj).agentsMd).toBe("edited");
    }
  });

  // ported: leaves a file that only mentions JubarteAI alone, with an advisory
  it("leaves a file that only mentions JubarteAI alone, with an advisory", async () => {
    backdate(put("AGENTS.md", "# Demo\n\nWe use JubarteAI for agent coordination; see the wiki.\n"));
    const before = snapshot();
    await run("init");
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj).reports).toEqual([
      `AGENTS.md: mentions JubarteAI without the standard section — left as it is; the current section is at ${CURRENT_URL}`,
    ]);
  });
});

describe("CLAUDE.md import", () => {
  // ported: appends @AGENTS.md to a CLAUDE.md without the import when AGENTS.md carries the section
  it("appends @AGENTS.md to a CLAUDE.md without the import when AGENTS.md carries the section", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    put("CLAUDE.md", "# Claude\n\nBe terse.\n");
    expect(inspectInstructions(proj).claudeMdImport).toBe("missing");
    const r = await run("update");
    expect(read("CLAUDE.md")).toBe("# Claude\n\nBe terse.\n\n@AGENTS.md\n");
    expect(r.by("claude-md-import")).toMatchObject({ status: "configured", detail: "appended" });
    expect(inspectInstructions(proj).claudeMdImport).toBe("present");
  });

  // ported: adds the import in the same run that appends the section to AGENTS.md
  it("adds the import in the same run that appends the section to AGENTS.md", async () => {
    put("AGENTS.md", "# Demo\n");
    put("CLAUDE.md", "# Claude\n");
    await run("update");
    expect(read("AGENTS.md")).toBe(`# Demo\n\n\n${SECTION}\n`);
    expect(read("CLAUDE.md")).toBe("# Claude\n\n@AGENTS.md\n");
  });

  // ported: leaves a CLAUDE.md that already imports AGENTS.md (%s) alone
  // ported: AGENTS.md already holds the section and CLAUDE.md imports `@./AGENTS.md`: left as it is
  it.each(["@AGENTS.md", "@./AGENTS.md", "@../AGENTS.md"])("leaves a CLAUDE.md that already imports AGENTS.md (%s) alone", async (imp) => {
    put("AGENTS.md", `${SECTION}\n`);
    backdate(put("CLAUDE.md", `# Claude\n\n${imp}\n`));
    const before = snapshot();
    expect(planInstructionSteps(proj, { mode: "update" })).toEqual([]);
    const r = await run("init");
    expect(r.by("claude-md-import").status).toBe("already configured");
    expect(snapshot()).toEqual(before);
  });

  describe.skipIf(!POSIX)("CLAUDE.md that is AGENTS.md (a symlink or a hard link)", () => {
    // ported: appends the section once, through AGENTS.md, and never writes a self-import
    it("appends the section once, through AGENTS.md, and never writes a self-import", async () => {
      put("AGENTS.md", "# Demo\n");
      symlinkSync("AGENTS.md", at("CLAUDE.md"));
      const r = await run("init");
      expect(read("AGENTS.md")).toBe(`# Demo\n\n\n${SECTION}\n`);
      expect(read("AGENTS.md")).not.toContain("@AGENTS.md");
      expect(lstatSync(at("CLAUDE.md")).isSymbolicLink()).toBe(true);
      expect(r.ids).toEqual(["agents-md"]);
    });

    // ported: refreshes an old section once, not once per name
    it("refreshes an old section once, not once per name", async () => {
      put("AGENTS.md", `${MARKED_OLD(0)}\n`);
      symlinkSync("AGENTS.md", at("CLAUDE.md"));
      const r = await run("update");
      expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
      expect(r.ids).toEqual(["agents-md"]);
      expect(r.results.filter((x) => x.detail === "refreshed")).toHaveLength(1);
    });

    // ported: also holds the other way round (AGENTS.md linked to CLAUDE.md)
    it("also holds the other way round (AGENTS.md linked to CLAUDE.md)", async () => {
      put("CLAUDE.md", "# Claude\n");
      symlinkSync("CLAUDE.md", at("AGENTS.md"));
      await run("update");
      expect(read("CLAUDE.md")).toBe(`# Claude\n\n\n${SECTION}\n`);
      expect(lstatSync(at("AGENTS.md")).isSymbolicLink()).toBe(true);
    });

    // ported: creates AGENTS.md behind a dangling CLAUDE.md link without importing it into itself (Claude Code before 2.1.277)
    it("creates AGENTS.md behind a dangling CLAUDE.md link without importing it into itself (Claude Code before 2.1.277)", async () => {
      symlinkSync("AGENTS.md", at("CLAUDE.md"));
      const r = await run("update", { claudeCodeVersion: "2.1.270" });
      expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
      expect(lstatSync(at("CLAUDE.md")).isSymbolicLink()).toBe(true);
      expect(r.ids).toEqual(["agents-md"]);
      expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" }).reports).toEqual([]);
    });

    // ported: leaves a CLAUDE.md hard-linked to AGENTS.md %s as it is: no write splits the link, no self-import
    it.each([
      ["without the section", "# Demo\n"],
      ["with an old section", `# Demo\n\n${MARKED_OLD(0)}\n`],
    ])("leaves a CLAUDE.md hard-linked to AGENTS.md %s as it is: no write splits the link, no self-import", async (_label, content) => {
      const agents = put("AGENTS.md", content);
      linkSync(agents, at("CLAUDE.md"));
      const r = await run("init");
      expect(read("AGENTS.md")).toBe(content);
      expect(statSync(agents).nlink).toBe(2);
      expect(statSync(at("CLAUDE.md")).ino).toBe(statSync(agents).ino);
      expect(r.by("agents-md")).toMatchObject({ status: "skipped", detail: "AGENTS.md has other hard links, so it was left unchanged" });
      expect(r.results.filter((x) => x.status === "failed")).toEqual([]);
    });

    // ported: does not ask Claude Code before 2.1.277 to keep an @AGENTS.md import a linked CLAUDE.md doesn't need
    it("does not ask Claude Code before 2.1.277 to keep an @AGENTS.md import a linked CLAUDE.md doesn't need", async () => {
      put("AGENTS.md", `${SECTION}\n`);
      symlinkSync("AGENTS.md", at("CLAUDE.md"));
      const before = snapshot();
      expect(planInstructionSteps(proj, { mode: "update", claudeCodeVersion: "2.1.270" })).toEqual([]);
      expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" })).toMatchObject({ claudeMdImport: "present", reports: [] });
      expect(snapshot()).toEqual(before);
    });

    // ported: does not ask Claude Code before 2.1.277 to keep an @AGENTS.md import when %s is the AGENTS.md link
    it.each([
      [".claude/CLAUDE.md", "../AGENTS.md"],
      ["CLAUDE.local.md", "AGENTS.md"],
    ])("does not ask Claude Code before 2.1.277 to keep an @AGENTS.md import when %s is the AGENTS.md link", async (name, target) => {
      put("AGENTS.md", `${SECTION}\n`);
      mkdirSync(dirname(at(name)), { recursive: true });
      symlinkSync(target, at(name));
      const before = snapshot();
      expect(planInstructionSteps(proj, { mode: "update", claudeCodeVersion: "2.1.270" })).toEqual([]);
      expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" }).reports).toEqual([]);
      expect(snapshot()).toEqual(before);
    });
  });

  // ported: creates a root CLAUDE.md as exactly '@AGENTS.md' when only CLAUDE.local.md exists
  // ported: AGENTS.md already holds the section and only .claude/CLAUDE.md exists: the root CLAUDE.md is created as exactly `@AGENTS.md`
  it.each(["CLAUDE.local.md", ".claude/CLAUDE.md"])("creates a root CLAUDE.md as exactly '@AGENTS.md' when only %s exists", async (name) => {
    put("AGENTS.md", `${SECTION}\n`);
    put(name, "# My private notes\n");
    const r = await run("update");
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(name)).toBe("# My private notes\n");
    expect(r.by("claude-md-import")).toMatchObject({ status: "configured", detail: "created" });
  });

  // ported: does not add the import when the CLAUDE-family file already mentions JubarteAI
  // ported: CLAUDE.local.md that mentions JubarteAI counts as covered: no root CLAUDE.md is created
  it("does not add the import when the CLAUDE-family file already mentions JubarteAI", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    put("CLAUDE.local.md", "JubarteAI: connect first.\n");
    await run("init");
    expect(exists("CLAUDE.md")).toBe(false);
  });

  // ported: AGENTS.md already holds the section and .claude/CLAUDE.md imports `@../AGENTS.md`: counts as imported, nothing is created
  it("counts .claude/CLAUDE.md importing @../AGENTS.md as imported: no root CLAUDE.md is created", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    put(".claude/CLAUDE.md", "@../AGENTS.md\n");
    await run("init");
    expect(exists("CLAUDE.md")).toBe(false);
    expect(inspectInstructions(proj).claudeMdImport).toBe("present");
  });

  // ported: creates CLAUDE.md for Claude Code before 2.1.277 (no CLAUDE.md-family file) and warns
  it("creates CLAUDE.md for Claude Code before 2.1.277 (no CLAUDE.md-family file) and warns", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    const r = await run("update", { claudeCodeVersion: "2.1.270" });
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(r.by("claude-md-import")).toMatchObject({ status: "configured", detail: "created" });
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" }).reports).toEqual([
      "CLAUDE.md: Claude Code 2.1.270 (before 2.1.277) reads AGENTS.md only through an @AGENTS.md import in CLAUDE.md — keep that line, or update Claude Code",
    ]);
  });

  // ported: does not create CLAUDE.md for Claude Code 2.1.300, which reads AGENTS.md itself, and does not warn
  it("does not create CLAUDE.md for Claude Code 2.1.300, which reads AGENTS.md itself, and does not warn", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    const before = snapshot();
    expect(planInstructionSteps(proj, { mode: "update", claudeCodeVersion: "2.1.300" })).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.300" }).reports).toEqual([]);
  });

  // ported: treats an unknown Claude Code version as not older: no CLAUDE.md, no warning
  it.each([null, undefined, "claude dev build", ""])("treats an unknown Claude Code version (%j) as not older: no CLAUDE.md, no warning", async (version) => {
    put("AGENTS.md", `${SECTION}\n`);
    const r = await run("update", { claudeCodeVersion: version });
    expect(r.ids).toEqual([]);
    expect(exists("CLAUDE.md")).toBe(false);
    expect(inspectInstructions(proj, { claudeCodeVersion: version }).reports).toEqual([]);
  });

  // ported: warns about Claude Code before 2.1.277 even when CLAUDE.md already has the import, and changes nothing
  it("warns about Claude Code before 2.1.277 even when CLAUDE.md already has the import, and changes nothing", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    backdate(put("CLAUDE.md", "@AGENTS.md\n"));
    const before = snapshot();
    const r = await run("update", { claudeCodeVersion: "2.1.270" });
    expect(r.ids).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" }).reports).toHaveLength(1);
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.270" }).reports[0]).toContain("Claude Code 2.1.270 (before 2.1.277)");
  });

  it("compares versions numerically, not as text: 2.1.1000 is not older than 2.1.277", () => {
    put("AGENTS.md", `${SECTION}\n`);
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.1.1000" }).reports).toEqual([]);
    expect(inspectInstructions(proj, { claudeCodeVersion: "2.0.999" }).reports).toHaveLength(1);
    expect(inspectInstructions(proj, { claudeCodeVersion: "v2.1.276 (Claude Code)" }).reports).toHaveLength(1);
  });

  // ported: AGENTS.md already holds the section, CLAUDE.md exists without a mention or import: `@AGENTS.md` is appended and AGENTS.md is untouched
  it("init appends the import to a CLAUDE.md that has none and leaves AGENTS.md untouched", async () => {
    backdate(put("AGENTS.md", `${SECTION}\n`));
    const agents = snapshot()["AGENTS.md"];
    put("CLAUDE.md", "# Claude\n");
    await run("init");
    expect(read("CLAUDE.md")).toBe("# Claude\n\n@AGENTS.md\n");
    expect(snapshot()["AGENTS.md"]).toEqual(agents);
  });

  it.skipIf(!POSIX)("does not write the import when the section step was refused: an import to nothing helps no one", async () => {
    // AGENTS.md is a hard link, so the section can't be added; init must not then add @AGENTS.md to a new CLAUDE.md.
    const file = put("AGENTS.md", "# Demo\n");
    linkSync(file, join(base, "other-name.md"));
    const r = await run("init");
    expect(r.by("agents-md").status).toBe("skipped");
    expect(r.by("claude-md-import")).toMatchObject({ status: "skipped", detail: "AGENTS.md has no JubarteAI section" });
    expect(exists("CLAUDE.md")).toBe(false);
  });

  it("leaves an unreadable CLAUDE.md alone instead of appending to text it could not read", async () => {
    put("AGENTS.md", `${SECTION}\n`);
    writeFileSync(at("CLAUDE.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const bytes = readFileSync(at("CLAUDE.md"));
    const r = await run("update");
    expect(readFileSync(at("CLAUDE.md"))).toEqual(bytes);
    expect(r.by("claude-md-import")).toMatchObject({ status: "skipped", detail: "could not read CLAUDE.md, left as it is" });
  });
});

describe("init", () => {
  // ported: fresh project: AGENTS.md is exactly the marked section, CLAUDE.md exactly the import, and a second run changes neither
  it("fresh project: AGENTS.md is exactly the marked section, CLAUDE.md exactly the import, and a second run changes nothing", async () => {
    const first = await run("init");
    expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(first.results.map((r) => r.status)).toEqual(["configured", "configured"]);
    backdate(at("AGENTS.md"), at("CLAUDE.md"));
    const before = snapshot();
    const second = await run("init");
    expect(second.results.map((r) => r.status)).toEqual(["already configured", "already configured"]);
    expect(snapshot()).toEqual(before);
  });

  // ported: existing AGENTS.md without the section: original bytes, a blank line, then the marked section; a second run changes nothing
  it("existing AGENTS.md without the section: original bytes, a blank line, then the marked section; a second run changes nothing", async () => {
    put("AGENTS.md", "# Demo\n\nBuild with make.\n");
    await run("init");
    expect(read("AGENTS.md")).toBe(`# Demo\n\nBuild with make.\n\n\n${SECTION}\n`);
    const before = snapshot();
    await run("init");
    expect(snapshot()).toEqual(before);
  });

  // ported: idempotent: running twice leaves mcp.json / AGENTS.md / CLAUDE.md byte-identical
  it("running twice leaves AGENTS.md and CLAUDE.md byte-identical, with no temp file left", async () => {
    await run("init");
    const once = snapshot();
    await run("init");
    expect(snapshot()).toEqual(once);
    expect(Object.keys(once).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  // ported: CLAUDE.md symlinked to AGENTS.md: the section is appended once and AGENTS.md never imports itself
  it.skipIf(!POSIX)("CLAUDE.md symlinked to AGENTS.md: the section is appended once and AGENTS.md never imports itself", async () => {
    put("AGENTS.md", "# Demo\n");
    symlinkSync("AGENTS.md", at("CLAUDE.md"));
    await run("init");
    expect(read("AGENTS.md").split(BEGIN)).toHaveLength(2);
    expect(read("AGENTS.md")).not.toContain("@AGENTS.md");
  });

  it("reports every step through applyPlan and summarize, in plan order, without prompting a non-TTY run", async () => {
    const out = new PassThrough();
    const results = await applyPlan(planInstructionSteps(proj, { mode: "init" }), { tty: false, yes: false, out });
    expect(summarize(results)).toEqual([
      expect.stringMatching(/^AGENTS\.md section: configured/),
      expect.stringMatching(/^CLAUDE\.md import: configured/),
    ]);
    expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
  });

  it("lists each step with the file it writes, and marks none sensitive", () => {
    put("AGENTS.md", "# Demo\n");
    const steps = planInstructionSteps(proj, { mode: "init" });
    expect(steps.map((s) => [s.id, s.files, s.sensitive])).toEqual([
      ["agents-md", [at("AGENTS.md")], false],
      ["claude-md-import", [at("CLAUDE.md")], false],
    ]);
  });
});

describe("shadowing advisories (Zed, Codex)", () => {
  // ported: warns that Zed reads .cursorrules instead of AGENTS.md
  it("warns that Zed reads .cursorrules instead of AGENTS.md", () => {
    put("AGENTS.md", `${SECTION}\n`);
    put(".cursorrules", "be nice\n");
    expect(inspectInstructions(proj)).toMatchObject({
      agentsMd: "shadowed",
      reports: ["AGENTS.md: Zed reads .cursorrules instead of AGENTS.md — copy the JubarteAI section into it by hand for Zed's agent"],
    });
  });

  // ported: names the first shadowing file in Zed's list
  it("names the first shadowing file in Zed's list", () => {
    put("AGENTS.md", `${SECTION}\n`);
    put(".cursorrules", "x\n");
    put(".rules", "y\n");
    const { reports } = inspectInstructions(proj);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Zed reads .rules instead of AGENTS.md");
  });

  // ported: does not warn about a rules file that is a link to AGENTS.md, or when Zed is not detected
  it.skipIf(!POSIX)("does not warn about a rules file that is a link to AGENTS.md", () => {
    put("AGENTS.md", `${SECTION}\n`);
    symlinkSync("AGENTS.md", at(".cursorrules"));
    expect(inspectInstructions(proj)).toMatchObject({ agentsMd: "current", reports: [] });
  });

  it("does not warn about Zed when the caller says Zed is not installed", () => {
    put("AGENTS.md", `${SECTION}\n`);
    put(".cursorrules", "x\n");
    expect(inspectInstructions(proj, { harnesses: { zed: false } })).toMatchObject({ agentsMd: "current", reports: [] });
  });

  // ported: warns that Codex reads AGENTS.override.md instead of AGENTS.md
  it("warns that Codex reads AGENTS.override.md instead of AGENTS.md", () => {
    put("AGENTS.md", `${SECTION}\n`);
    put("AGENTS.override.md", "override\n");
    expect(inspectInstructions(proj)).toMatchObject({
      agentsMd: "shadowed",
      reports: ["AGENTS.md: Codex reads AGENTS.override.md instead of AGENTS.md here — copy the JubarteAI section into it by hand"],
    });
  });

  // ported: does not warn about AGENTS.override.md when Codex is not detected
  it("does not warn about AGENTS.override.md when the caller says Codex is not installed", () => {
    put("AGENTS.md", `${SECTION}\n`);
    put("AGENTS.override.md", "override\n");
    expect(inspectInstructions(proj, { harnesses: { codex: false } }).reports).toEqual([]);
  });

  it("never renames or edits the shadowing file (D25: report only)", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    backdate(put(".rules", "mine\n"), put("AGENTS.override.md", "mine too\n"));
    const before = snapshot();
    await run("update");
    const after = snapshot();
    expect(after[".rules"]).toEqual(before[".rules"]);
    expect(after["AGENTS.override.md"]).toEqual(before["AGENTS.override.md"]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("keeps saying known-old when a shadowed section still needs its refresh", () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    put(".rules", "x\n");
    expect(inspectInstructions(proj).agentsMd).toBe("known-old");
  });
});

describe("not a project (D26)", () => {
  // ported: skips the step from the home folder and writes nothing
  it("plans nothing from the home folder and writes nothing", () => {
    writeFileSync(join(home, "AGENTS.md"), `${OLD[0]}\n`);
    writeFileSync(join(home, "CLAUDE.md"), "# Home\n");
    expect(notProjectReason(home)).toBe("~ is your home folder, not a project");
    for (const mode of ["init", "update"] as const) {
      expect(planInstructionSteps(home, { mode })).toEqual([]);
    }
    expect(inspectInstructions(home)).toEqual({ agentsMd: "missing", claudeMdImport: "n/a", reports: [] });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(`${OLD[0]}\n`);
  });

  // ported: skips the step from the stop directory (standing in for /) and writes nothing
  it("plans nothing from the filesystem root", () => {
    expect(notProjectReason(parseRoot())).toBe("/ is not a project folder");
    expect(planInstructionSteps(parseRoot(), { mode: "init" })).toEqual([]);
  });

  it.skipIf(!POSIX)("treats a link to the home folder as the home folder", () => {
    const alias = join(base, "home-alias");
    symlinkSync(home, alias);
    expect(notProjectReason(alias)).toBe("~ is your home folder, not a project");
  });

  it("a folder under home is a project", () => {
    expect(notProjectReason(proj)).toBeNull();
  });
});

describe("git-tracked files", () => {
  // ported: notes that a changed AGENTS.md is tracked by git
  it("notes that a changed AGENTS.md is tracked by git", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    git(["add", "AGENTS.md"]);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "add agents"]);
    const r = await run("update");
    expect(read("AGENTS.md")).toBe(`${SECTION}\n`);
    expect(r.by("agents-md").detail).toBe("refreshed; AGENTS.md is tracked by git, review the change before you commit it");
  });

  // ported: does not note an untracked file
  it("does not note an untracked file", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    const r = await run("update");
    expect(r.by("agents-md").detail).toBe("refreshed");
  });
});

describe("bytes and files that are not text", () => {
  // ported: handles a non-ASCII file byte for byte (UTF-8 text around an old section)
  it("handles a non-ASCII file byte for byte (UTF-8 text around an old section)", async () => {
    const head = "# Démo — règles ✓\n\n";
    const tail = "\n\nFin — ünïcödé ✓\n";
    put("AGENTS.md", `${head}${OLD[0]}${tail}`);
    await run("update");
    expect(read("AGENTS.md")).toBe(`${head}${SECTION}${tail}`);
  });

  // ported: keeps CRLF line endings outside the section untouched
  it("keeps CRLF line endings outside the section untouched", async () => {
    const head = "# Demo\r\n\r\nWindows file.\r\n\r\n";
    put("AGENTS.md", `${head}${OLD[0]}\r\n`);
    await run("update");
    expect(read("AGENTS.md")).toBe(`${head}${SECTION}\r\n`);
  });

  it("keeps a byte order mark", async () => {
    put("AGENTS.md", `\uFEFF# Demo\n\n${OLD[0]}\n`);
    await run("update");
    expect(readFileSync(at("AGENTS.md")).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(read("AGENTS.md")).toBe(`\uFEFF# Demo\n\n${SECTION}\n`);
  });

  it("leaves a file that is not valid UTF-8 alone, byte for byte, and says so", async () => {
    const bytes = Buffer.concat([Buffer.from("# Demo\n"), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(`\n${OLD[0]}\n`)]);
    writeFileSync(at("AGENTS.md"), bytes);
    const r = await run("update");
    expect(readFileSync(at("AGENTS.md"))).toEqual(bytes);
    expect(r.ids).toEqual([]);
    expect(inspectInstructions(proj)).toMatchObject({ agentsMd: "edited", reports: ["AGENTS.md: couldn't read it — left as it is"] });
    const init = await run("init");
    expect(init.by("agents-md")).toMatchObject({ status: "skipped", detail: "could not read AGENTS.md, left as it is" });
  });

  it.skipIf(!POSIX)("does not open a FIFO named AGENTS.md (it would hang): it is unreadable, not read", async () => {
    const made = spawnSync("mkfifo", [at("AGENTS.md")]);
    if (made.status !== 0) return;
    const r = await run("init");
    expect(r.by("agents-md")).toMatchObject({ status: "skipped", detail: "could not read AGENTS.md, left as it is" });
  });

  it("does not read a file over the size cap", async () => {
    put("AGENTS.md", `${"x".repeat(4 * 1024 * 1024 + 1)}\n`);
    const r = await run("init");
    expect(r.by("agents-md").status).toBe("skipped");
    expect(statSync(at("AGENTS.md")).size).toBe(4 * 1024 * 1024 + 2);
  });
});

describe("the plan goes stale", () => {
  it("a step re-reads the file: text that became customised after planning is not overwritten", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    const steps = planInstructionSteps(proj, { mode: "update" });
    expect(steps.map((s) => s.id)).toEqual(["agents-md"]);
    const edited = `# Mine\n\n${BEGIN}\nmy own rules\n${END}\n`;
    put("AGENTS.md", edited);
    const result = await steps[0]?.apply();
    expect(result).toMatchObject({ status: "skipped", detail: "customised, left as it is" });
    expect(read("AGENTS.md")).toBe(edited);
  });

  it("a step that finds the work already done reports already configured and writes nothing", async () => {
    put("AGENTS.md", `${OLD[0]}\n`);
    const steps = planInstructionSteps(proj, { mode: "update" });
    put("AGENTS.md", `${SECTION}\n`);
    backdate(at("AGENTS.md"));
    const before = snapshot();
    expect(await steps[0]?.apply()).toMatchObject({ status: "already configured" });
    expect(snapshot()).toEqual(before);
  });
});

describe("the repository slug in the section", () => {
  it("is the last part of origin's URL without .git, for ssh, https and trailing-slash forms", async () => {
    for (const [url, slug] of [
      ["git@github.com:acme/some-repo.git", "some-repo"],
      ["https://github.com/acme/Other.Repo.git", "Other.Repo"],
      ["https://token@example.com/acme/plain/", "plain"],
      ["git@host:short.git", "short"],
    ] as const) {
      git(["remote", "set-url", "origin", url]);
      rmSync(at("AGENTS.md"), { force: true });
      await run("update");
      expect(read("AGENTS.md")).toContain(`--repositories ${slug} `);
      expect(read("AGENTS.md")).not.toContain("<repo-slug>");
    }
  });

  it("falls back to the folder's name with no origin", async () => {
    git(["remote", "remove", "origin"]);
    await run("update");
    expect(read("AGENTS.md")).toContain("--repositories demo");
  });

  it("uses the slug the caller passes, and ignores one that is not a plain name", async () => {
    await run("update", { slug: "from-caller" });
    expect(read("AGENTS.md")).toContain("--repositories from-caller");
    rmSync(at("AGENTS.md"));
    await run("update", { slug: "bad slug; rm -rf /" });
    // Not a usable name: the placeholder stays rather than putting caller text into the file.
    expect(read("AGENTS.md")).toContain("--repositories <repo-slug>");
    expect(read("AGENTS.md")).not.toContain("rm -rf");
  });

  it("keeps the placeholder when neither the remote nor the folder gives a usable name", async () => {
    const odd = join(home, "my project");
    mkdirSync(odd);
    spawnSync("git", ["init", "-q", "."], { cwd: odd });
    const steps = planInstructionSteps(odd, { mode: "update" });
    for (const s of steps) await s.apply();
    expect(readFileSync(join(odd, "AGENTS.md"), "utf8")).toContain("--repositories <repo-slug>");
    // And that section is recognised as current on the next look.
    expect(inspectInstructions(odd).agentsMd).toBe("current");
  });

  it("does not substitute a slug with `$` in it: a replacement pattern never reaches the text", async () => {
    await run("update", { slug: "a$&b" });
    expect(read("AGENTS.md")).toContain("--repositories <repo-slug>");
  });
});

function parseRoot(): string {
  return POSIX ? "/" : (process.env.SystemDrive ?? "C:") + "\\";
}
