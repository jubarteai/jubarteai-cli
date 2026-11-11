import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { applyPlan, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { PERSON_COMMAND_LIST, agentCommandPattern, personCommandPattern } from "./agent-commands.js";
import { spawnSync } from "node:child_process";
import { COPILOT_HOOKS_STEP_ID, GUARD_MISSING_NOTE, copilotHooksPlan, copilotHooksState, copilotHooksStep, vscodeAdapter } from "./vscode.js";
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

const AGENT_KEY = `/${agentCommandPattern()}/`;
const PERSON_KEY = `/${personCommandPattern()}/`;
const AUTO_APPROVE = "chat.tools.terminal.autoApprove";
/** The preToolUse guard entry init writes for `program`. */
const GUARD = (program: string): Record<string, unknown> => ({
  type: "command",
  matcher: "bash|powershell",
  bash: `${program} hook pre-tool-use --harness vscode || true`,
  powershell: `try { & ${program === "jubarteai" ? "jubarteai.cmd" : program} hook pre-tool-use --harness vscode } catch { }; exit 0`,
  timeoutSec: 8,
});
const autoApprove = (): Record<string, boolean> => readJson(settings())[AUTO_APPROVE] as Record<string, boolean>;

/** VS Code's rule: a `/regex/` key is a regular expression, any other key matches the command word; a false match wins over a true one. */
function approved(rules: Record<string, boolean>, line: string): boolean {
  const matches = (key: string): boolean => (key.length > 2 && key.startsWith("/") && key.endsWith("/") ? new RegExp(key.slice(1, -1)).test(line) : line === key || line.startsWith(`${key} `));
  const keys = Object.keys(rules).filter(matches);
  return keys.some((k) => rules[k] === true) && !keys.some((k) => rules[k] === false);
}

const AGENT_LINES = ["jubarteai search-knowledge --query x", "jubarteai connect", "jubarteai inbox", "jubarteai --help"];
const PERSON_LINES = ["jubarteai login --with-token", "jubarteai link --workspace x", "jubarteai init --yes", "jubarteai update", "jubarteai logout", "jubarteai --yes init"];
/** Spellings the shell turns back into a person command; VS Code sees them as written. */
const QUOTED_PERSON_LINES = ['jubarteai "login" --with-token', "jubarteai 'init' --yes", "jubarteai lo\\gin --with-token", 'jubarteai "link" --workspace x'];

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
  it("adds the agent-commands rule (true) and the person-commands rule (false) to chat.tools.terminal.autoApprove, keeping other settings, and a second run changes nothing", async () => {
    put(settings(), JSON.stringify({ "editor.fontSize": 14, "chat.tools.terminal.autoApprove": { git: true, "/^rm\\b/": false } }, null, 4) + "\n");
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect(step.files).toEqual([settings()]);
    expect((await step.apply()).status).toBe("configured");
    expect(readJson(settings())).toEqual({ "editor.fontSize": 14, "chat.tools.terminal.autoApprove": { git: true, "/^rm\\b/": false, [AGENT_KEY]: true, [PERSON_KEY]: false } });
    const before = read(settings());
    expect((await step.apply()).status).toBe("already configured");
    expect(read(settings())).toBe(before);
  });

  it("creates settings.json when the user directory exists but the file does not", async () => {
    mkdirSync(userDir(), { recursive: true });
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    expect(readJson(settings())).toEqual({ "chat.tools.terminal.autoApprove": { [AGENT_KEY]: true, [PERSON_KEY]: false } });
  });

  it("approves the agent commands and not the person commands, judged from the written keys (a false match wins)", async () => {
    mkdirSync(userDir(), { recursive: true });
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    const rules = autoApprove();
    for (const line of AGENT_LINES) expect(approved(rules, line), line).toBe(true);
    for (const line of PERSON_LINES) expect(approved(rules, line), line).toBe(false);
    expect(Object.keys(rules).some((k) => k === "jubarteai")).toBe(false);
    expect(JSON.stringify(rules)).not.toContain("(?=");
    expect(JSON.stringify(rules)).not.toContain("(?!");
  });

  it("removes a broad jubarteai: true entry, which would approve a shell-quoted person command, and says so in the preview", async () => {
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: true, git: true } }));
    // VS Code matches the raw text, so the quoted spelling misses the false regex and the broad key approves it.
    expect(approved({ jubarteai: true, [AGENT_KEY]: true, [PERSON_KEY]: false }, 'jubarteai "login" --with-token')).toBe(true);
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect(step.preview).toContain('removes chat.tools.terminal.autoApprove["jubarteai"]: true');
    expect((await step.apply()).status).toBe("configured");
    const rules = autoApprove();
    expect(rules).toEqual({ git: true, [AGENT_KEY]: true, [PERSON_KEY]: false });
    for (const line of AGENT_LINES) expect(approved(rules, line), line).toBe(true);
    for (const line of [...PERSON_LINES, ...QUOTED_PERSON_LINES]) expect(approved(rules, line), line).toBe(false);
  });

  it("removes the broad entry even when both of ours are already in place", async () => {
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: true, [AGENT_KEY]: true, [PERSON_KEY]: false } }));
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.sensitive).toBe(true);
    expect((await step.apply()).status).toBe("configured");
    expect(autoApprove()).toEqual({ [AGENT_KEY]: true, [PERSON_KEY]: false });
    expect((await step.apply()).status).toBe("already configured");
  });

  it("leaves a jubarteai key the user set to false alone (only an exact true is removed)", async () => {
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: false } }));
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect(step.preview).not.toContain("removes");
    await step.apply();
    expect(autoApprove()).toEqual({ jubarteai: false, [AGENT_KEY]: true, [PERSON_KEY]: false });
  });

  it("adds only the missing key when one of the two is already there", async () => {
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { [AGENT_KEY]: true } }));
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("configured");
    expect(autoApprove()).toEqual({ [AGENT_KEY]: true, [PERSON_KEY]: false });
  });

  it("leaves a person-commands key the user set to true alone", async () => {
    const text = JSON.stringify({ [AUTO_APPROVE]: { [PERSON_KEY]: true } });
    put(settings(), text);
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("skipped");
    expect(read(settings())).toBe(text);
  });

  it("does not merge into an autoApprove that is not an object", async () => {
    const text = JSON.stringify({ [AUTO_APPROVE]: ["jubarteai"] });
    put(settings(), text);
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    expect((await step.apply()).status).toBe("skipped");
    expect(read(settings())).toBe(text);
  });

  it("refuses a settings.json with comments: prints the exact entry and leaves the file as it was", async () => {
    const text = '{\n  // my settings\n  "editor.fontSize": 14,\n}\n';
    put(settings(), text);
    const result = await vscodeAdapter.permission(ctx());
    expect(isManual(result)).toBe(true);
    expect(isManual(result) && result.lines.join("\n")).toContain('"chat.tools.terminal.autoApprove"');
    const printed = isManual(result) ? result.lines.join("\n") : "";
    expect(printed).toContain(JSON.stringify(AGENT_KEY) + ": true");
    expect(printed).toContain(JSON.stringify(PERSON_KEY) + ": false");
    expect(read(settings())).toBe(text);
  });

  it("leaves an agent-commands rule the user set to false alone", async () => {
    const text = JSON.stringify({ "chat.tools.terminal.autoApprove": { [AGENT_KEY]: false } });
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
  it("writes sessionStart, sessionEnd and the preToolUse guard, with timeoutSec, and no per-prompt hook", async () => {
    const steps = await vscodeAdapter.hooks(ctx());
    if (steps === null || isManual(steps)) throw new Error("expected steps");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.id).toBe(COPILOT_HOOKS_STEP_ID);
    expect(steps[0]?.files).toEqual([hooksFile()]);
    expect((await steps[0]!.apply()).status).toBe("configured");
    const doc = readJson(hooksFile());
    expect(doc["version"]).toBe(1);
    const hooks = doc["hooks"] as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(hooks).sort()).toEqual(["preToolUse", "sessionEnd", "sessionStart"]);
    expect(hooks["preToolUse"]).toEqual([GUARD("jubarteai")]);
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
    // Another tool's preToolUse entry stays first; ours is appended after it.
    expect(hooks["preToolUse"]).toEqual([{ type: "command", command: "./guard.sh" }, GUARD("jubarteai")]);
    expect(copilotHooksState(ctx())).toBe("configured");
  });

  it("runs ctx.hookCommand while the auto-approve rules keep the bare name, and a re-run with another program path updates in place", async () => {
    mkdirSync(userDir(), { recursive: true });
    const program = (node: string): string => `"${node}" "/opt/jubarteai/bin/jubarteai.js"`;
    const permission = await vscodeAdapter.permission(ctx({ hookCommand: program("/old/node") }));
    if (!isStep(permission)) throw new Error("expected a step");
    await permission.apply();
    expect(readJson(settings())["chat.tools.terminal.autoApprove"]).toEqual({ [AGENT_KEY]: true, [PERSON_KEY]: false });
    await copilotHooksStep(ctx({ hookCommand: program("/old/node") })).apply();
    expect(copilotHooksState(ctx({ hookCommand: program("/old/node") }))).toBe("configured");
    expect(copilotHooksState(ctx({ hookCommand: program("/new/node") }))).toBe("partial");
    const step = copilotHooksStep(ctx({ hookCommand: program("/new/node") }));
    expect(step.sensitive).toBe(true);
    expect((await step.apply()).status).toBe("configured");
    const hooks = readJson(hooksFile())["hooks"] as Record<string, unknown>;
    expect(hooks["sessionStart"]).toEqual([{ type: "command", command: `${program("/new/node")} hook session-start --harness vscode`, timeoutSec: 8 }]);
    expect(hooks["sessionEnd"]).toEqual([{ type: "command", command: `${program("/new/node")} hook session-end --harness vscode`, timeoutSec: 3 }]);
    expect(hooks["preToolUse"]).toEqual([GUARD(program("/new/node"))]);
    expect(copilotHooksState(ctx({ hookCommand: program("/new/node") }))).toBe("configured");
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

describe("the preToolUse guard in the shared Copilot file (review R-S12)", () => {
  const SESSION_ONLY = {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", command: "jubarteai hook session-start --harness vscode", timeoutSec: 8 }],
      sessionEnd: [{ type: "command", command: "jubarteai hook session-end --harness vscode", timeoutSec: 3 }],
    },
  };

  it("a file with the session hooks only is partial, doctor notes the missing guard, and init adds it", async () => {
    put(hooksFile(), JSON.stringify(SESSION_ONLY, null, 2) + "\n");
    expect(copilotHooksState(ctx())).toBe("partial");
    expect((await vscodeAdapter.inspect(ctx())).notes).toContain(GUARD_MISSING_NOTE);
    const step = copilotHooksStep(ctx());
    expect(step.sensitive).toBe(true);
    expect(step.preview).toContain("hooks.preToolUse: jubarteai hook pre-tool-use --harness vscode");
    expect((await step.apply()).status).toBe("configured");
    expect((readJson(hooksFile())["hooks"] as Record<string, unknown>)["preToolUse"]).toEqual([GUARD("jubarteai")]);
    expect(copilotHooksState(ctx())).toBe("configured");
    expect((await vscodeAdapter.inspect(ctx())).notes).not.toContain(GUARD_MISSING_NOTE);
  });

  it("no guard note when there is no hook file of ours at all (the hooks state says missing)", async () => {
    expect((await vscodeAdapter.inspect(ctx())).notes).not.toContain(GUARD_MISSING_NOTE);
  });

  it("drops a second copy of ours and rewrites a stale one in place, keeping other tools' entries", async () => {
    const other = { type: "command", bash: "./audit.sh", matcher: "bash" };
    const stale = { ...GUARD('"/old/node" "/x/jubarteai.js"'), timeoutSec: 30 };
    put(hooksFile(), JSON.stringify({ ...SESSION_ONLY, hooks: { ...SESSION_ONLY.hooks, preToolUse: [stale, other, GUARD("jubarteai")] } }));
    expect(copilotHooksState(ctx())).toBe("partial");
    expect((await copilotHooksStep(ctx()).apply()).status).toBe("configured");
    expect((readJson(hooksFile())["hooks"] as Record<string, unknown>)["preToolUse"]).toEqual([GUARD("jubarteai"), other]);
  });

  it("refuses to merge into a preToolUse that is not a list", async () => {
    put(hooksFile(), JSON.stringify({ version: 1, hooks: { preToolUse: { type: "command" } } }));
    const result = await copilotHooksStep(ctx()).apply();
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("hooks.preToolUse");
  });

  it("the printed entry (a file with comments) carries the guard too", async () => {
    put(hooksFile(), '{ // mine\n "version": 1 }\n');
    const plan = copilotHooksPlan(ctx(), "vscode");
    expect(isManual(plan) && plan.lines.join("\n")).toContain("hook pre-tool-use --harness vscode || true");
  });

  it.skipIf(process.platform === "win32")("its bash command exits 0 with no output when the program is gone, so a lost Node never blocks every tool call", () => {
    const bash = GUARD('"/nonexistent/node" "/nonexistent/jubarteai.js"')["bash"] as string;
    const run = spawnSync("/bin/bash", ["-c", bash], { input: JSON.stringify({ toolName: "bash", toolArgs: '{"command":"jubarteai login"}' }), encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
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

  it("is configured only when the agent key is true and the person key is false, and notes a broad jubarteai: true", async () => {
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: true, [AGENT_KEY]: true } }));
    const half = await vscodeAdapter.inspect(ctx());
    expect(half.permission).toBe("missing");
    expect(half.notes.join("\n")).toContain('"jubarteai": true');
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: true } }));
    expect((await vscodeAdapter.inspect(ctx())).permission).toBe("missing");
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { [AGENT_KEY]: true, [PERSON_KEY]: false } }));
    const done = await vscodeAdapter.inspect(ctx());
    expect(done.permission).toBe("configured");
    expect(done.notes.join("\n")).not.toContain('"jubarteai": true');
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { [AGENT_KEY]: true, [PERSON_KEY]: true } }));
    expect((await vscodeAdapter.inspect(ctx())).permission).toBe("missing");
  });

  it("notes the object form jubarteai: { approve: true } and leaves it for the person to remove (review R-N13)", async () => {
    const object = { approve: true, matchCommandLine: true };
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: object } }));
    const notes = (await vscodeAdapter.inspect(ctx())).notes.join("\n");
    expect(notes).toContain('"jubarteai": { "approve": true }');
    expect(notes).toContain("remove it by hand");
    expect(notes).toContain(PERSON_COMMAND_LIST);
    // init adds its keys and leaves the object as the person set it.
    const step = await vscodeAdapter.permission(ctx());
    if (!isStep(step)) throw new Error("expected a step");
    await step.apply();
    expect((JSON.parse(readFileSync(settings(), "utf8")) as Record<string, Record<string, unknown>>)[AUTO_APPROVE]).toEqual({ jubarteai: object, [AGENT_KEY]: true, [PERSON_KEY]: false });
    // An object that doesn't approve is not reported.
    put(settings(), JSON.stringify({ [AUTO_APPROVE]: { jubarteai: { approve: false } } }));
    expect((await vscodeAdapter.inspect(ctx())).notes.join("\n")).not.toContain("approve");
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

describe("vscode re-run (spec 6.1: re-running init is safe)", () => {
  it("re-plans the permission and the shared hooks as non-sensitive steps that report already configured without a TTY", async () => {
    mkdirSync(userDir(), { recursive: true });
    const plan = async (): Promise<PlanStep[]> => [(await vscodeAdapter.permission(ctx())) as PlanStep, ...((await vscodeAdapter.hooks(ctx())) as PlanStep[])];
    const first = await plan();
    expect(first.map((s) => s.sensitive)).toEqual([true, true]);
    await applyPlan(first, { tty: false, yes: true, out: new PassThrough() });
    const again = await plan();
    expect(again.map((s) => s.sensitive)).toEqual([false, false]);
    const results = await applyPlan(again, { tty: false, yes: false, out: new PassThrough() });
    expect(results.map((r) => r.status)).toEqual(["already configured", "already configured"]);
  });
});
