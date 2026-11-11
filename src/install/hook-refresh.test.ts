// planHookRefresh: only hook files that already hold our entries with another program become steps; nothing is added.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter, HOOK_EVENTS } from "../harness/claude-code.js";
import { CODEX_CODES, codexAdapter } from "../harness/codex.js";
import type { InitCtx } from "../harness/types.js";
import { applyPlan } from "../safe-edit/plan.js";
import { planHookRefresh } from "./hook-refresh.js";

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

    const results = await applyPlan(plan.steps, { tty: false, yes: true, agentSession: null, out: { write: () => true } as unknown as NodeJS.WritableStream });
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
});
