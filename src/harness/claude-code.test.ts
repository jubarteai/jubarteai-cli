// Claude Code adapter: the permission rule and the three hooks in settings.json, idempotent and non-destructive.
// New in the CLI (spec §6.1 step 7, §6.3, §9; P2 §3.1); the MCP cleanup scenarios live in mcp-cleanup.test.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { claudeCodeAdapter, HOOK_EVENTS, inspectCommandHooks, isOurHookCommand, mergeCommandHooks, settingsPath } from "./claude-code.js";
import type { DetectEnv, InitCtx, ManualInstructions } from "./types.js";
import { applyUi } from "../../test/helpers/apply-ui.js";

const isWindows = process.platform === "win32";

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-claude-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});


function ctx(over: Partial<InitCtx> = {}): InitCtx {
  return { home, env: {}, platform: "linux", which: () => null, projectRoot: path.join(home, "proj"), cliCommand: "jubarteai", ...over };
}
const settings = (): string => path.join(home, ".claude", "settings.json");
function writeSettings(value: unknown): void {
  fs.mkdirSync(path.dirname(settings()), { recursive: true });
  fs.writeFileSync(settings(), `${JSON.stringify(value, null, 2)}\n`);
}
const readSettings = (): Record<string, unknown> => JSON.parse(fs.readFileSync(settings(), "utf8")) as Record<string, unknown>;
const isStep = (x: unknown): x is PlanStep => typeof x === "object" && x !== null && "apply" in x;

async function applyAll(c: InitCtx): Promise<StepResult[]> {
  const steps: PlanStep[] = [];
  const perm = await claudeCodeAdapter.permission(c);
  if (isStep(perm)) steps.push(perm);
  const hooks = await claudeCodeAdapter.hooks(c);
  if (Array.isArray(hooks)) steps.push(...hooks);
  return applyPlan(steps, { tty: false, yes: true, ...applyUi() });
}

// No rule for a leading flag: the router refuses one before the command name, and `jubarteai --help` must stay
// pre-approved (review R-S8).
const ASK_BASH = ["login", "logout", "link", "init", "update"].flatMap((sub) => [`Bash(jubarteai ${sub})`, `Bash(jubarteai ${sub} *)`]);
const ASK_POWERSHELL = ASK_BASH.map((rule) => rule.replace(/^Bash/, "PowerShell"));

const COMMANDS = {
  SessionStart: "jubarteai hook session-start --harness claude-code",
  UserPromptSubmit: "jubarteai hook user-prompt-submit --harness claude-code",
  SessionEnd: "jubarteai hook session-end --harness claude-code",
};

describe("permission and hooks", () => {
  it("merges the permission rule and the three hooks into a fresh settings.json", async () => {
    const results = await applyAll(ctx());
    expect(results.map((r) => r.status)).toEqual(["configured", "configured"]);
    const doc = readSettings();
    expect(doc["permissions"]).toEqual({ allow: ["Bash(jubarteai *)"], ask: ASK_BASH });
    const hooks = doc["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
    expect(hooks["SessionStart"]).toEqual([{ hooks: [{ type: "command", command: COMMANDS.SessionStart, timeout: 8 }] }]);
    expect(hooks["UserPromptSubmit"]?.[0]?.hooks[0]).toEqual({ type: "command", command: COMMANDS.UserPromptSubmit, timeout: 8 });
    expect(hooks["SessionEnd"]?.[0]?.hooks[0]).toEqual({ type: "command", command: COMMANDS.SessionEnd, timeout: 5 });
  });

  it("keeps other keys, other allow rules and other tools' hooks on the same events", async () => {
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "other-tool log" }] };
    writeSettings({
      theme: "dark",
      permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"] },
      hooks: { SessionStart: [theirs], PreToolUse: [theirs] },
    });
    await applyAll(ctx());
    const doc = readSettings();
    expect(doc["theme"]).toBe("dark");
    expect(doc["permissions"]).toEqual({ allow: ["Bash(git status)", "Bash(jubarteai *)"], deny: ["Read(.env)"], ask: ASK_BASH });
    const hooks = doc["hooks"] as Record<string, unknown[]>;
    expect(hooks["SessionStart"]).toEqual([theirs, { hooks: [{ type: "command", command: COMMANDS.SessionStart, timeout: 8 }] }]);
    expect(hooks["PreToolUse"]).toEqual([theirs]);
  });

  it("a second run changes nothing: no sensitive step, 'already configured', file byte-identical", async () => {
    await applyAll(ctx());
    const before = fs.readFileSync(settings(), "utf8");
    const perm = await claudeCodeAdapter.permission(ctx());
    const hooks = (await claudeCodeAdapter.hooks(ctx())) as PlanStep[];
    expect(isStep(perm) && perm.sensitive).toBe(false);
    expect(hooks.map((h) => h.sensitive)).toEqual([false]);
    const results = await applyAll(ctx());
    expect(results.map((r) => r.status)).toEqual(["already configured", "already configured"]);
    expect(fs.readFileSync(settings(), "utf8")).toBe(before);
  });

  it("an entry of ours with a different command is updated, not duplicated", async () => {
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/jubarteai hook session-start --harness cursor", timeout: 99, statusMessage: "keep me" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "jubarteai hook session-end", timeout: 1 }] }, { hooks: [{ type: "command", command: "jubarteai.cmd hook session-end --harness claude-code" }] }],
      },
    });
    await applyAll(ctx());
    const hooks = readSettings()["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks["SessionStart"]).toHaveLength(1);
    expect(hooks["SessionStart"]?.[0]?.hooks).toEqual([{ type: "command", command: COMMANDS.SessionStart, timeout: 8, statusMessage: "keep me" }]);
    expect(hooks["SessionEnd"]).toHaveLength(1);
    expect(hooks["SessionEnd"]?.[0]?.hooks).toEqual([{ type: "command", command: COMMANDS.SessionEnd, timeout: 5 }]);
  });

  it("the permission rule keeps the bare name while the hooks run ctx.hookCommand", async () => {
    const program = '"/usr/local/bin/node" "/opt/jubarteai/bin/jubarteai.js"';
    await applyAll(ctx({ hookCommand: program }));
    const doc = readSettings();
    expect(doc["permissions"]).toEqual({ allow: ["Bash(jubarteai *)"], ask: ASK_BASH });
    const hooks = doc["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks["SessionStart"]?.[0]?.hooks[0]?.["command"]).toBe(`${program} hook session-start --harness claude-code`);
    expect(JSON.stringify(doc["permissions"])).not.toContain("node");
  });

  it("a re-run with another program path (a Node upgrade) updates our hooks in place, and inspect recognizes them", async () => {
    const program = (node: string): string => `"${node}" "/opt/jubarteai/bin/jubarteai.js"`;
    await applyAll(ctx({ hookCommand: program("/nvm/v24.1.0/bin/node") }));
    const [step] = (await claudeCodeAdapter.hooks(ctx({ hookCommand: program("/nvm/v24.9.0/bin/node") }))) as PlanStep[];
    expect(step?.sensitive).toBe(true);
    expect((await claudeCodeAdapter.inspect(ctx({ hookCommand: program("/nvm/v24.9.0/bin/node") }))).hooks).toBe("partial");
    await applyAll(ctx({ hookCommand: program("/nvm/v24.9.0/bin/node") }));
    const hooks = readSettings()["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]?.[0]?.hooks).toHaveLength(1);
      expect(hooks[event]?.[0]?.hooks[0]?.["command"]).toMatch(/^"\/nvm\/v24\.9\.0\/bin\/node" /);
    }
    expect((await claudeCodeAdapter.inspect(ctx({ hookCommand: program("/nvm/v24.9.0/bin/node") }))).hooks).toBe("configured");
  });

  // Review M3: duplicates were spliced by shifted indexes and took another tool's hook with them.
  it("duplicates of ours in one group go, and another tool's hook in the same group stays", async () => {
    const theirs = { type: "command", command: "other-tool log" };
    writeSettings({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: COMMANDS.SessionStart, timeout: 8 },
              { type: "command", command: "/usr/local/bin/jubarteai hook session-start --harness claude-code" },
              { type: "command", command: "/opt/x/jubarteai hook session-start" },
              theirs,
            ],
          },
          { hooks: [{ type: "command", command: "/old/jubarteai hook session-start" }] },
        ],
      },
    });
    await applyAll(ctx());
    const groups = (readSettings()["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)["SessionStart"] ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks).toEqual([{ type: "command", command: COMMANDS.SessionStart, timeout: 8 }, theirs]);
  });

  it("when the first of ours is not the first entry, the duplicates still go and everything else stays", async () => {
    const a = { type: "command", command: "tool-a" };
    const b = { type: "command", command: "tool-b" };
    writeSettings({
      hooks: { SessionEnd: [{ hooks: [a, { type: "command", command: "jubarteai hook session-end", timeout: 1 }, b, { type: "command", command: "/x/jubarteai hook session-end" }, { type: "command", command: "/y/jubarteai hook session-end" }] }] },
    });
    await applyAll(ctx());
    const groups = (readSettings()["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)["SessionEnd"] ?? [];
    expect(groups[0]?.hooks).toEqual([a, { type: "command", command: COMMANDS.SessionEnd, timeout: 5 }, b]);
  });

  it.skipIf(isWindows || (process.getuid?.() ?? 1) === 0)("an unreadable settings.json is manual instructions, not a rejection", async () => {
    writeSettings({});
    fs.chmodSync(settings(), 0o000);
    try {
      for (const result of [await claudeCodeAdapter.permission(ctx()), await claudeCodeAdapter.hooks(ctx())]) {
        expect(result).toMatchObject({ kind: "manual", harness: "claude-code" });
        expect((result as ManualInstructions).lines).toEqual(["couldn't read ~/.claude/settings.json: fix its permissions, then run jubarteai init again"]);
      }
      expect(await claudeCodeAdapter.inspect(ctx())).toMatchObject({ permission: "manual", hooks: "manual" });
    } finally {
      fs.chmodSync(settings(), 0o600);
    }
  });

  it("the equivalent Bash(jubarteai:*) rules count as configured", async () => {
    const askColon = ASK_BASH.map((rule) => rule.replace(/ \*\)$/, ":*)"));
    writeSettings({ permissions: { allow: ["Bash(jubarteai:*)"], ask: askColon } });
    const perm = await claudeCodeAdapter.permission(ctx());
    expect(isStep(perm) && perm.sensitive).toBe(false);
    await applyAll(ctx());
    expect(readSettings()["permissions"]).toEqual({ allow: ["Bash(jubarteai:*)"], ask: askColon });
  });

  it("an older allow-only setup is not done: the ask rules are added, nothing else changes (R-M1)", async () => {
    writeSettings({ permissions: { allow: ["Bash(jubarteai *)"], ask: ["Bash(rm *)"] } });
    const perm = await claudeCodeAdapter.permission(ctx());
    expect(isStep(perm) && perm.sensitive).toBe(true);
    expect(await claudeCodeAdapter.inspect(ctx())).toMatchObject({ permission: "missing" });
    await applyAll(ctx());
    expect(readSettings()["permissions"]).toEqual({ allow: ["Bash(jubarteai *)"], ask: ["Bash(rm *)", ...ASK_BASH] });
    const again = await applyAll(ctx());
    expect(again.find((r) => r.id === "claude-code:permission")?.status).toBe("already configured");
  });

  it("a permissions.ask that is not a list gives manual instructions", async () => {
    writeSettings({ permissions: { ask: "Bash(*)" } });
    expect(await claudeCodeAdapter.permission(ctx())).toMatchObject({ kind: "manual" });
  });

  it("on Windows the PowerShell rule is added too", async () => {
    await applyAll(ctx({ platform: "win32" }));
    expect(readSettings()["permissions"]).toEqual({ allow: ["Bash(jubarteai *)", "PowerShell(jubarteai *)"], ask: [...ASK_BASH, ...ASK_POWERSHELL] });
  });

  it("CLAUDE_CONFIG_DIR moves settings.json", async () => {
    const dir = path.join(root, "conf");
    await applyAll(ctx({ env: { CLAUDE_CONFIG_DIR: dir } }));
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(true);
    expect(fs.existsSync(settings())).toBe(false);
    expect(settingsPath(home, { CLAUDE_CONFIG_DIR: dir })).toBe(path.join(dir, "settings.json"));
  });

  it("the steps are sensitive until done, show the exact entries and touch only settings.json", async () => {
    const perm = (await claudeCodeAdapter.permission(ctx())) as PlanStep;
    const [hooks] = (await claudeCodeAdapter.hooks(ctx())) as PlanStep[];
    expect(perm.sensitive).toBe(true);
    expect(JSON.parse(perm.preview ?? "")).toEqual({ permissions: { allow: ["Bash(jubarteai *)"], ask: ASK_BASH } });
    expect(hooks?.sensitive).toBe(true);
    expect(JSON.parse(hooks?.preview ?? "").hooks.SessionEnd[0].hooks[0].timeout).toBe(5);
    expect(perm.files).toEqual([settings()]);
    expect(hooks?.files).toEqual([settings()]);
  });

  it("without a TTY and without --yes the sensitive steps are skipped, nothing is written", async () => {
    const perm = (await claudeCodeAdapter.permission(ctx())) as PlanStep;
    const [hooks] = (await claudeCodeAdapter.hooks(ctx())) as PlanStep[];
    const results = await applyPlan([perm, hooks as PlanStep], { tty: false, yes: false, ...applyUi() });
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(fs.existsSync(settings())).toBe(false);
  });

  it("a settings.json with comments, invalid JSON or a wrong shape gives manual instructions and is never touched", async () => {
    for (const text of [`// mine\n{ "permissions": {} }\n`, "{ nope", "[]"]) {
      fs.mkdirSync(path.dirname(settings()), { recursive: true });
      fs.writeFileSync(settings(), text);
      for (const result of [await claudeCodeAdapter.permission(ctx()), await claudeCodeAdapter.hooks(ctx())]) {
        expect(result).toMatchObject({ kind: "manual", harness: "claude-code" });
        expect((result as ManualInstructions).lines.join("\n")).toContain("Edit ~/.claude/settings.json by hand");
      }
      expect(fs.readFileSync(settings(), "utf8")).toBe(text);
    }
  });

  it("a permissions or hooks value of the wrong type gives manual instructions", async () => {
    writeSettings({ permissions: { allow: "Bash(*)" }, hooks: [] });
    expect(await claudeCodeAdapter.permission(ctx())).toMatchObject({ kind: "manual" });
    expect(await claudeCodeAdapter.hooks(ctx())).toMatchObject({ kind: "manual" });
  });

  it("a conflict that appears between planning and applying fails the step and writes nothing", async () => {
    const perm = (await claudeCodeAdapter.permission(ctx())) as PlanStep;
    writeSettings({ permissions: [] });
    const before = fs.readFileSync(settings(), "utf8");
    const [result] = await applyPlan([perm], { tty: false, yes: true, ...applyUi() });
    expect(result).toMatchObject({ status: "failed", detail: "~/.claude/settings.json: permissions is not an object" });
    expect(fs.readFileSync(settings(), "utf8")).toBe(before);
  });

  it.skipIf(isWindows)("a symlinked settings.json inside home is written through, one leaving home fails with a fixed reason", async () => {
    const real = path.join(home, "dotfiles", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "{}\n");
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.symlinkSync(real, settings());
    expect((await applyAll(ctx())).map((r) => r.status)).toEqual(["configured", "configured"]);
    expect(fs.lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8")).permissions.allow).toEqual(["Bash(jubarteai *)"]);

    fs.rmSync(settings());
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, settings());
    const results = await applyAll(ctx());
    expect(results.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(results[0]?.detail).toBe("could not write (outside-home)");
    expect(fs.readFileSync(outside, "utf8")).toBe("{}\n");
  });
});

describe("mergeCommandHooks / inspectCommandHooks", () => {
  const spec = { events: HOOK_EVENTS, cliCommand: "jubarteai", harness: "claude-code" };

  it("is a no-op on a document that already has exactly our hooks", () => {
    const doc: Record<string, unknown> = {};
    expect(mergeCommandHooks(doc, spec).changed).toBe(true);
    expect(mergeCommandHooks(doc, spec)).toEqual({ changed: false });
    expect(inspectCommandHooks(doc, spec)).toBe("configured");
  });

  it("reports partial and missing", () => {
    expect(inspectCommandHooks({}, spec)).toBe("missing");
    const doc: Record<string, unknown> = {};
    mergeCommandHooks(doc, spec);
    delete (doc["hooks"] as Record<string, unknown>)["SessionEnd"];
    expect(inspectCommandHooks(doc, spec)).toBe("partial");
    (doc["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)["SessionStart"]![0]!.hooks[0]!["timeout"] = 600;
    expect(inspectCommandHooks(doc, spec)).toBe("partial");
  });

  it("recognizes ours by the `hook <event> --harness <id>` suffix, whatever program precedes it", () => {
    expect(isOurHookCommand('"/usr/bin/node" "/x/jubarteai.js" hook session-start --harness claude-code', "session-start", "claude-code")).toBe(true);
    expect(isOurHookCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\bin\\jubarteai.js" hook session-end --harness codex ', "session-end", "codex")).toBe(true);
    expect(isOurHookCommand("anything hook session-start --harness claude-code", "session-start", "claude-code")).toBe(true);
    expect(isOurHookCommand("hook session-start --harness claude-code", "session-start", "claude-code")).toBe(false);
    expect(isOurHookCommand("x hook session-start --harness claude-code-extra", "session-start", "claude-code")).toBe(false);
    expect(isOurHookCommand("x hook session-start --harness codex", "session-start", "claude-code")).toBe(false);
    expect(isOurHookCommand("x hook session-end --harness claude-code", "session-start", "claude-code")).toBe(false);
    expect(isOurHookCommand("x hook session-start --harness claude-code && rm -rf ~", "session-start", "claude-code")).toBe(false);

    const doc: Record<string, unknown> = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"/old/node" "/old/jubarteai.js" hook session-start --harness claude-code', timeout: 8 }] }] } };
    expect(mergeCommandHooks(doc, spec).changed).toBe(true);
    const groups = (doc["hooks"] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)["SessionStart"];
    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.hooks).toEqual([{ type: "command", command: COMMANDS.SessionStart, timeout: 8 }]);
  });

  it("does not mistake a similarly named command for ours", () => {
    const doc: Record<string, unknown> = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "jubarteai-other hook session-start" }] }] } };
    mergeCommandHooks(doc, spec);
    expect((doc["hooks"] as Record<string, unknown[]>)["SessionStart"]).toHaveLength(2);
  });
});

describe("detect and inspect", () => {
  const detectEnv = (over: Partial<DetectEnv> = {}): DetectEnv => ({ home, env: {}, platform: "linux", which: () => null, ...over });

  it("detects the claude binary or its config directory", async () => {
    expect(await claudeCodeAdapter.detect(detectEnv())).toBe(false);
    expect(await claudeCodeAdapter.detect(detectEnv({ which: (c) => (c === "claude" ? "/usr/bin/claude" : null) }))).toBe(true);
    fs.mkdirSync(path.join(home, ".claude"));
    expect(await claudeCodeAdapter.detect(detectEnv())).toBe(true);
  });

  it("detects CLAUDE_CONFIG_DIR", async () => {
    const dir = path.join(root, "conf");
    fs.mkdirSync(dir);
    expect(await claudeCodeAdapter.detect(detectEnv({ env: { CLAUDE_CONFIG_DIR: dir } }))).toBe(true);
  });

  it("inspect reports missing, then configured, and the MCP entries still there", async () => {
    expect(await claudeCodeAdapter.inspect(ctx())).toEqual({ permission: "missing", hooks: "missing", mcpEntries: [], notes: [] });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { jubarteai: {} } }));
    await applyAll(ctx());
    const state = await claudeCodeAdapter.inspect(ctx());
    expect(state).toMatchObject({ permission: "configured", hooks: "configured", mcpEntries: [path.join(home, ".claude.json")] });
  });

  it("inspect says manual for a settings.json it can't edit, and notes a deny rule", async () => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), "// c\n{}\n");
    expect(await claudeCodeAdapter.inspect(ctx())).toMatchObject({ permission: "manual", hooks: "manual" });
    writeSettings({ permissions: { allow: ["Bash(jubarteai *)"], deny: ["Bash(jubarteai *)"] } });
    expect((await claudeCodeAdapter.inspect(ctx())).notes).toEqual(["a deny rule for jubarteai overrides the allow rule"]);
  });

  it("states what the harness supports", () => {
    expect(claudeCodeAdapter).toMatchObject({ id: "claude-code", skillAgent: "claude-code", sessionVar: "CLAUDE_CODE_SESSION_ID", promptInjection: true });
    expect(claudeCodeAdapter.extras).toBeUndefined();
  });
});
