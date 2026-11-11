import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { COPILOT_HOOKS_STEP_ID, copilotHooksPlan, copilotHooksState, copilotHooksStep, vscodeAdapter } from "./vscode.js";
import type { InitCtx, ManualInstructions } from "./types.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-vscode-")));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(process, "cwd").mockReturnValue(home);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const ctx = (over: Partial<InitCtx> = {}): InitCtx => ({ home, env: {}, platform: "darwin", which: () => null, projectRoot: null, cliCommand: "jubarteai", ...over });
const path = (...parts: string[]): string => join(home, ...parts);
const userDir = (): string => path("Library", "Application Support", "Code", "User");
const settings = (): string => join(userDir(), "settings.json");
const hooksFile = (): string => path(".copilot", "hooks", "jubarteai.json");
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
};
const read = (file: string): string => readFileSync(file, "utf8");
const readJson = (file: string): Record<string, unknown> => JSON.parse(read(file)) as Record<string, unknown>;
const isManual = (v: unknown): v is ManualInstructions => typeof v === "object" && v !== null && "kind" in v && v.kind === "manual";
const isStep = (v: unknown): v is PlanStep => typeof v === "object" && v !== null && "apply" in v;

async function applyAll(steps: Array<PlanStep | ManualInstructions>): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) if (!isManual(step)) results.push(await step.apply());
  return results;
}

describe("vscode adapter facts", () => {
  it("declares the verified cells", () => {
    expect(vscodeAdapter.id).toBe("vscode");
    expect(vscodeAdapter.skillAgent).toBe("github-copilot");
    expect(vscodeAdapter.sessionVar).toBeNull();
    expect(vscodeAdapter.promptInjection).toBe(false);
  });

  it("detects code on PATH, the user settings directory and ~/.copilot, and nothing else", async () => {
    expect(await vscodeAdapter.detect(ctx())).toBe(false);
    expect(await vscodeAdapter.detect(ctx({ which: (c) => (c === "code" ? "/usr/bin/code" : null) }))).toBe(true);
    mkdirSync(userDir(), { recursive: true });
    expect(await vscodeAdapter.detect(ctx())).toBe(true);
    rmSync(path("Library"), { recursive: true });
    mkdirSync(path(".copilot"));
    expect(await vscodeAdapter.detect(ctx())).toBe(true);
  });

  it("finds the user directory per platform", async () => {
    mkdirSync(path(".config", "Code", "User"), { recursive: true });
    expect(await vscodeAdapter.detect(ctx({ platform: "linux" }))).toBe(true);
    expect(await vscodeAdapter.detect(ctx({ platform: "linux", env: { XDG_CONFIG_HOME: path("xdg") } }))).toBe(false);
    mkdirSync(path("AppData", "Roaming", "Code", "User"), { recursive: true });
    expect(await vscodeAdapter.detect(ctx({ platform: "win32" }))).toBe(true);
  });
});

describe("vscode permission", () => {
  it("adds jubarteai: true to chat.tools.terminal.autoApprove, keeping other settings, and a second run changes nothing", async () => {
    put(settings(), JSON.stringify({ "editor.fontSize": 14, "chat.tools.terminal.autoApprove": { git: true, "/^rm\\b/": false } }, null, 4) + "\n");
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect(step.files).toEqual([settings()]);
    expect((await step.apply()).status).toBe("configured");
    expect(readJson(settings())).toEqual({ "editor.fontSize": 14, "chat.tools.terminal.autoApprove": { git: true, "/^rm\\b/": false, jubarteai: true } });
    const before = read(settings());
    expect((await step.apply()).status).toBe("already configured");
    expect(read(settings())).toBe(before);
  });

  it("creates settings.json when the user directory exists but the file does not", async () => {
    mkdirSync(userDir(), { recursive: true });
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    expect(readJson(settings())).toEqual({ "chat.tools.terminal.autoApprove": { jubarteai: true } });
  });

  it("refuses a settings.json with comments: prints the exact entry and leaves the file as it was", async () => {
    const text = '{\n  // my settings\n  "editor.fontSize": 14,\n}\n';
    put(settings(), text);
    const result = await vscodeAdapter.permission(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain('"chat.tools.terminal.autoApprove"');
    expect(isManual(result) && result.lines.join("\n")).toContain('"jubarteai": true');
    expect(read(settings())).toBe(text);
  });

  it("leaves a jubarteai rule the user set to false alone", async () => {
    const text = JSON.stringify({ "chat.tools.terminal.autoApprove": { jubarteai: false } });
    put(settings(), text);
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("skipped");
    expect(read(settings())).toBe(text);
  });

  it("does nothing when VS Code is absent and only ~/.copilot exists, and prints the entry when only the code binary exists", async () => {
    mkdirSync(path(".copilot"));
    expect(await vscodeAdapter.permission(ctx())).toBeNull();
    const printed = await vscodeAdapter.permission(ctx({ which: () => "/usr/bin/code" }));
    expect(isManual(printed)).toBe(true);
  });
});

describe("vscode hooks (the shared Copilot file)", () => {
  it("writes sessionStart and sessionEnd only, with timeoutSec, and no per-prompt hook", async () => {
    const steps = await vscodeAdapter.hooks(ctx());
    if (steps === null || isManual(steps)) throw new Error("expected steps");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.id).toBe(COPILOT_HOOKS_STEP_ID);
    expect(steps[0]?.files).toEqual([hooksFile()]);
    expect((await steps[0]!.apply()).status).toBe("configured");
    const doc = readJson(hooksFile());
    expect(doc["version"]).toBe(1);
    const hooks = doc["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(hooks).sort()).toEqual(["sessionEnd", "sessionStart"]);
    expect(hooks["sessionStart"]).toEqual([{ type: "command", command: "jubarteai hook session-start --harness vscode", timeoutSec: 8 }]);
    expect(hooks["sessionEnd"]?.[0]?.["command"]).toBe("jubarteai hook session-end --harness vscode");
  });

  it("is idempotent and keeps other hooks; the exported step gives the same file for Copilot CLI", async () => {
    put(hooksFile(), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", command: "./guard.sh" }] } }, null, 2) + "\n");
    const step = copilotHooksStep(ctx());
    expect(step.id).toBe(COPILOT_HOOKS_STEP_ID);
    expect((await step.apply()).status).toBe("configured");
    const once = read(hooksFile());
    expect((await step.apply()).status).toBe("already configured");
    expect(read(hooksFile())).toBe(once);
    const hooks = readJson(hooksFile())["hooks"] as Record<string, unknown>;
    expect(hooks["preToolUse"]).toEqual([{ type: "command", command: "./guard.sh" }]);
    expect(copilotHooksState(ctx())).toBe("configured");
  });

  it("follows COPILOT_HOME when it is absolute", async () => {
    const custom = path("elsewhere");
    const step = copilotHooksStep(ctx({ env: { COPILOT_HOME: custom } }));
    expect(step.files).toEqual([join(custom, "hooks", "jubarteai.json")]);
    expect(copilotHooksStep(ctx({ env: { COPILOT_HOME: "relative" } })).files).toEqual([hooksFile()]);
  });

  it("prints the entry, writing nothing, when the file has comments", async () => {
    const text = '{ // mine\n "version": 1 }\n';
    put(hooksFile(), text);
    const plan = copilotHooksPlan(ctx(), "copilot-cli");
    expect(isManual(plan) && plan.harness).toBe("copilot-cli");
    expect(isManual(plan) && plan.lines.join("\n")).toContain("jubarteai hook session-start --harness vscode");
    expect(read(hooksFile())).toBe(text);
    expect(copilotHooksState(ctx())).toBe("manual");
  });
});

describe("vscode inspect", () => {
  it("reports missing, then configured", async () => {
    mkdirSync(userDir(), { recursive: true });
    const before = await vscodeAdapter.inspect(ctx());
    expect(before).toMatchObject({ permission: "missing", hooks: "missing", mcpEntries: [] });
    const permission = await vscodeAdapter.permission(ctx());
    const hooks = await vscodeAdapter.hooks(ctx());
    if (!isStep(permission) || hooks === null || isManual(hooks)) throw new Error("expected steps");
    await permission.apply();
    await hooks[0]!.apply();
    expect(await vscodeAdapter.inspect(ctx())).toMatchObject({ permission: "configured", hooks: "configured" });
  });

  it("lists user-profile and project mcp.json files that still hold the entry", async () => {
    put(join(userDir(), "mcp.json"), JSON.stringify({ servers: { jubarteai: {} } }));
    put(join(userDir(), "profiles", "work", "mcp.json"), JSON.stringify({ servers: { jubarteai: {} } }));
    put(path(".vscode", "mcp.json"), JSON.stringify({ servers: { other: {} } }));
    const state = await vscodeAdapter.inspect(ctx());
    expect(state.mcpEntries.sort()).toEqual([join(userDir(), "mcp.json"), join(userDir(), "profiles", "work", "mcp.json")].sort());
  });
});

describe("vscode MCP cleanup", () => {
  const scope = (over: Record<string, unknown> = {}) => ({ home, projectRoot: null, platform: "darwin" as const, env: {}, startDir: home, ...over });

  it("removes only servers.jubarteai from the user mcp.json, a profile and .vscode/mcp.json, keeping inputs and other servers", async () => {
    const project = path("work", "app");
    put(join(userDir(), "mcp.json"), JSON.stringify({ servers: { jubarteai: {}, other: { command: "x" } }, inputs: [{ id: "k" }] }, null, 2) + "\n");
    put(join(userDir(), "profiles", "p1", "mcp.json"), JSON.stringify({ servers: { jubarteai: {} } }, null, 2) + "\n");
    put(join(project, ".vscode", "mcp.json"), JSON.stringify({ servers: { jubarteai: {}, mine: {} } }, null, 2) + "\n");
    const steps = await vscodeAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }));
    expect(steps).toHaveLength(3);
    expect((await applyAll(steps)).map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
    expect(readJson(join(userDir(), "mcp.json"))).toEqual({ servers: { other: { command: "x" } }, inputs: [{ id: "k" }] });
    expect(readJson(join(userDir(), "profiles", "p1", "mcp.json"))).toEqual({ servers: {} });
    expect(readJson(join(project, ".vscode", "mcp.json"))).toEqual({ servers: { mine: {} } });
    expect(await vscodeAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }))).toEqual([]);
  });

  it("reports a JSONC mcp.json and leaves it byte-identical", async () => {
    const text = '{\n  // c\n  "servers": { "jubarteai": {}, },\n}\n';
    put(join(userDir(), "mcp.json"), text);
    const steps = await vscodeAdapter.mcpCleanup(scope());
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0]) && steps[0].lines[0]).toContain("remove it by hand");
    expect(read(join(userDir(), "mcp.json"))).toBe(text);
  });

  it("only reports .vscode/mcp.json when run from the home directory", async () => {
    const sub = path("scratch");
    const text = JSON.stringify({ servers: { jubarteai: {} } });
    put(join(sub, ".vscode", "mcp.json"), text);
    const steps = await vscodeAdapter.mcpCleanup(scope({ startDir: sub }));
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0])).toBe(true);
    expect(read(join(sub, ".vscode", "mcp.json"))).toBe(text);
  });
});
