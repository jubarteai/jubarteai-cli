// Scenarios ported from the app's src/lib/install-script.test.ts and src/lib/update-script/mcp.test.ts. The installer
// rewrote the jubarteai entry in place; the CLI removes it (D3) with the same safety rules. Each ported scenario is
// restated as a removal. B3 maps each deleted test to one below.
//
// ported: an old key in the project's .mcp.json is replaced (other servers kept) and a tracked file gets a warning
// ported: an old key in a .mcp.json between the directory it ran from and the project root is replaced too
// ported: without the CLI: every key the project may be filed under is checked and dropped (main checkout, worktree, the directory it ran from)
// ported: in a linked worktree: the old key Claude Code files under the main checkout is removed through the CLI
// ported: without the CLI: a legacy ~/.claude/.config.json is the file written, not ~/.claude.json
// ported: without the CLI: writes CLAUDE_CONFIG_DIR/.claude.json and drops an old local-scope key there
// ported: with a git older than 2.31 (no --path-format) the worktree's main checkout is still found
// ported: a worktree of a bare repository: the key is the repository itself
// ported: a submodule is its own project: its key is dropped, the superproject's is left alone
// ported: an old key in this project's local scope (the panel's old command) is removed, reported as updated
// ported: a JSON config another user owns is never written: the user file is skipped, an old key in a project file fails the step
// ported: a hard-linked config is never split by a rewrite: the user file is skipped, a project file fails, every link unchanged
// ported: a symlinked mcp.json is written through the link: the link stays, its target gets the new key
// ported: Zed JSONC settings degrade gracefully: file byte-unchanged, token not echoed, exit 0
// ported: VS Code: a JSONC .vscode/mcp.json (comment, ${input:…} on another server, trailing comma) with the placeholder key fails with manual instructions, unchanged
// ported: Zed on Linux keeps its settings under XDG_CONFIG_HOME
// ported: Zed on macOS ignores XDG_CONFIG_HOME (it always uses ~/.config/zed)
// ported: CODEX_HOME is where Codex keeps its config
// ported: Codex: an old key in .codex/config.toml is replaced in place
// ported: Codex: an old key in a .codex/config.toml below the project root, where it ran from, is replaced too
// ported: Codex: a .codex/config.toml that reads the key from the environment gets a note; one set inline with another key fails
// ported: run from ~ or /: an old key in the opened folder's Cursor config, or in any .codex/config.toml up to that root, fails the step, never rewritten
// ported: dotfiles: with ~ a git work tree, a run from ~/work/proj (no repo of its own) rewrites neither ~/work/.mcp.json nor ~/.mcp.json, nor any other config up there
// ported: outside git the folder it ran from is the project: its config is fixed, its parent's is not a project config and is left alone
// ported: a parent .mcp.json that only mentions jubarteai in a comment, or doesn't parse and holds no key, is not a failure
//
// New in the CLI: only the jubarteai entry goes (neighbours such as jubarteai-dev stay); a second run is empty;
// a symlink that leaves the home directory is reported; entries are never printed.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { findMcpEntries, isUnderHome, mcpCleanupFor, shownPath, type CleanupHarness } from "./mcp-cleanup.js";
import type { CleanupScope, ManualInstructions } from "./types.js";

const isWindows = process.platform === "win32";
const posix = it.skipIf(isWindows);
const FAKE_KEY = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12";

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-mcp-cleanup-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const entry = { type: "http", url: "https://jubarte.ai/api/mcp", headers: { Authorization: `Bearer ${FAKE_KEY}` } };
const other = { type: "http", url: "https://example.com/mcp" };

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function writeJson(file: string, value: unknown): string {
  return write(file, `${JSON.stringify(value, null, 2)}\n`);
}
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

function scope(over: Partial<CleanupScope> = {}): CleanupScope {
  return { home, projectRoot: null, platform: "linux", env: {}, startDir: home, ...over };
}

function steps(items: Array<PlanStep | ManualInstructions>): PlanStep[] {
  return items.filter((i): i is PlanStep => !("kind" in i));
}
function manuals(items: Array<PlanStep | ManualInstructions>): ManualInstructions[] {
  return items.filter((i): i is ManualInstructions => "kind" in i);
}

const sink = { write: () => true } as unknown as NodeJS.WritableStream;
async function run(items: Array<PlanStep | ManualInstructions>): Promise<StepResult[]> {
  return applyPlan(steps(items), { tty: false, yes: true, out: sink });
}
async function cleanup(harness: CleanupHarness, s: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
  return mcpCleanupFor(harness, s);
}

describe("user scope of Claude Code", () => {
  it("removes only the jubarteai entry from ~/.claude.json and keeps everything else", async () => {
    const file = writeJson(path.join(home, ".claude.json"), { numStartups: 3, mcpServers: { jubarteai: entry, "jubarteai-dev": other, github: other }, projects: { "/x": { mcpServers: { other } } } });
    const results = await run(await cleanup("claude-code", scope()));
    expect(results.map((r) => r.status)).toEqual(["configured"]);
    expect(readJson(file)).toEqual({ numStartups: 3, mcpServers: { "jubarteai-dev": other, github: other }, projects: { "/x": { mcpServers: { other } } } });
  });

  it("a second run finds nothing to do", async () => {
    writeJson(path.join(home, ".claude.json"), { mcpServers: { jubarteai: entry } });
    await run(await cleanup("claude-code", scope()));
    expect(await cleanup("claude-code", scope())).toEqual([]);
    expect(await findMcpEntries("claude-code", scope())).toEqual([]);
  });

  it("a legacy ~/.claude/.config.json is the file used when it exists, not ~/.claude.json", async () => {
    const legacy = writeJson(path.join(home, ".claude", ".config.json"), { mcpServers: { jubarteai: entry } });
    const modern = writeJson(path.join(home, ".claude.json"), { mcpServers: { jubarteai: entry } });
    await run(await cleanup("claude-code", scope()));
    expect(readJson(legacy)).toEqual({ mcpServers: {} });
    expect(readJson(modern)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  it("CLAUDE_CONFIG_DIR holds the config file when set", async () => {
    const dir = path.join(root, "claude-conf");
    const file = writeJson(path.join(dir, ".claude.json"), { mcpServers: { jubarteai: entry } });
    const untouched = writeJson(path.join(home, ".claude.json"), { mcpServers: { jubarteai: entry } });
    await run(await cleanup("claude-code", scope({ env: { CLAUDE_CONFIG_DIR: dir } })));
    expect(readJson(file)).toEqual({ mcpServers: {} });
    expect(readJson(untouched)).toEqual({ mcpServers: { jubarteai: entry } });
  });
});

describe("local scope of Claude Code", () => {
  it("removes the project's local-scope entry, whether Claude Code filed it under the NFC or the raw spelling", async () => {
    const nfc = path.join(root, "Código");
    const raw = nfc.normalize("NFD");
    expect(raw).not.toBe(nfc);
    const file = writeJson(path.join(home, ".claude.json"), {
      projects: { [nfc]: { mcpServers: { jubarteai: entry, keep: other } }, [raw]: { mcpServers: { jubarteai: entry } }, "/elsewhere": { mcpServers: { jubarteai: entry } } },
    });
    const items = await cleanup("claude-code", scope({ projectRoot: raw, startDir: raw }));
    await run(items);
    const projects = readJson(file)["projects"] as Record<string, { mcpServers: Record<string, unknown> }>;
    expect(projects[nfc]?.mcpServers).toEqual({ keep: other });
    expect(projects[raw]?.mcpServers).toEqual({});
    expect(projects["/elsewhere"]?.mcpServers).toEqual({ jubarteai: entry });
  });

  posix("a linked worktree is filed under its main checkout; the directory it ran from counts too", async () => {
    const main = path.join(root, "main");
    fs.mkdirSync(main);
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
    };
    git(main, "init", "-q");
    write(path.join(main, "a.txt"), "a");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    const tree = path.join(root, "tree");
    git(main, "worktree", "add", "-q", tree);
    const sub = path.join(tree, "pkg");
    fs.mkdirSync(sub);
    const file = writeJson(path.join(home, ".claude.json"), {
      projects: { [main]: { mcpServers: { jubarteai: entry } }, [tree]: { mcpServers: { jubarteai: entry } }, [sub]: { mcpServers: { jubarteai: entry } } },
    });
    await run(await cleanup("claude-code", scope({ projectRoot: tree, startDir: sub })));
    const projects = readJson(file)["projects"] as Record<string, { mcpServers: Record<string, unknown> }>;
    expect(projects[main]?.mcpServers).toEqual({});
    expect(projects[tree]?.mcpServers).toEqual({});
    expect(projects[sub]?.mcpServers).toEqual({});
  });

  const gitIn = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: "ignore" });
  };
  function repoWithCommit(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    write(path.join(dir, "a.txt"), "a");
    gitIn(dir, "add", ".");
    gitIn(dir, "commit", "-q", "-m", "init");
  }
  const localKeys = (file: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(readJson(file)["projects"] as Record<string, { mcpServers: Record<string, unknown> }>).map(([k, v]) => [k, v.mcpServers]));

  posix("git older than 2.31 (no --path-format, relative answers): the worktree's main checkout is still found", async () => {
    const main = path.join(root, "main");
    repoWithCommit(main);
    const tree = path.join(root, "tree");
    gitIn(main, "worktree", "add", "-q", tree);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // Old git echoes an option it doesn't know and answers the rest; the common directory comes back relative to where it runs.
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --path-format=absolute ]; then
  printf '%s\\n' "$2"
  shift 2
  set -- rev-parse "$@"
fi
if [ "$1" = rev-parse ] && [ "$2" = --git-common-dir ] && [ "$(pwd -P)" = ${JSON.stringify(tree)} ]; then
  printf '%s\\n' ${JSON.stringify(path.relative(tree, path.join(main, ".git")))}
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    try {
      const file = writeJson(path.join(home, ".claude.json"), { projects: { [main]: { mcpServers: { jubarteai: entry } } } });
      await run(await cleanup("claude-code", scope({ projectRoot: tree, startDir: tree })));
      expect(localKeys(file)).toEqual({ [main]: {} });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  posix("a worktree of a bare repository: the key is the repository itself", async () => {
    const source = path.join(root, "source");
    repoWithCommit(source);
    const bare = path.join(root, "repo.git");
    gitIn(root, "clone", "-q", "--bare", source, bare);
    const tree = path.join(root, "bare-wt");
    gitIn(bare, "worktree", "add", "-q", tree);
    const file = writeJson(path.join(home, ".claude.json"), { projects: { [bare]: { mcpServers: { jubarteai: entry, keep: other } }, [source]: { mcpServers: { jubarteai: entry } } } });
    await run(await cleanup("claude-code", scope({ projectRoot: tree, startDir: tree })));
    expect(localKeys(file)).toEqual({ [bare]: { keep: other }, [source]: { jubarteai: entry } });
  });

  posix("a submodule is its own project: its key is dropped, the superproject's is left alone", async () => {
    const lib = path.join(root, "lib-src");
    repoWithCommit(lib);
    const superproject = path.join(root, "super");
    repoWithCommit(superproject);
    gitIn(superproject, "submodule", "add", "-q", lib, "lib");
    const submodule = fs.realpathSync(path.join(superproject, "lib"));
    const file = writeJson(path.join(home, ".claude.json"), { projects: { [submodule]: { mcpServers: { jubarteai: entry } }, [superproject]: { mcpServers: { jubarteai: entry } } } });
    await run(await cleanup("claude-code", scope({ projectRoot: submodule, startDir: submodule })));
    expect(localKeys(file)).toEqual({ [submodule]: {}, [superproject]: { jubarteai: entry } });
  });

  it("run from ~ or /, the local scope is only reported", async () => {
    const file = writeJson(path.join(home, ".claude.json"), { projects: { [home]: { mcpServers: { jubarteai: entry } } } });
    const before = fs.readFileSync(file, "utf8");
    const items = await cleanup("claude-code", scope({ projectRoot: null, startDir: home }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("project .mcp.json", () => {
  it("is removed from the directory it ran from up to the project root, never above the root", async () => {
    const proj = path.join(home, "proj");
    const start = path.join(proj, "a", "b");
    const files = [path.join(start, ".mcp.json"), path.join(proj, "a", ".mcp.json"), path.join(proj, ".mcp.json")].map((f) => writeJson(f, { mcpServers: { jubarteai: entry, keep: other } }));
    const above = writeJson(path.join(home, ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const items = await cleanup("claude-code", scope({ projectRoot: proj, startDir: start }));
    expect(manuals(items)).toEqual([]);
    await run(items);
    for (const f of files) expect(readJson(f)).toEqual({ mcpServers: { keep: other } });
    expect(readJson(above)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  it("works for a project outside the home directory too", async () => {
    const proj = path.join(root, "outside");
    const f = writeJson(path.join(proj, ".mcp.json"), { mcpServers: { jubarteai: entry } });
    await run(await cleanup("claude-code", scope({ projectRoot: proj, startDir: proj })));
    expect(readJson(f)).toEqual({ mcpServers: {} });
  });

  it("outside git the folder it ran from is the project: its parent's config is left alone", async () => {
    const parent = writeJson(path.join(home, "work", ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const mine = writeJson(path.join(home, "work", "proj", ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const dir = path.join(home, "work", "proj");
    await run(await cleanup("claude-code", scope({ projectRoot: dir, startDir: dir })));
    expect(readJson(mine)).toEqual({ mcpServers: {} });
    expect(readJson(parent)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  it("run from ~: ~/.mcp.json and every folder up to ~ are reported, never rewritten (dotfiles case)", async () => {
    const a = writeJson(path.join(home, ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const b = writeJson(path.join(home, "work", ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const before = [fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8")];
    const items = await cleanup("claude-code", scope({ projectRoot: null, startDir: path.join(home, "work") }));
    expect(steps(items)).toEqual([]);
    const lines = manuals(items).flatMap((m) => m.lines);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^skipped: run from ~ or \/, project configs are only reported, remove it by hand: ~\//);
    expect([fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8")]).toEqual(before);
  });
});

describe("files that are reported, never edited", () => {
  it("a JSONC .vscode/mcp.json with comments is reported and left byte-identical", async () => {
    const proj = path.join(home, "proj");
    const text = `{\n  // my servers\n  "servers": {\n    "jubarteai": { "url": "https://jubarte.ai/api/mcp" },\n    "x": { "command": "\${input:x}" },\n  }\n}\n`;
    const f = write(path.join(proj, ".vscode", "mcp.json"), text);
    const items = await cleanup("vscode", scope({ projectRoot: proj, startDir: proj }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines).toEqual([`skipped: it has comments or trailing commas (JSONC), remove it by hand: ~/proj/.vscode/mcp.json`]);
    expect(fs.readFileSync(f, "utf8")).toBe(text);
  });

  it("Zed's commented settings.json is reported without echoing the key", async () => {
    const f = write(path.join(home, ".config", "zed", "settings.json"), `// zed\n{ "context_servers": { "jubarteai": { "url": "x", "headers": { "Authorization": "Bearer ${FAKE_KEY}" } } } }\n`);
    const before = fs.readFileSync(f, "utf8");
    const items = await cleanup("zed", scope({ platform: "darwin" }));
    expect(manuals(items)).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(FAKE_KEY);
    expect(fs.readFileSync(f, "utf8")).toBe(before);
  });

  it("a commented file that never mentions jubarteai, or invalid JSON without it, is not worth a word", async () => {
    write(path.join(home, ".cursor", "mcp.json"), `// nothing here\n{ "mcpServers": { "other": {} } }\n`);
    write(path.join(home, ".codeium", "windsurf", "mcp_config.json"), "{ not json");
    expect(await cleanup("cursor", scope())).toEqual([]);
    expect(await cleanup("windsurf", scope())).toEqual([]);
  });

  it("invalid JSON that mentions jubarteai is reported", async () => {
    const f = write(path.join(home, ".cursor", "mcp.json"), `{ "mcpServers": { "jubarteai": `);
    const items = await cleanup("cursor", scope());
    expect(manuals(items)[0]?.lines[0]).toMatch(/^skipped: it is not valid JSON/);
    expect(fs.readFileSync(f, "utf8")).toBe(`{ "mcpServers": { "jubarteai": `);
  });

  posix("a hard-linked config is reported and every link is unchanged", async () => {
    const f = writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { jubarteai: entry } });
    const link = path.join(home, "copy.json");
    fs.linkSync(f, link);
    const items = await cleanup("cursor", scope());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toBe("skipped: it has other hard links, remove it by hand: ~/.cursor/mcp.json");
    expect(readJson(f)).toEqual({ mcpServers: { jubarteai: entry } });
    expect(readJson(link)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  posix("a config another user owns is reported and unchanged", async () => {
    const f = writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { jubarteai: entry } });
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const items = await cleanup("cursor", scope());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toMatch(/^skipped: .*another user.*, remove it by hand: ~\/\.cursor\/mcp\.json$/);
    vi.restoreAllMocks();
    expect(readJson(f)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  posix("a symlink that leaves the home directory is reported; the file it names is untouched", async () => {
    const real = writeJson(path.join(root, "elsewhere", "mcp.json"), { mcpServers: { jubarteai: entry } });
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.symlinkSync(real, path.join(home, ".cursor", "mcp.json"));
    const items = await cleanup("cursor", scope());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toBe("skipped: it is a link that leads outside your home directory, remove it by hand: ~/.cursor/mcp.json");
    expect(readJson(real)).toEqual({ mcpServers: { jubarteai: entry } });
  });

  posix("a symlink inside the home directory is written through: the link stays, its target loses the entry", async () => {
    const real = writeJson(path.join(home, "dotfiles", "mcp.json"), { mcpServers: { jubarteai: entry, keep: other } });
    fs.mkdirSync(path.join(home, ".cursor"));
    const link = path.join(home, ".cursor", "mcp.json");
    fs.symlinkSync(real, link);
    await run(await cleanup("cursor", scope()));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJson(real)).toEqual({ mcpServers: { keep: other } });
  });

  // Review B1: a repo's own link must never steer an edit into a file outside the project.
  posix("a project .mcp.json linked to a file outside the project is reported; that file is untouched", async () => {
    const proj = path.join(home, "proj");
    const user = writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { jubarteai: entry, keep: other } });
    fs.mkdirSync(proj, { recursive: true });
    fs.symlinkSync("../.cursor/mcp.json", path.join(proj, ".mcp.json"));
    const items = await mcpCleanupFor("claude-code", scope({ projectRoot: proj, startDir: proj }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toBe("skipped: it is a symbolic link, or sits in a directory that is one, remove it by hand: ~/proj/.mcp.json");
    expect(readJson(user)).toEqual({ mcpServers: { jubarteai: entry, keep: other } });
  });

  posix("a project .codex linked to a folder outside the project is reported; the file it leads to is untouched", async () => {
    const proj = path.join(home, "proj");
    const text = `[mcp_servers.jubarteai]\nurl = "x"\n`;
    const real = write(path.join(home, "elsewhere", "config.toml"), text);
    fs.mkdirSync(proj, { recursive: true });
    fs.symlinkSync("../elsewhere", path.join(proj, ".codex"));
    const items = await mcpCleanupFor("codex", scope({ projectRoot: proj, startDir: proj }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toBe("skipped: it is a symbolic link, or sits in a directory that is one, remove it by hand: ~/proj/.codex/config.toml");
    expect(fs.readFileSync(real, "utf8")).toBe(text);
  });

  posix("a project config linked to another file inside the project is still written through", async () => {
    const proj = path.join(home, "proj");
    const real = writeJson(path.join(proj, "config", "mcp.json"), { mcpServers: { jubarteai: entry, keep: other } });
    fs.symlinkSync("config/mcp.json", path.join(proj, ".mcp.json"));
    await run(await mcpCleanupFor("claude-code", scope({ projectRoot: proj, startDir: proj })));
    expect(fs.lstatSync(path.join(proj, ".mcp.json")).isSymbolicLink()).toBe(true);
    expect(readJson(real)).toEqual({ mcpServers: { keep: other } });
  });

  it("a directory where the config should be is ignored", async () => {
    fs.mkdirSync(path.join(home, ".cursor", "mcp.json"), { recursive: true });
    expect(await cleanup("cursor", scope())).toEqual([]);
  });
});

describe("the other harnesses' paths", () => {
  it("Cursor: user and project mcpServers", async () => {
    const proj = path.join(home, "proj");
    const user = writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { jubarteai: entry } });
    const project = writeJson(path.join(proj, ".cursor", "mcp.json"), { mcpServers: { jubarteai: entry, other } });
    await run(await cleanup("cursor", scope({ projectRoot: proj, startDir: proj })));
    expect(readJson(user)).toEqual({ mcpServers: {} });
    expect(readJson(project)).toEqual({ mcpServers: { other } });
  });

  it("VS Code: servers in the user config of each build and each profile, and the project's", async () => {
    const stable = writeJson(path.join(home, ".config", "Code", "User", "mcp.json"), { servers: { jubarteai: entry }, inputs: [] });
    const insiders = writeJson(path.join(home, ".config", "Code - Insiders", "User", "mcp.json"), { servers: { jubarteai: entry } });
    const profile = writeJson(path.join(home, ".config", "Code", "User", "profiles", "work", "mcp.json"), { servers: { jubarteai: entry } });
    await run(await cleanup("vscode", scope()));
    expect(readJson(stable)).toEqual({ servers: {}, inputs: [] });
    expect(readJson(insiders)).toEqual({ servers: {} });
    expect(readJson(profile)).toEqual({ servers: {} });
  });

  it("VS Code on macOS keeps its user config under Library/Application Support", async () => {
    const f = writeJson(path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"), { servers: { jubarteai: entry } });
    await run(await cleanup("vscode", scope({ platform: "darwin" })));
    expect(readJson(f)).toEqual({ servers: {} });
  });

  it("Windsurf: mcp_config.json", async () => {
    const f = writeJson(path.join(home, ".codeium", "windsurf", "mcp_config.json"), { mcpServers: { jubarteai: entry, other } });
    await run(await cleanup("windsurf", scope()));
    expect(readJson(f)).toEqual({ mcpServers: { other } });
  });

  it("Zed on Linux keeps its settings under XDG_CONFIG_HOME", async () => {
    const xdg = path.join(root, "xdg");
    const f = writeJson(path.join(xdg, "zed", "settings.json"), { context_servers: { jubarteai: entry }, theme: "x" });
    await run(await cleanup("zed", scope({ platform: "linux", env: { XDG_CONFIG_HOME: xdg } })));
    expect(readJson(f)).toEqual({ context_servers: {}, theme: "x" });
  });

  it("Zed on macOS ignores XDG_CONFIG_HOME (it always uses ~/.config/zed)", async () => {
    const xdg = path.join(root, "xdg");
    const stray = writeJson(path.join(xdg, "zed", "settings.json"), { context_servers: { jubarteai: entry } });
    const f = writeJson(path.join(home, ".config", "zed", "settings.json"), { context_servers: { jubarteai: entry } });
    await run(await cleanup("zed", scope({ platform: "darwin", env: { XDG_CONFIG_HOME: xdg } })));
    expect(readJson(f)).toEqual({ context_servers: {} });
    expect(readJson(stray)).toEqual({ context_servers: { jubarteai: entry } });
  });
});

describe("Codex config.toml", () => {
  const toml = (extra = ""): string => `model = "gpt"\n\n[mcp_servers.jubarteai]\nurl = "https://jubarte.ai/api/mcp"\nhttp_headers = { "Authorization" = "Bearer ${FAKE_KEY}" }\n\n[mcp_servers.jubarteai.tools]\nx = 1\n\n[mcp_servers.other]\nurl = "https://example.com"\n${extra}`;

  it("removes the jubarteai table and its sub-tables, keeps the rest, in the user file and in the project's", async () => {
    const user = write(path.join(home, ".codex", "config.toml"), toml());
    const proj = path.join(home, "proj");
    const sub = path.join(proj, "pkg");
    const project = write(path.join(proj, ".codex", "config.toml"), toml());
    const below = write(path.join(sub, ".codex", "config.toml"), toml());
    await run(await cleanup("codex", scope({ projectRoot: proj, startDir: sub })));
    for (const f of [user, project, below]) {
      const text = fs.readFileSync(f, "utf8");
      expect(text).toBe(`model = "gpt"\n\n[mcp_servers.other]\nurl = "https://example.com"\n`);
    }
  });

  it("CODEX_HOME is where Codex keeps its config", async () => {
    const dir = path.join(root, "codex-home");
    const f = write(path.join(dir, "config.toml"), toml());
    const untouched = write(path.join(home, ".codex", "config.toml"), toml());
    await run(await cleanup("codex", scope({ env: { CODEX_HOME: dir } })));
    expect(fs.readFileSync(f, "utf8")).not.toContain("jubarteai");
    expect(fs.readFileSync(untouched, "utf8")).toContain("jubarteai");
  });

  it("a jubarteai server set inline is reported, never edited", async () => {
    const text = `[mcp_servers]\njubarteai = { url = "https://jubarte.ai/api/mcp" }\n`;
    const f = write(path.join(home, ".codex", "config.toml"), text);
    const items = await cleanup("codex", scope());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.lines[0]).toMatch(/^skipped: it sets jubarteai inline or with dotted keys.*remove it by hand: ~\/\.codex\/config\.toml$/);
    expect(fs.readFileSync(f, "utf8")).toBe(text);
  });

  it("a config without the table produces nothing", async () => {
    write(path.join(home, ".codex", "config.toml"), `[mcp_servers.other]\nurl = "x"\n`);
    expect(await cleanup("codex", scope())).toEqual([]);
  });

  it("a gate that keeps the entry leaves the file as it was and says so", async () => {
    const f = write(path.join(home, ".codex", "config.toml"), toml());
    const items = await mcpCleanupFor("codex", scope(), { gate: async () => "kept: because" });
    const results = await run(items);
    expect(results).toEqual([expect.objectContaining({ status: "skipped", detail: "kept: because" })]);
    expect(fs.readFileSync(f, "utf8")).toBe(toml());
  });

  it("run from ~ or /, project .codex/config.toml files are only reported", async () => {
    const f = write(path.join(home, "work", ".codex", "config.toml"), toml());
    const items = await cleanup("codex", scope({ projectRoot: null, startDir: path.join(home, "work") }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)).toHaveLength(1);
    expect(fs.readFileSync(f, "utf8")).toBe(toml());
  });
});

describe("what is printed", () => {
  it("steps are sensitive, name the entry path and never carry the key", async () => {
    writeJson(path.join(home, ".claude.json"), { mcpServers: { jubarteai: entry } });
    const items = await cleanup("claude-code", scope());
    const [step] = steps(items);
    expect(step?.sensitive).toBe(true);
    expect(step?.preview).toBe(`~/.claude.json: remove "mcpServers.jubarteai"`);
    const results = await run(items);
    expect(JSON.stringify([items.map((i) => ("kind" in i ? i : { ...i, apply: undefined })), results])).not.toContain(FAKE_KEY);
  });

  it("step ids are unique per harness, scope and file", async () => {
    writeJson(path.join(home, ".claude.json"), { mcpServers: { jubarteai: entry }, projects: { [home]: { mcpServers: { jubarteai: entry } } } });
    const proj = path.join(home, "proj");
    writeJson(path.join(proj, ".mcp.json"), { mcpServers: { jubarteai: entry } });
    const items = steps(await cleanup("claude-code", scope({ projectRoot: proj, startDir: proj })));
    const ids = items.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("helpers", () => {
  it("shownPath collapses the home directory", () => {
    expect(shownPath(path.join(home, ".cursor", "mcp.json"), home)).toBe("~/.cursor/mcp.json");
    expect(shownPath(path.join(root, "x"), home)).toBe(path.join(root, "x"));
  });
  it("shownPath replaces control characters in a folder name", () => {
    expect(shownPath(path.join(home, "pro\u001b[2Jj", "x"), home)).toBe("~/pro?[2Jj/x");
  });
  it("isUnderHome is true only below the home directory", () => {
    expect(isUnderHome(path.join(home, "a"), home)).toBe(true);
    expect(isUnderHome(path.join(root, "a"), home)).toBe(false);
  });
});
