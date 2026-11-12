import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { agentCommandPattern } from "./agent-commands.js";
import { zedAdapter } from "./zed.js";
import type { InitCtx, ManualInstructions } from "./types.js";
import { applyUi } from "../../test/helpers/apply-ui.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-zed-")));
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

const ctx = (over: Partial<InitCtx> = {}): InitCtx => ({ home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai", ...over });
const settings = (): string => join(home, ".config", "zed", "settings.json");
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

const PATTERN = agentCommandPattern();
const LEGACY = "^jubarteai\\b";
const AGENT_LINES = ["jubarteai search-knowledge --query x", "jubarteai connect", "jubarteai inbox", "jubarteai --help"];
const PERSON_LINES = ["jubarteai login --with-token", "jubarteai link --workspace x", "jubarteai init --yes", "jubarteai update", "jubarteai logout", "jubarteai --yes init"];
const allowList = (): Array<{ pattern: string }> => {
  const agent = readJson(settings())["agent"] as { tool_permissions: { tools: { terminal: { always_allow: Array<{ pattern: string }> } } } };
  return agent.tool_permissions.tools.terminal.always_allow;
};
/** Zed approves a command when any always_allow pattern matches it. */
const zedApproves = (line: string): boolean => allowList().some((entry) => new RegExp(entry.pattern).test(line));

describe("zed adapter facts", () => {
  it("declares the verified cells", () => {
    expect(zedAdapter.id).toBe("zed");
    expect(zedAdapter.skillAgent).toBe("zed");
    expect(zedAdapter.sessionVar).toBeNull();
    expect(zedAdapter.promptInjection).toBe(false);
  });

  it("detects ~/.config/zed, $XDG_CONFIG_HOME/zed on Linux and the zed binary, and nothing else", async () => {
    expect(await zedAdapter.detect(ctx())).toBe(false);
    expect(await zedAdapter.detect(ctx({ which: (c) => (c === "zed" ? "/usr/bin/zed" : null) }))).toBe(true);
    mkdirSync(join(home, ".config", "zed"), { recursive: true });
    expect(await zedAdapter.detect(ctx())).toBe(true);
    const xdg = join(home, "xdg");
    expect(await zedAdapter.detect(ctx({ env: { XDG_CONFIG_HOME: xdg } }))).toBe(false);
    mkdirSync(join(xdg, "zed"), { recursive: true });
    expect(await zedAdapter.detect(ctx({ env: { XDG_CONFIG_HOME: xdg } }))).toBe(true);
    // macOS ignores XDG_CONFIG_HOME, as install.sh's zed_config_dir does.
    expect(await zedAdapter.detect(ctx({ platform: "darwin", env: { XDG_CONFIG_HOME: join(home, "nowhere") } }))).toBe(true);
  });
});

describe("zed permission", () => {
  it("adds the terminal always_allow pattern, keeping other settings and rules, and a second run changes nothing", async () => {
    put(
      settings(),
      JSON.stringify({ theme: "One Dark", agent: { default_model: { provider: "x" }, tool_permissions: { default: "confirm", tools: { terminal: { always_allow: [{ pattern: "^git\\b" }], always_deny: [{ pattern: "rm" }] }, edit_file: { default: "allow" } } } } }, null, 2) + "\n",
    );
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect((await step.apply()).status).toBe("configured");
    expect(readJson(settings())).toEqual({
      theme: "One Dark",
      agent: {
        default_model: { provider: "x" },
        tool_permissions: {
          default: "confirm",
          tools: { terminal: { always_allow: [{ pattern: "^git\\b" }, { pattern: PATTERN }], always_deny: [{ pattern: "rm" }] }, edit_file: { default: "allow" } },
        },
      },
    });
    const before = read(settings());
    expect((await step.apply()).status).toBe("already configured");
    expect(read(settings())).toBe(before);
  });

  it("builds the nested path when the settings file is new", async () => {
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    expect(readJson(settings())).toEqual({ agent: { tool_permissions: { tools: { terminal: { always_allow: [{ pattern: PATTERN }] } } } } });
  });

  it("approves the agent commands and not the person commands, judged from the written pattern, with no lookahead (Rust regex)", async () => {
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    for (const line of AGENT_LINES) expect(zedApproves(line), line).toBe(true);
    for (const line of PERSON_LINES) expect(zedApproves(line), line).toBe(false);
    for (const entry of allowList()) {
      expect(entry.pattern).not.toContain("(?=");
      expect(entry.pattern).not.toContain("(?!");
    }
  });

  it("replaces an earlier ^jubarteai\\b entry in place, keeps every other entry, and a second run changes nothing", async () => {
    put(settings(), JSON.stringify({ agent: { tool_permissions: { tools: { terminal: { always_allow: [{ pattern: "^git\\b" }, { pattern: LEGACY }, { pattern: "^ls\\b" }] } } } } }, null, 2) + "\n");
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.preview).toContain("replaced");
    expect((await step.apply()).status).toBe("configured");
    expect(allowList()).toEqual([{ pattern: "^git\\b" }, { pattern: PATTERN }, { pattern: "^ls\\b" }]);
    for (const line of PERSON_LINES) expect(zedApproves(line), line).toBe(false);
    const before = read(settings());
    expect((await step.apply()).status).toBe("already configured");
    expect(read(settings())).toBe(before);
  });

  it("drops a leftover legacy entry when the new pattern is already there", async () => {
    put(settings(), JSON.stringify({ agent: { tool_permissions: { tools: { terminal: { always_allow: [{ pattern: PATTERN }, { pattern: LEGACY }] } } } } }));
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("configured");
    expect(allowList()).toEqual([{ pattern: PATTERN }]);
  });

  it("refuses a settings.json with comments: prints the exact entry and leaves the file as it was", async () => {
    const text = '{\n  // zed\n  "theme": "One Dark",\n}\n';
    put(settings(), text);
    const result = await zedAdapter.permission(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain(`"pattern": ${JSON.stringify(PATTERN)}`);
    expect(read(settings())).toBe(text);
  });

  it("does not merge into an always_allow that is not a list", async () => {
    const text = JSON.stringify({ agent: { tool_permissions: { tools: { terminal: { always_allow: "all" } } } } });
    put(settings(), text);
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("skipped");
    expect(read(settings())).toBe(text);
  });
});

describe("zed hooks and inspect", () => {
  it("prints instructions naming the missing hook API (D25)", async () => {
    const hooks = await zedAdapter.hooks(ctx());
    expect(isManual(hooks) && hooks.reason).toContain("no hook API");
    expect(isManual(hooks) && hooks.lines.join("\n")).toContain("--agent");
  });

  it("reports missing, then configured, and the MCP entries that remain", async () => {
    put(settings(), JSON.stringify({ context_servers: { jubarteai: {} } }));
    const before = await zedAdapter.inspect(ctx());
    expect(before).toMatchObject({ permission: "missing", hooks: "manual", mcpEntries: [settings()] });
    const step = await zedAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    expect((await zedAdapter.inspect(ctx())).permission).toBe("configured");
  });

  it("is not configured with only the legacy pattern, and says so", async () => {
    put(settings(), JSON.stringify({ agent: { tool_permissions: { tools: { terminal: { always_allow: [{ pattern: LEGACY }] } } } } }));
    const state = await zedAdapter.inspect(ctx());
    expect(state.permission).toBe("missing");
    expect(state.notes.join("\n")).toContain("login, logout, link, init and update");
  });

  it("reports a JSONC settings file as manual", async () => {
    put(settings(), "{ // c\n}");
    expect((await zedAdapter.inspect(ctx())).permission).toBe("manual");
  });
});

describe("zed MCP cleanup", () => {
  const scope = (over: Record<string, unknown> = {}) => ({ home, projectRoot: null, platform: "linux" as const, env: {}, startDir: home, ...over });

  it("removes only context_servers.jubarteai from the user and the project settings", async () => {
    const project = join(home, "work", "app");
    put(settings(), JSON.stringify({ theme: "x", context_servers: { jubarteai: { url: "u" }, other: { command: "c" } } }, null, 2) + "\n");
    put(join(project, ".zed", "settings.json"), JSON.stringify({ context_servers: { jubarteai: {} }, tab_size: 2 }, null, 2) + "\n");
    const steps = await zedAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }));
    expect((await applyAll(steps)).map((r) => r.status)).toEqual(["configured", "configured"]);
    expect(readJson(settings())).toEqual({ theme: "x", context_servers: { other: { command: "c" } } });
    expect(readJson(join(project, ".zed", "settings.json"))).toEqual({ context_servers: {}, tab_size: 2 });
    expect(await zedAdapter.mcpCleanup(scope({ projectRoot: project, startDir: project }))).toEqual([]);
  });

  it("reports a settings.json with comments and leaves it byte-identical", async () => {
    const text = '{\n  // zed\n  "context_servers": { "jubarteai": {} }\n}\n';
    put(settings(), text);
    const steps = await zedAdapter.mcpCleanup(scope());
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0]) && steps[0].lines[0]).toContain("remove it by hand");
    expect(read(settings())).toBe(text);
  });

  it("only reports .zed/settings.json when run from the home directory", async () => {
    const sub = join(home, "scratch");
    const file = join(sub, ".zed", "settings.json");
    const text = JSON.stringify({ context_servers: { jubarteai: {} } });
    put(file, text);
    const steps = await zedAdapter.mcpCleanup(scope({ startDir: sub }));
    expect(steps).toHaveLength(1);
    expect(isManual(steps[0])).toBe(true);
    expect(read(file)).toBe(text);
  });
});

describe("zed re-run (spec 6.1: re-running init is safe)", () => {
  it("re-plans the permission as a non-sensitive step that reports already configured without a TTY", async () => {
    const first = (await zedAdapter.permission(ctx())) as PlanStep;
    expect(first.sensitive).toBe(true);
    await applyPlan([first], { tty: false, yes: true, ...applyUi() });
    const again = (await zedAdapter.permission(ctx())) as PlanStep;
    expect(again.sensitive).toBe(false);
    const results = await applyPlan([again], { tty: false, yes: false, ...applyUi() });
    expect(results.map((r) => r.status)).toEqual(["already configured"]);
  });
});
