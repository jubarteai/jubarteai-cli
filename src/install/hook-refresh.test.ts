// planHookRefresh: only hook files that already hold our entries with another program become steps; nothing is added.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter, HOOK_EVENTS } from "../harness/claude-code.js";
import { CODEX_CODES, codexAdapter } from "../harness/codex.js";
import { copilotCliAdapter } from "../harness/copilot-cli.js";
import { vscodeAdapter } from "../harness/vscode.js";
import type { InitCtx } from "../harness/types.js";
import { applyPlan } from "../safe-edit/plan.js";
import { planHookRefresh } from "./hook-refresh.js";
import { applyUi } from "../../test/helpers/apply-ui.js";

const OLD = '"/old/node" "/old/bin/jubarteai.js"';
const NEW = '"/new/node" "/new/bin/jubarteai.js"';

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-hookrefresh-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function ctx(hookCommand: string): InitCtx {
  return { home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai", hookCommand };
}

function writeHooks(file: string, program: string, harness: string, events: ReadonlyArray<{ name: string; arg: string; timeout: number }>): void {
  const hooks: Record<string, unknown> = {};
  for (const e of events) hooks[e.name] = [{ hooks: [{ type: "command", command: `${program} hook ${e.arg} --harness ${harness}`, timeout: e.timeout }] }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
}

describe("planHookRefresh", () => {
  it("makes a sensitive step with a preview for stale hooks, and none once they carry the wanted command", async () => {
    const file = path.join(home, ".claude", "settings.json");
    writeHooks(file, OLD, "claude-code", HOOK_EVENTS);
    const plan = await planHookRefresh([claudeCodeAdapter], ctx(NEW));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ sensitive: true, files: [file] });
    expect(plan.steps[0]?.preview).toContain(NEW.replaceAll('"', '\\"'));

    const results = await applyPlan(plan.steps, { tty: false, yes: true, agentSession: null, ...applyUi() });
    expect(results.map((r) => r.status)).toEqual(["configured"]);
    expect(fs.readFileSync(file, "utf8")).toContain(NEW.replaceAll('"', '\\"'));
    expect(fs.readFileSync(file, "utf8")).not.toContain("/old/node");
    expect((await planHookRefresh([claudeCodeAdapter], ctx(NEW))).steps).toEqual([]);
  });

  it("reports an adapter with only some events as incomplete and plans nothing for it", async () => {
    writeHooks(path.join(home, ".claude", "settings.json"), OLD, "claude-code", HOOK_EVENTS.slice(0, 1));
    const plan = await planHookRefresh([claudeCodeAdapter], ctx(NEW));
    expect(plan.steps).toEqual([]);
    expect(plan.incomplete.map((a) => a.id)).toEqual(["claude-code"]);
  });

  it("plans nothing where no hook of ours exists", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    expect(await planHookRefresh([claudeCodeAdapter], ctx(NEW))).toEqual({ steps: [], manuals: [], incomplete: [] });
  });

  it("for Codex also prints the trust instruction, since Codex runs a changed hook only after it is trusted", async () => {
    const events = [
      { name: "SessionStart", arg: "session-start", timeout: 10 },
      { name: "UserPromptSubmit", arg: "user-prompt-submit", timeout: 10 },
      { name: "SessionEnd", arg: "session-end", timeout: 5 },
    ];
    writeHooks(path.join(home, ".codex", "hooks.json"), OLD, "codex", events);
    const plan = await planHookRefresh([codexAdapter], ctx(NEW));
    // The timeouts above may not equal Codex's; either way the entries are ours and complete, so a step exists.
    expect(plan.steps).toHaveLength(1);
    expect(plan.manuals.map((m) => m.code)).toEqual([CODEX_CODES.trustHooks]);
  });

  describe("the shared Copilot file (VS Code and Copilot CLI)", () => {
    const copilotFile = (): string => path.join(home, ".copilot", "hooks", "jubarteai.json");
    const guard = (program: string): Record<string, unknown> => ({
      type: "command",
      matcher: "bash|powershell",
      bash: `${program} hook pre-tool-use --harness vscode || true`,
      powershell: `try { & ${program === "jubarteai" ? "jubarteai.cmd" : program} hook pre-tool-use --harness vscode } catch { }; exit 0`,
      timeoutSec: 8,
    });
    const sessionOnly = (program: string): string =>
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", command: `${program} hook session-start --harness vscode`, timeoutSec: 8 }],
          sessionEnd: [{ type: "command", command: `${program} hook session-end --harness vscode`, timeoutSec: 3 }],
        },
      });
    const write = (text: string): void => {
      fs.mkdirSync(path.dirname(copilotFile()), { recursive: true });
      fs.writeFileSync(copilotFile(), text);
    };
    const apply = (steps: Parameters<typeof applyPlan>[0]) => applyPlan(steps, { tty: false, yes: true, agentSession: null, ...applyUi() });

    it("adds the missing guard to a file whose session hooks are current: one step, labelled as adding the guard (review R-S16)", async () => {
      write(sessionOnly("jubarteai"));
      const plan = await planHookRefresh([vscodeAdapter, copilotCliAdapter], ctx("jubarteai"));
      expect(plan.incomplete).toEqual([]);
      expect(plan.steps).toHaveLength(1);
      const step = plan.steps[0];
      expect(step).toMatchObject({ sensitive: true, files: [copilotFile()] });
      expect(step?.preview).toContain("hooks.preToolUse: jubarteai hook pre-tool-use --harness vscode");
      // The file comes right after "guard to", so the commands listed after it can't read as "update to <file>" (review R-N19).
      expect(step?.label).toBe(`Add the preToolUse guard to ${copilotFile()} (denies an agent's login, logout, link, init and update)`);

      const results = await apply(plan.steps);
      expect(results.map((r) => r.status)).toEqual(["configured"]);
      expect(results[0]?.label).toContain("Add the preToolUse guard");
      const hooks = (JSON.parse(fs.readFileSync(copilotFile(), "utf8")) as { hooks: Record<string, unknown> }).hooks;
      expect(hooks["preToolUse"]).toEqual([guard("jubarteai")]);
      expect((await planHookRefresh([vscodeAdapter, copilotCliAdapter], ctx("jubarteai"))).steps).toEqual([]);
    });

    it("a stale program and a missing guard: one refresh step that rewrites the program and adds the guard", async () => {
      write(sessionOnly(OLD));
      const plan = await planHookRefresh([vscodeAdapter, copilotCliAdapter], ctx(NEW));
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.label).toContain("Refresh the hook command");
      await apply(plan.steps);
      const text = fs.readFileSync(copilotFile(), "utf8");
      expect(text).not.toContain("/old/node");
      expect((JSON.parse(text) as { hooks: Record<string, unknown> }).hooks["preToolUse"]).toEqual([guard(NEW)]);
    });
  });
});
