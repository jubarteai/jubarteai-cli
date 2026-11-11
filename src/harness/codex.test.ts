// Codex adapter: hooks in ~/.codex/hooks.json, the network opt-in (D4–D6, P1) and the D5 fallback for its MCP entry.
// New in the CLI (spec §6.1 step 7, §6.3, §9); the generic MCP cleanup scenarios live in mcp-cleanup.test.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, type PlanStep } from "../safe-edit/plan.js";
import { codexAdapter, createCodexAdapter, CODEX_NETWORK_MIN_VERSION } from "./codex.js";
import type { DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

let root: string;
let home: string;
let proj: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-codex-")));
  home = path.join(root, "home");
  proj = path.join(home, "proj");
  fs.mkdirSync(proj, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const sink = { write: () => true } as unknown as NodeJS.WritableStream;
const isStep = (x: unknown): x is PlanStep => typeof x === "object" && x !== null && "apply" in x;
const isManual = (x: unknown): x is ManualInstructions => typeof x === "object" && x !== null && "kind" in x;

function ctx(over: Partial<InitCtx> = {}): InitCtx {
  return { home, env: {}, platform: "linux", which: (c) => (c === "codex" ? "/usr/bin/codex" : null), projectRoot: proj, cliCommand: "jubarteai", ...over };
}
function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const userConfig = (): string => path.join(home, ".codex", "config.toml");
const projectConfig = (): string => path.join(proj, ".codex", "config.toml");
const hooksJson = (): string => path.join(home, ".codex", "hooks.json");
const trusted = (p = proj): string => `[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`;
const OPT_IN = `[sandbox_workspace_write]\nnetwork_access = true\n`;

type Overrides = { version?: string | null; share?: boolean; tracked?: boolean };
function adapter(o: Overrides = {}): HarnessAdapter & { asked: string[] } {
  const asked: string[] = [];
  const a = createCodexAdapter({
    codexVersion: async () => (o.version === undefined ? "codex-cli 0.162.1" : o.version),
    ask: async (q) => {
      asked.push(q);
      return o.share ?? false;
    },
    isTracked: async () => o.tracked ?? false,
  });
  return Object.assign(a, { asked });
}
async function extrasOf(a: HarnessAdapter, c: InitCtx = ctx()): Promise<Array<PlanStep | ManualInstructions>> {
  return (await a.extras?.(c)) ?? [];
}
const steps = (items: Array<PlanStep | ManualInstructions>): PlanStep[] => items.filter(isStep);
const manuals = (items: Array<PlanStep | ManualInstructions>): ManualInstructions[] => items.filter(isManual);

describe("what the adapter declares", () => {
  it("has no permission rule, no verified session variable, per-prompt injection and extras", async () => {
    expect(codexAdapter).toMatchObject({ id: "codex", skillAgent: "codex", sessionVar: null, promptInjection: true });
    expect(await codexAdapter.permission(ctx())).toBeNull();
    expect(typeof codexAdapter.extras).toBe("function");
  });

  it("detects the codex binary or $CODEX_HOME / ~/.codex", async () => {
    const env = (over: Partial<DetectEnv> = {}): DetectEnv => ({ home, env: {}, platform: "linux", which: () => null, ...over });
    expect(await codexAdapter.detect(env())).toBe(false);
    expect(await codexAdapter.detect(env({ which: () => "/bin/codex" }))).toBe(true);
    fs.mkdirSync(path.join(home, ".codex"));
    expect(await codexAdapter.detect(env())).toBe(true);
    const custom = path.join(root, "ch");
    fs.mkdirSync(custom);
    expect(await codexAdapter.detect(env({ env: { CODEX_HOME: custom } }))).toBe(true);
  });
});

describe("hooks", () => {
  async function apply(c: InitCtx = ctx()): Promise<string[]> {
    const hooks = await codexAdapter.hooks(c);
    expect(Array.isArray(hooks)).toBe(true);
    return (await applyPlan(hooks as PlanStep[], { tty: false, yes: true, out: sink })).map((r) => r.status);
  }

  it("writes the three hooks into ~/.codex/hooks.json, SessionEnd with timeout 3", async () => {
    expect(await apply()).toEqual(["configured"]);
    const hooks = JSON.parse(fs.readFileSync(hooksJson(), "utf8")).hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks["SessionStart"]).toEqual([{ hooks: [{ type: "command", command: "jubarteai hook session-start --harness codex", timeout: 8 }] }]);
    expect(hooks["UserPromptSubmit"]?.[0]?.hooks[0]).toEqual({ type: "command", command: "jubarteai hook user-prompt-submit --harness codex", timeout: 8 });
    expect(hooks["SessionEnd"]?.[0]?.hooks[0]).toEqual({ type: "command", command: "jubarteai hook session-end --harness codex", timeout: 3 });
  });

  it("is idempotent and keeps other tools' hooks and keys", async () => {
    const theirs = { matcher: "startup", hooks: [{ type: "command", command: "other" }] };
    write(hooksJson(), JSON.stringify({ note: 1, hooks: { SessionStart: [theirs] } }));
    await apply();
    const first = fs.readFileSync(hooksJson(), "utf8");
    expect(JSON.parse(first).note).toBe(1);
    expect(JSON.parse(first).hooks.SessionStart[0]).toEqual(theirs);
    expect(await apply()).toEqual(["already configured"]);
    expect(fs.readFileSync(hooksJson(), "utf8")).toBe(first);
    const [step] = (await codexAdapter.hooks(ctx())) as PlanStep[];
    expect(step?.sensitive).toBe(false);
  });

  it("an entry of ours with another command or timeout is updated, not duplicated", async () => {
    write(hooksJson(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "jubarteai hook session-end --harness codex", timeout: 1 }] }] } }));
    await apply();
    const hooks = JSON.parse(fs.readFileSync(hooksJson(), "utf8")).hooks;
    expect(hooks.SessionEnd).toHaveLength(1);
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
  });

  it("$CODEX_HOME moves hooks.json", async () => {
    const custom = path.join(root, "ch");
    expect(await apply(ctx({ env: { CODEX_HOME: custom } }))).toEqual(["configured"]);
    expect(fs.existsSync(path.join(custom, "hooks.json"))).toBe(true);
    expect(fs.existsSync(hooksJson())).toBe(false);
  });

  it("a hooks.json with comments is manual instructions with the trust line, and untouched", async () => {
    const text = `// mine\n{}\n`;
    write(hooksJson(), text);
    const result = await codexAdapter.hooks(ctx());
    expect(result).toMatchObject({ kind: "manual", harness: "codex" });
    expect((result as ManualInstructions).lines).toContain("Trust the new hooks once in Codex: run /hooks");
    expect(fs.readFileSync(hooksJson(), "utf8")).toBe(text);
  });
});

describe("the trust instruction", () => {
  it("is printed while the hooks are not in place, and gone once they are", async () => {
    const a = adapter();
    expect(manuals(await extrasOf(a)).map((m) => m.lines)).toContainEqual(["Trust the new hooks once in Codex: run /hooks"]);
    await applyPlan((await a.hooks(ctx())) as PlanStep[], { tty: false, yes: true, out: sink });
    expect(manuals(await extrasOf(a)).flatMap((m) => m.lines)).not.toContain("Trust the new hooks once in Codex: run /hooks");
  });
});

describe("network opt-in (D4–D6)", () => {
  it("trusted project, new enough Codex, no default_permissions: a sensitive step writes only the project file", async () => {
    write(userConfig(), `model = "x"\n\n${trusted()}`);
    const userBefore = fs.readFileSync(userConfig(), "utf8");
    const a = adapter();
    const items = await extrasOf(a);
    const [step] = steps(items);
    expect(steps(items)).toHaveLength(1);
    expect(step).toMatchObject({ id: "codex:network-optin", sensitive: true, files: [projectConfig()] });
    expect(step?.preview).toBe(`~/proj/.codex/config.toml (this project only):\n[sandbox_workspace_write]\nnetwork_access = true`);
    const [result] = await applyPlan([step as PlanStep], { tty: false, yes: true, out: sink });
    expect(result?.status).toBe("configured");
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(OPT_IN);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(userBefore);
    expect(fs.readFileSync(projectConfig(), "utf8")).not.toContain("[permissions");
  });

  it("D6: private by default, the project file is added to .gitignore", async () => {
    write(userConfig(), trusted());
    const a = adapter({ share: false });
    await applyPlan(steps(await extrasOf(a)), { tty: false, yes: true, out: sink });
    expect(a.asked).toEqual(["Share the Codex network setting with everyone who clones the repo?"]);
    expect(fs.readFileSync(path.join(proj, ".gitignore"), "utf8")).toBe("# jubarteai: private Codex network setting\n/.codex/config.toml\n");
  });

  it("D6: sharing leaves .gitignore alone", async () => {
    write(userConfig(), trusted());
    write(path.join(proj, ".gitignore"), "node_modules\n");
    const a = adapter({ share: true });
    await applyPlan(steps(await extrasOf(a)), { tty: false, yes: true, out: sink });
    expect(fs.readFileSync(path.join(proj, ".gitignore"), "utf8")).toBe("node_modules\n");
  });

  it("D6: a file git already tracks is not asked about and not ignored", async () => {
    write(userConfig(), trusted());
    const a = adapter({ tracked: true });
    await applyPlan(steps(await extrasOf(a)), { tty: false, yes: true, out: sink });
    expect(a.asked).toEqual([]);
    expect(fs.existsSync(path.join(proj, ".gitignore"))).toBe(false);
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(OPT_IN);
  });

  it("keeps the project file's other content and replaces an explicit false", async () => {
    write(userConfig(), trusted());
    write(projectConfig(), `model = "p"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a"]\nnetwork_access = false # no\n`);
    await applyPlan(steps(await extrasOf(adapter())), { tty: false, yes: true, out: sink });
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(`model = "p"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a"]\nnetwork_access = true # no\n`);
  });

  it("a second run: the step is non-sensitive and reports already configured", async () => {
    write(userConfig(), trusted());
    const a = adapter();
    await applyPlan(steps(await extrasOf(a)), { tty: false, yes: true, out: sink });
    const before = fs.readFileSync(projectConfig(), "utf8");
    const [step] = steps(await extrasOf(a));
    expect(step?.sensitive).toBe(false);
    const [result] = await applyPlan([step as PlanStep], { tty: false, yes: false, out: sink });
    expect(result?.status).toBe("already configured");
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(before);
  });

  it("without a TTY and without --yes the step is skipped and nothing is written", async () => {
    write(userConfig(), trusted());
    const [result] = await applyPlan(steps(await extrasOf(adapter())), { tty: false, yes: false, out: sink });
    expect(result).toMatchObject({ status: "skipped", detail: "needs confirmation", flag: "--yes" });
    expect(fs.existsSync(projectConfig())).toBe(false);
  });

  it("the project is trusted by its real path too", async () => {
    const link = path.join(root, "link");
    fs.symlinkSync(proj, link);
    write(userConfig(), trusted(proj));
    const items = await extrasOf(adapter(), ctx({ projectRoot: link }));
    expect(steps(items)).toHaveLength(1);
  });

  it("an untrusted project: nothing is written, the manual text says how to trust it and that the MCP entry stays", async () => {
    write(userConfig(), `[projects."/some/other"]\ntrust_level = "trusted"\n`);
    const items = await extrasOf(adapter());
    expect(steps(items)).toEqual([]);
    const text = manuals(items).flatMap((m) => m.lines).join("\n");
    expect(text).toContain("Trust this project in Codex");
    expect(text).toContain(`[projects.${JSON.stringify(proj)}] trust_level = "trusted"`);
    expect(text).toContain("Codex keeps its jubarteai MCP entry");
    expect(fs.existsSync(projectConfig())).toBe(false);
  });

  it("a project marked untrusted, or no user config at all, is not trusted", async () => {
    write(userConfig(), `[projects.${JSON.stringify(proj)}]\ntrust_level = "untrusted"\n`);
    expect(steps(await extrasOf(adapter()))).toEqual([]);
    fs.rmSync(userConfig());
    expect(steps(await extrasOf(adapter()))).toEqual([]);
  });

  it("Codex older than the verified version: manual, nothing written", async () => {
    write(userConfig(), trusted());
    const items = await extrasOf(adapter({ version: "codex-cli 0.161.9" }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.reason).toBe("Codex too old");
    expect(manuals(items)[0]?.lines[0]).toContain(`older than ${CODEX_NETWORK_MIN_VERSION}`);
  });

  it("the verified version itself and newer ones work, including a two-digit minor", async () => {
    write(userConfig(), trusted());
    for (const version of ["codex-cli 0.162.1", "codex-cli 0.167.1", "codex-cli 1.0.0", "0.200.0"]) {
      expect(steps(await extrasOf(adapter({ version })))).toHaveLength(1);
    }
  });

  it("an unreadable or missing version: manual", async () => {
    write(userConfig(), trusted());
    for (const version of [null, "nope"]) {
      const items = await extrasOf(adapter({ version }));
      expect(steps(items)).toEqual([]);
      expect(manuals(items)[0]?.reason).toBe("Codex version unknown");
    }
  });

  it("default_permissions in the user config or the project's: manual, nothing written", async () => {
    write(userConfig(), `default_permissions = "workspace"\n${trusted()}`);
    let items = await extrasOf(adapter());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.reason).toBe("default_permissions is set");
    write(userConfig(), trusted());
    write(projectConfig(), `  default_permissions="p"\n`);
    items = await extrasOf(adapter());
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.reason).toBe("default_permissions is set");
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(`  default_permissions="p"\n`);
  });

  it("run from ~ or /: no project, so nothing is written and the MCP entry stays", async () => {
    write(userConfig(), trusted());
    const items = await extrasOf(adapter(), ctx({ projectRoot: null }));
    expect(steps(items)).toEqual([]);
    expect(manuals(items)[0]?.reason).toBe("run from ~ or /");
  });

  it("never writes the user-level key, whatever the answers", async () => {
    write(userConfig(), trusted());
    const before = fs.readFileSync(userConfig(), "utf8");
    await applyPlan(steps(await extrasOf(adapter({ share: true }))), { tty: false, yes: true, out: sink });
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(before);
  });

  it("a user-level key someone else set already opens the network: the step is already configured", async () => {
    write(userConfig(), `${OPT_IN}`);
    const [step] = steps(await extrasOf(adapter()));
    expect(step?.sensitive).toBe(false);
    const [result] = await applyPlan([step as PlanStep], { tty: false, yes: false, out: sink });
    expect(result?.status).toBe("already configured");
    expect(fs.existsSync(projectConfig())).toBe(false);
  });
});

describe("D5: Codex keeps its MCP entry unless the opt-in is in place", () => {
  const entry = `[mcp_servers.jubarteai]\nurl = "https://jubarte.ai/api/mcp"\nhttp_headers = { "Authorization" = "Bearer jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12" }\n`;

  async function plan(a: HarnessAdapter): Promise<PlanStep[]> {
    const c = ctx();
    return [...steps(await extrasOf(a, c)), ...steps(await a.mcpCleanup({ home, projectRoot: proj, platform: "linux", env: {}, startDir: proj }))];
  }

  it("trusted project: the opt-in is applied first, then the entries go from the user and project configs", async () => {
    write(userConfig(), `${trusted()}\n${entry}`);
    write(projectConfig(), `${entry}\n[mcp_servers.other]\nurl = "x"\n`);
    const results = await applyPlan(await plan(adapter()), { tty: false, yes: true, out: sink });
    expect(results.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(trusted());
    expect(fs.readFileSync(projectConfig(), "utf8")).toBe(`[mcp_servers.other]\nurl = "x"\n\n${OPT_IN}`);
  });

  it("untrusted project: the entries stay and the cleanup steps say they were kept", async () => {
    write(userConfig(), entry);
    const before = fs.readFileSync(userConfig(), "utf8");
    const results = await applyPlan(await plan(adapter()), { tty: false, yes: true, out: sink });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "skipped", detail: "kept: Codex keeps its jubarteai MCP entry until its network opt-in is in place" });
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(before);
  });

  it("an opt-in the user declined keeps the entries too", async () => {
    write(userConfig(), `${trusted()}\n${entry}`);
    const before = fs.readFileSync(userConfig(), "utf8");
    const results = await applyPlan(await plan(adapter()), { tty: false, yes: false, out: sink });
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(before);
    expect(fs.existsSync(projectConfig())).toBe(false);
  });

  it("an older Codex keeps the entries", async () => {
    write(userConfig(), `${trusted()}\n${entry}`);
    const before = fs.readFileSync(userConfig(), "utf8");
    const results = await applyPlan(await plan(adapter({ version: "codex-cli 0.150.0" })), { tty: false, yes: true, out: sink });
    expect(results.map((r) => r.status)).toEqual(["skipped"]);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(before);
  });

  it("a later run with the opt-in already there removes a leftover entry", async () => {
    write(userConfig(), `${trusted()}\n${entry}`);
    write(projectConfig(), OPT_IN);
    const results = await applyPlan(await plan(adapter()), { tty: false, yes: true, out: sink });
    expect(results.map((r) => r.status)).toEqual(["already configured", "configured"]);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(trusted());
  });

  it("run from ~: every Codex entry is kept", async () => {
    write(userConfig(), entry);
    const a = adapter();
    const results = await applyPlan(steps(await a.mcpCleanup({ home, projectRoot: null, platform: "linux", env: {}, startDir: home })), { tty: false, yes: true, out: sink });
    expect(results.map((r) => r.status)).toEqual(["skipped"]);
    expect(fs.readFileSync(userConfig(), "utf8")).toBe(entry);
  });
});

describe("inspect", () => {
  it("reports hooks, the trust note and the opt-in", async () => {
    const a = adapter();
    write(userConfig(), `${trusted()}\n[mcp_servers.jubarteai]\nurl = "x"\n[features]\nhooks = false\n`);
    let state = await a.inspect(ctx());
    expect(state).toMatchObject({ permission: "n/a", hooks: "missing", mcpEntries: [userConfig()] });
    expect(state.notes).toEqual(["Codex hooks are turned off ([features] hooks = false)", "the network opt-in is not written yet: run jubarteai init"]);
    await applyPlan((await a.hooks(ctx())) as PlanStep[], { tty: false, yes: true, out: sink });
    await applyPlan(steps(await extrasOf(a)), { tty: false, yes: true, out: sink });
    state = await a.inspect(ctx());
    expect(state.hooks).toBe("configured");
    expect(state.notes).toContain("Trust the new hooks once in Codex: run /hooks");
    expect(state.notes).not.toContain("the network opt-in is not written yet: run jubarteai init");
  });

  it("names why the opt-in is blocked", async () => {
    const state = await adapter({ version: "codex-cli 0.1.0" }).inspect(ctx());
    expect(state.notes).toContain("network opt-in: Codex too old; Codex keeps its jubarteai MCP entry");
  });

  it("a hooks.json that can't be edited is manual", async () => {
    write(hooksJson(), "// c\n{}");
    expect(await adapter().inspect(ctx())).toMatchObject({ hooks: "manual" });
  });
});
