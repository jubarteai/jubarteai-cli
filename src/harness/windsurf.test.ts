import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStep } from "../safe-edit/plan.js";
import { PERSON_COMMANDS, PERSON_COMMAND_LIST } from "./agent-commands.js";
import { windsurfAdapter } from "./windsurf.js";
import type { InitCtx, ManualInstructions } from "./types.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-windsurf-")));
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

const ctx = (): InitCtx => ({ home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai" });
const mcpConfig = (): string => join(home, ".codeium", "windsurf", "mcp_config.json");
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
};
const isManual = (v: unknown): v is ManualInstructions => typeof v === "object" && v !== null && "kind" in v && v.kind === "manual";
const isStep = (v: unknown): v is PlanStep => typeof v === "object" && v !== null && "apply" in v;

describe("windsurf adapter", () => {
  it("declares the verified cells and no prompt injection", () => {
    expect(windsurfAdapter.id).toBe("windsurf");
    expect(windsurfAdapter.skillAgent).toBe("windsurf");
    expect(windsurfAdapter.sessionVar).toBeNull();
    expect(windsurfAdapter.promptInjection).toBe(false);
  });

  it("detects ~/.codeium/windsurf only", async () => {
    expect(await windsurfAdapter.detect(ctx())).toBe(false);
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    expect(await windsurfAdapter.detect(ctx())).toBe(true);
  });

  it("prints instructions for the permission and the hooks, naming the doc gap, and writes nothing", async () => {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const permission = await windsurfAdapter.permission(ctx());
    const hooks = await windsurfAdapter.hooks(ctx());
    expect(isManual(permission) && permission.reason).toContain("not verified (D25)");
    expect(isManual(permission) && permission.lines.join("\n")).toContain("jubarteai");
    // No whole-program entry: the caveat names the person commands and puts each one on the deny list.
    const text = isManual(permission) ? permission.lines.join("\n") : "";
    expect(text).toContain(PERSON_COMMAND_LIST);
    for (const command of PERSON_COMMANDS) expect(text).toContain(`"jubarteai ${command}"`);
    expect(text).not.toMatch(/add the command jubarteai to/i);
    expect(isManual(hooks) && hooks.reason).toContain("not verified (D25)");
    expect(isManual(hooks) && hooks.lines.join("\n")).toContain("--agent");
    expect(isStep(permission) || isStep(hooks)).toBe(false);
    const state = await windsurfAdapter.inspect(ctx());
    expect(state).toMatchObject({ permission: "manual", hooks: "manual", mcpEntries: [] });
  });

  it("removes only mcpServers.jubarteai from mcp_config.json, keeping other servers and keys", async () => {
    put(mcpConfig(), JSON.stringify({ mcpServers: { jubarteai: { serverUrl: "u" }, other: { command: "x" } }, extra: 1 }, null, 2) + "\n");
    expect((await windsurfAdapter.inspect(ctx())).mcpEntries).toEqual([mcpConfig()]);
    const scope = { home, projectRoot: null, platform: "linux" as const, env: {}, startDir: home };
    const steps = await windsurfAdapter.mcpCleanup(scope);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    if (step === undefined || isManual(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("configured");
    expect(JSON.parse(readFileSync(mcpConfig(), "utf8"))).toEqual({ mcpServers: { other: { command: "x" } }, extra: 1 });
    expect(await windsurfAdapter.mcpCleanup(scope)).toEqual([]);
  });

  it("reports a JSONC mcp_config.json and does not edit it", async () => {
    const text = '{ // x\n "mcpServers": { "jubarteai": {} } }\n';
    put(mcpConfig(), text);
    const steps = await windsurfAdapter.mcpCleanup({ home, projectRoot: null, platform: "linux", env: {}, startDir: home });
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0])).toBe(true);
    expect(readFileSync(mcpConfig(), "utf8")).toBe(text);
  });
});
