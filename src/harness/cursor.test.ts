import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { applyPlan, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { cursorAdapter } from "./cursor.js";
import type { InitCtx, ManualInstructions } from "./types.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-cursor-")));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  // MCP cleanup and inspect walk project configs from the working directory; keep it inside the fake home.
  vi.spyOn(process, "cwd").mockReturnValue(home);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const ctx = (over: Partial<InitCtx> = {}): InitCtx => ({ home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai", ...over });
const withCli = (): Partial<InitCtx> => ({ which: (cmd: string) => (cmd === "agent" ? "/usr/local/bin/agent" : null) });
const path = (...parts: string[]): string => join(home, ...parts);
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
};
const read = (file: string): string => readFileSync(file, "utf8");
const readJson = (file: string): Record<string, unknown> => JSON.parse(read(file)) as Record<string, unknown>;
const isStep = (v: PlanStep | ManualInstructions | null | PlanStep[]): v is PlanStep => v !== null && !Array.isArray(v) && "apply" in v;
const isManual = (v: unknown): v is ManualInstructions => typeof v === "object" && v !== null && "kind" in v && v.kind === "manual";

async function applyAll(steps: Array<PlanStep | ManualInstructions>): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) if (!isManual(step)) results.push(await step.apply());
  return results;
}

describe("cursor adapter facts", () => {
  it("declares the verified cells", () => {
    expect(cursorAdapter.id).toBe("cursor");
    expect(cursorAdapter.skillAgent).toBe("cursor");
    expect(cursorAdapter.sessionVar).toBeNull();
    expect(cursorAdapter.promptInjection).toBe(false);
  });

  it("detects ~/.cursor, the agent binary and the cursor-agent alias, and nothing else", async () => {
    expect(await cursorAdapter.detect(ctx())).toBe(false);
    mkdirSync(path(".cursor"));
    expect(await cursorAdapter.detect(ctx())).toBe(true);
    rmSync(path(".cursor"), { recursive: true });
    expect(await cursorAdapter.detect(ctx({ which: (c) => (c === "agent" ? "/bin/agent" : null) }))).toBe(true);
    expect(await cursorAdapter.detect(ctx({ which: (c) => (c === "cursor-agent" ? "/bin/cursor-agent" : null) }))).toBe(true);
  });
});

describe("cursor permission (printed only: Shell(jubarteai) would also approve the person commands, review R-M1)", () => {
  const text = (out: unknown): string => (isManual(out) ? out.lines.join("\n") : "");

  it("returns manual instructions that name the person commands and both ways forward", async () => {
    const out = await cursorAdapter.permission(ctx(withCli()));
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.harness).toBe("cursor");
    expect(out.reason).toMatch(/R-M1/);
    expect(out.reason).toContain("I6");
    const printed = text(out);
    for (const person of ["login", "logout", "link", "init", "update"]) expect(printed).toContain(person);
    expect(printed).toContain("Approve jubarteai commands when Cursor asks");
    expect(printed).toContain('add "Shell(jubarteai)" to permissions.allow in ~/.cursor/cli-config.json yourself');
  });

  it("is the same instructions with or without the CLI, and there is no separate IDE line telling the person to allowlist plain jubarteai", async () => {
    const withoutCli = await cursorAdapter.permission(ctx());
    expect(withoutCli).toEqual(await cursorAdapter.permission(ctx(withCli())));
    expect(text(withoutCli)).not.toMatch(/add: jubarteai/);
    expect(cursorAdapter.extras).toBeUndefined();
  });

  it("writes no file and leaves an existing cli-config.json untouched", async () => {
    const file = path(".cursor", "cli-config.json");
    const body = JSON.stringify({ version: 1, permissions: { allow: ["Read(**)"] } }, null, 2) + "\n";
    put(file, body);
    expect(isManual(await cursorAdapter.permission(ctx(withCli())))).toBe(true);
    expect(read(file)).toBe(body);
    rmSync(file);
    expect(isManual(await cursorAdapter.permission(ctx(withCli())))).toBe(true);
    expect(readdirSync(path(".cursor"))).toEqual([]);
  });

  it("never names a person command in a step: permission() is never a plan step", async () => {
    expect(isStep(await cursorAdapter.permission(ctx(withCli())))).toBe(false);
  });
});

describe("cursor hooks (session start and end only)", () => {
  it("writes version 1 with sessionStart and sessionEnd running the hook command, and no per-prompt hook", async () => {
    const steps = await cursorAdapter.hooks(ctx());
    if (steps === null || isManual(steps)) throw new Error("expected steps");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.sensitive).toBe(true);
    expect((await steps[0]!.apply()).status).toBe("configured");
    const doc = readJson(path(".cursor", "hooks.json"));
    expect(doc["version"]).toBe(1);
    const hooks = doc["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(hooks).sort()).toEqual(["sessionEnd", "sessionStart"]);
    expect(hooks["sessionStart"]).toEqual([{ command: "jubarteai hook session-start --harness cursor", timeout: 8 }]);
    expect(hooks["sessionEnd"]).toEqual([{ command: "jubarteai hook session-end --harness cursor", timeout: 3 }]);
  });

  it("runs ctx.hookCommand, while the printed permission prose keeps the bare name", async () => {
    const program = '"/usr/local/bin/node" "/opt/jubarteai/bin/jubarteai.js"';
    const c = ctx({ ...withCli(), hookCommand: program });
    const permission = await cursorAdapter.permission(c);
    const steps = await cursorAdapter.hooks(c);
    if (!isManual(permission) || steps === null || isManual(steps)) throw new Error("expected instructions and steps");
    expect(permission.lines.join("\n")).not.toContain("/usr/local/bin/node");
    await steps[0]!.apply();
    const hooks = readJson(path(".cursor", "hooks.json"))["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(hooks["sessionStart"]?.[0]?.["command"]).toBe(`${program} hook session-start --harness cursor`);
    expect((await cursorAdapter.inspect(c)).hooks).toBe("configured");
  });

  it("a re-run with another program path or timeout updates our entry in place, never a second one", async () => {
    const file = path(".cursor", "hooks.json");
    put(
      file,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: "./mine.sh" }, { command: '"/old/node" "/old/jubarteai.js" hook session-start --harness cursor', timeout: 6.5 }],
          sessionEnd: [
            { command: "jubarteai hook session-end --harness cursor", timeout: 3 },
            { command: '"/old/node" "/old/jubarteai.js" hook session-end --harness cursor', timeout: 3 },
          ],
        },
      }),
    );
    const c = ctx({ hookCommand: '"/new/node" "/new/jubarteai.js"' });
    expect((await cursorAdapter.inspect(c)).hooks).toBe("partial");
    const steps = await cursorAdapter.hooks(c);
    if (steps === null || isManual(steps)) throw new Error("expected steps");
    expect(steps[0]?.sensitive).toBe(true);
    expect((await steps[0]!.apply()).status).toBe("configured");
    const hooks = readJson(file)["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(hooks["sessionStart"]).toEqual([{ command: "./mine.sh" }, { command: '"/new/node" "/new/jubarteai.js" hook session-start --harness cursor', timeout: 8 }]);
    expect(hooks["sessionEnd"]).toEqual([{ command: '"/new/node" "/new/jubarteai.js" hook session-end --harness cursor', timeout: 3 }]);
    expect((await cursorAdapter.inspect(c)).hooks).toBe("configured");
    const again = await cursorAdapter.hooks(c);
    if (again === null || isManual(again)) throw new Error("expected steps");
    expect(again[0]?.sensitive).toBe(false);
  });

  it("is idempotent and keeps other hooks and keys", async () => {
    const file = path(".cursor", "hooks.json");
    put(file, JSON.stringify({ version: 1, other: true, hooks: { sessionStart: [{ command: "./mine.sh" }], afterFileEdit: [{ command: "./fmt.sh" }] } }, null, 2) + "\n");
    const steps = await cursorAdapter.hooks(ctx());
    if (steps === null || isManual(steps)) throw new Error("expected steps");
    expect((await steps[0]!.apply()).status).toBe("configured");
    const once = read(file);
    expect((await steps[0]!.apply()).status).toBe("already configured");
    expect(read(file)).toBe(once);
    const doc = readJson(file);
    expect(doc["other"]).toBe(true);
    const hooks = doc["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(hooks["afterFileEdit"]).toEqual([{ command: "./fmt.sh" }]);
    expect(hooks["sessionStart"]?.map((h) => h["command"])).toEqual(["./mine.sh", "jubarteai hook session-start --harness cursor"]);
  });

  it("prints the entry for a hooks.json with comments and leaves it untouched", async () => {
    const file = path(".cursor", "hooks.json");
    const text = '{ /* mine */ "version": 1, "hooks": {} }\n';
    put(file, text);
    const result = await cursorAdapter.hooks(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain("jubarteai hook session-start --harness cursor");
    expect(read(file)).toBe(text);
  });
});

describe("cursor inspect", () => {
  it("reports the permission as manual, then hooks configured, read-only", async () => {
    mkdirSync(path(".cursor"));
    const before = await cursorAdapter.inspect(ctx(withCli()));
    expect(before.permission).toBe("manual");
    expect(before.hooks).toBe("missing");
    expect(before.notes.join(" ")).toContain("approve jubarteai commands when Cursor asks");
    expect(before.notes.join(" ")).not.toContain("is in permissions.allow");
    const hooks = await cursorAdapter.hooks(ctx(withCli()));
    if (hooks === null || isManual(hooks)) throw new Error("expected steps");
    await hooks[0]!.apply();
    const after = await cursorAdapter.inspect(ctx(withCli()));
    expect(after.permission).toBe("manual");
    expect(after.hooks).toBe("configured");
    expect(readdirSync(path(".cursor"))).toEqual(["hooks.json"]);
  });

  it("notes a pre-existing Shell(jubarteai), which also pre-approves the person commands", async () => {
    put(path(".cursor", "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(jubarteai)"] } }));
    const state = await cursorAdapter.inspect(ctx(withCli()));
    expect(state.permission).toBe("manual");
    const notes = state.notes.join(" ");
    expect(notes).toContain("Shell(jubarteai) is in permissions.allow");
    expect(notes).toContain("login, logout, link, init and update");
    expect(notes).toContain("CURSOR_AGENT");
  });

  it("reports one hook as partial and an unwritable file as manual, and lists files that still hold an MCP entry", async () => {
    put(path(".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "jubarteai hook session-start --harness cursor", timeout: 8 }] } }));
    put(path(".cursor", "cli-config.json"), "{ // c\n}");
    put(path(".cursor", "mcp.json"), JSON.stringify({ mcpServers: { jubarteai: { url: "https://x" } } }));
    const state = await cursorAdapter.inspect(ctx(withCli()));
    expect(state.hooks).toBe("partial");
    expect(state.permission).toBe("manual");
    expect(state.mcpEntries).toEqual([path(".cursor", "mcp.json")]);
  });
});

describe("cursor MCP cleanup", () => {
  const scope = (over: Record<string, unknown> = {}) => ({ home, projectRoot: null, platform: "linux" as const, env: {}, startDir: home, ...over });

  it("removes only the jubarteai entry from the user and the project config", async () => {
    const project = join(home, "work", "app");
    put(path(".cursor", "mcp.json"), JSON.stringify({ mcpServers: { jubarteai: { url: "a" }, other: { url: "b" } }, keep: 1 }, null, 2) + "\n");
    put(join(project, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { jubarteai: { url: "a" }, mine: { command: "x" } } }, null, 2) + "\n");
    const steps = await cursorAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }));
    expect(steps.filter((s) => !isManual(s))).toHaveLength(2);
    expect((await applyAll(steps)).map((r) => r.status)).toEqual(["configured", "configured"]);
    expect(readJson(path(".cursor", "mcp.json"))).toEqual({ mcpServers: { other: { url: "b" } }, keep: 1 });
    expect(readJson(join(project, ".cursor", "mcp.json"))).toEqual({ mcpServers: { mine: { command: "x" } } });
    expect(await cursorAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }))).toEqual([]);
  });

  it("reports a config with comments and does not edit it", async () => {
    const text = '{\n  // hand written\n  "mcpServers": { "jubarteai": {} }\n}\n';
    put(path(".cursor", "mcp.json"), text);
    const steps = await cursorAdapter.mcpCleanup(scope());
    expect(steps).toHaveLength(1);
    const only = steps[0];
    expect(isManual(only) && only.lines[0]).toMatch(/^skipped: .*, remove it by hand: ~\/\.cursor\/mcp\.json$/);
    expect(read(path(".cursor", "mcp.json"))).toBe(text);
  });

  it("only reports a project file when run from the home directory", async () => {
    const sub = path("scratch");
    const file = join(sub, ".cursor", "mcp.json");
    const text = JSON.stringify({ mcpServers: { jubarteai: {} } });
    put(file, text);
    const steps = await cursorAdapter.mcpCleanup(scope({ startDir: sub }));
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0])).toBe(true);
    expect(read(file)).toBe(text);
  });
});

describe("harness adapters never write files themselves (I6)", () => {
  it("imports no node:fs write API", () => {
    const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rename|renameSync|copyFile|copyFileSync|unlink|unlinkSync|createWriteStream|truncate|truncateSync|chmod|chmodSync|symlink|symlinkSync)\b/;
    for (const name of ["cursor", "vscode", "windsurf", "zed"]) {
      const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)].map((m) => m[1] ?? "");
      expect(imports.join(",")).not.toMatch(writes);
      expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+"node:fs/);
    }
  });
});

describe("cursor re-run (spec 6.1: re-running init is safe)", () => {
  it("re-plans the hooks as a non-sensitive step that reports already configured without a TTY; the permission stays printed", async () => {
    const first = (await cursorAdapter.hooks(ctx(withCli()))) as PlanStep[];
    expect(first.every((s) => s.sensitive)).toBe(true);
    await applyPlan(first, { tty: false, yes: true, out: new PassThrough() });
    const again = (await cursorAdapter.hooks(ctx(withCli()))) as PlanStep[];
    expect(again.map((s) => s.sensitive)).toEqual([false]);
    const results = await applyPlan(again, { tty: false, yes: false, out: new PassThrough() });
    expect(results.map((r) => r.status)).toEqual(["already configured"]);
    expect(isManual(await cursorAdapter.permission(ctx(withCli())))).toBe(true);
  });
});
