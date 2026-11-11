import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
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

describe("cursor permission (CLI only)", () => {
  it("merges Shell(jubarteai) into the CLI's own config, keeping everything else, and a second run changes nothing", async () => {
    const file = path(".cursor", "cli-config.json");
    put(file, JSON.stringify({ version: 1, model: { name: "x" }, permissions: { allow: ["Read(**)"], deny: ["Shell(rm)"] } }, null, 2) + "\n");
    const step = await cursorAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect(step.files).toEqual([file]);
    expect((await step.apply()).status).toBe("configured");
    expect(readJson(file)).toEqual({ version: 1, model: { name: "x" }, permissions: { allow: ["Read(**)", "Shell(jubarteai)"], deny: ["Shell(rm)"] } });
    const before = read(file);
    expect((await step.apply()).status).toBe("already configured");
    expect(read(file)).toBe(before);
  });

  it("creates the file when only the CLI binary exists, and prints the IDE half as an extra", async () => {
    const step = await cursorAdapter.permission(ctx(withCli()));
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("configured");
    expect(readJson(path(".cursor", "cli-config.json"))).toEqual({ permissions: { allow: ["Shell(jubarteai)"] } });
    const extras = await cursorAdapter.extras?.(ctx(withCli()));
    expect(extras).toHaveLength(1);
    const ide = extras?.[0];
    expect(isManual(ide) && ide.reason).toContain("not verified (D25)");
  });

  it("prints the IDE instructions, writing nothing, when there is no CLI", async () => {
    mkdirSync(path(".cursor"));
    const result = await cursorAdapter.permission(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain("jubarteai");
    expect(readdirSync(path(".cursor"))).toEqual([]);
    expect(await cursorAdapter.extras?.(ctx())).toEqual([]);
  });

  it("refuses a cli-config.json with comments: prints the exact entry and leaves the file as it was", async () => {
    const file = path(".cursor", "cli-config.json");
    const text = '{\n  // mine\n  "permissions": { "allow": [] }\n}\n';
    put(file, text);
    const result = await cursorAdapter.permission(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain('"Shell(jubarteai)"');
    expect(read(file)).toBe(text);
  });

  it("does not merge into a permissions.allow that is not a list", async () => {
    const file = path(".cursor", "cli-config.json");
    put(file, '{"permissions":{"allow":"all"}}\n');
    const step = await cursorAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    const result = await step.apply();
    expect(result.status).toBe("skipped");
    expect(read(file)).toBe('{"permissions":{"allow":"all"}}\n');
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
    expect(hooks["sessionStart"]?.[0]?.["command"]).toBe("jubarteai hook session-start --harness cursor");
    expect(hooks["sessionEnd"]?.[0]?.["command"]).toBe("jubarteai hook session-end --harness cursor");
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
  it("reports missing, then configured, read-only", async () => {
    mkdirSync(path(".cursor"));
    const before = await cursorAdapter.inspect(ctx(withCli()));
    expect(before.permission).toBe("missing");
    expect(before.hooks).toBe("missing");
    expect(before.notes.join(" ")).toContain("allowlist");
    const permission = await cursorAdapter.permission(ctx(withCli()));
    const hooks = await cursorAdapter.hooks(ctx(withCli()));
    if (!isStep(permission) || hooks === null || isManual(hooks)) throw new Error("expected steps");
    await permission.apply();
    await hooks[0]!.apply();
    const after = await cursorAdapter.inspect(ctx(withCli()));
    expect(after.permission).toBe("configured");
    expect(after.hooks).toBe("configured");
  });

  it("reports one hook as partial and an unwritable file as manual, and lists files that still hold an MCP entry", async () => {
    put(path(".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "jubarteai hook session-start --harness cursor" }] } }));
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
