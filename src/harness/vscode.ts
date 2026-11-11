// VS Code (Copilot agent) adapter (spec §9). Verified cells only:
//   - permission: user settings.json `chat.tools.terminal.autoApprove` `{"jubarteai": true}`. VS Code's settings.json is
//     often JSONC; a file with comments is never rewritten, the exact entry is printed instead.
//   - hooks: session start and end only, in ~/.copilot/hooks/jubarteai.json. That one file serves VS Code and Copilot CLI,
//     so the writer is exported (copilotHooksStep) for the Copilot CLI adapter, which runs it under the same step id.
//     There is no per-prompt hook that can add context (`userPromptSubmitted` output is dropped): promptInjection false.
//   - MCP cleanup: the user-profile mcp.json of each VS Code build (and its profiles) and .vscode/mcp.json,
//     `servers.jubarteai`, through mcp-cleanup.ts (C6a).
// Every write goes through editJsonFile (I6), via the shared helpers in cursor.ts.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOOK_REGISTERED_TIMEOUT_S } from "../constants.js";
import type { PlanStep } from "../safe-edit/plan.js";
import type { HarnessId } from "../session/harness-env.js";
import {
  flatHookState,
  hookCommand,
  hookProgram,
  hooksStateOf,
  isObject,
  jsonEditStep,
  cleanupScopeOf,
  manual,
  mergeFlatHook,
  readable,
  type EditOutcome,
  type Obj,
} from "./cursor.js";
import { findMcpEntries, mcpCleanupFor } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "vscode" as const;
const LABEL = "VS Code";
const AUTO_APPROVE_KEY = "chat.tools.terminal.autoApprove";
const COMMAND_RULE = "jubarteai";
/** `timeoutSec` in the shared hook file; session end only needs to be quick. */
const START_TIMEOUT_S = HOOK_REGISTERED_TIMEOUT_S;
const END_TIMEOUT_S = 3;

/** Id of the shared hooks step. The caller (init) runs a step id once, so VS Code and Copilot CLI together write the file once. */
export const COPILOT_HOOKS_STEP_ID = "copilot:hooks";

/**
 * The hint every Copilot hook passes. One entry serves VS Code and Copilot CLI and both send the same camelCase stdin for
 * `sessionStart`/`sessionEnd` (P2 §3.4), so nothing tells them apart; Copilot CLI's adapter reuses this step and so
 * also reports as "vscode". Both take the same `{"additionalContext"}` output, so only the label in connect's description is shared.
 */
const COPILOT_HINT: HarnessId = "vscode";

const EVENTS: ReadonlyArray<{ copilot: string; event: "session-start" | "session-end"; timeoutS: number }> = [
  { copilot: "sessionStart", event: "session-start", timeoutS: START_TIMEOUT_S },
  { copilot: "sessionEnd", event: "session-end", timeoutS: END_TIMEOUT_S },
];

// ---- paths -------------------------------------------------------------------------------------------------------

function userDataBase(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") {
    const appData = env["APPDATA"];
    return appData !== undefined && appData !== "" ? appData : join(home, "AppData", "Roaming");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  return xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config");
}

/** VS Code's user data directories: the stable build's, then Insiders'. */
function userDirs(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const base = userDataBase(home, env, platform);
  return [join(base, "Code", "User"), join(base, "Code - Insiders", "User")];
}

function copilotHome(home: string, env: NodeJS.ProcessEnv): string {
  const custom = env["COPILOT_HOME"];
  return custom !== undefined && custom !== "" && isAbsolute(custom) ? custom : join(home, ".copilot");
}

function copilotHooksFile(ctx: Pick<InitCtx, "home" | "env">): string {
  return join(copilotHome(ctx.home, ctx.env), "hooks", "jubarteai.json");
}

// ---- permission --------------------------------------------------------------------------------------------------

function addAutoApprove(doc: Obj): EditOutcome {
  const current = doc[AUTO_APPROVE_KEY];
  if (current === undefined) {
    doc[AUTO_APPROVE_KEY] = { [COMMAND_RULE]: true };
    return "changed";
  }
  if (!isObject(current)) return { blocked: `${AUTO_APPROVE_KEY} in settings.json is not an object; add the entry by hand` };
  const rule = current[COMMAND_RULE];
  if (rule === true) return "same";
  if (rule !== undefined) return { blocked: `${AUTO_APPROVE_KEY} already has a ${COMMAND_RULE} rule that is not true; left as you set it` };
  current[COMMAND_RULE] = true;
  return "changed";
}

function autoApproveJson(): string[] {
  return JSON.stringify({ [AUTO_APPROVE_KEY]: { [COMMAND_RULE]: true } }, null, 2).split("\n");
}

// ---- shared Copilot hooks (VS Code + Copilot CLI) ----------------------------------------------------------------

function wantedHook(program: string, event: "session-start" | "session-end", timeoutS: number): Obj {
  return { type: "command", command: hookCommand(program, event, COPILOT_HINT), timeoutSec: timeoutS };
}

/** The context the shared hook file is planned with; hooks use `hookCommand ?? cliCommand` (hookProgram). */
type CopilotCtx = Pick<InitCtx, "home" | "env" | "cliCommand" | "hookCommand">;

function addCopilotHooks(doc: Obj, program: string): EditOutcome {
  const hooksValue = doc["hooks"];
  if (hooksValue !== undefined && !isObject(hooksValue)) return { blocked: "hooks in jubarteai.json is not an object; add the entries by hand" };
  const hooks: Obj = hooksValue ?? {};
  for (const { copilot } of EVENTS) {
    if (hooks[copilot] !== undefined && !Array.isArray(hooks[copilot])) return { blocked: `hooks.${copilot} in jubarteai.json is not a list; add the entry by hand` };
  }
  let changed = false;
  for (const { copilot, event, timeoutS } of EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[copilot]) ? hooks[copilot] : [];
    if (!mergeFlatHook(entries, wantedHook(program, event, timeoutS), event, COPILOT_HINT)) continue;
    hooks[copilot] = entries;
    changed = true;
  }
  if (!changed) return "same";
  doc["hooks"] = hooks;
  if (doc["version"] === undefined) doc["version"] = 1;
  return "changed";
}

function copilotHooksJson(program: string): string[] {
  const hooks: Obj = {};
  for (const { copilot, event, timeoutS } of EVENTS) hooks[copilot] = [wantedHook(program, event, timeoutS)];
  return JSON.stringify({ version: 1, hooks }, null, 2).split("\n");
}

/**
 * The one step that writes ~/.copilot/hooks/jubarteai.json (`$COPILOT_HOME/hooks/` when set), `sessionStart` and `sessionEnd`.
 * VS Code and Copilot CLI both return it with the same id (COPILOT_HOOKS_STEP_ID), so the caller runs it once.
 */
export function copilotHooksStep(ctx: CopilotCtx): PlanStep {
  const program = hookProgram(ctx);
  return jsonEditStep({
    id: COPILOT_HOOKS_STEP_ID,
    label: "GitHub Copilot (VS Code and Copilot CLI): session hooks",
    file: copilotHooksFile(ctx),
    preview: EVENTS.map((e) => `  hooks.${e.copilot}: ${hookCommand(program, e.event, COPILOT_HINT)}`).join("\n"),
    createIfMissing: true,
    edit: (doc) => addCopilotHooks(doc, program),
  });
}

/** copilotHooksStep, or the printed entry when the file holds comments or is not plain JSON. `harness` names the adapter asking. */
export function copilotHooksPlan(ctx: CopilotCtx, harness: HarnessId): PlanStep[] | ManualInstructions {
  const file = copilotHooksFile(ctx);
  if (readable(file).status === "unwritable") {
    return manual(
      harness,
      "GitHub Copilot: session hooks",
      [`Open ${file} and add:`, ...copilotHooksJson(hookProgram(ctx)), "(merge it into the existing hooks key)"],
      "jubarteai.json has comments or is not plain JSON, so it is not rewritten",
    );
  }
  return [copilotHooksStep(ctx)];
}

/** Whether the shared hook file holds exactly our two entries (read-only, for doctor). */
export function copilotHooksState(ctx: CopilotCtx): AdapterState["hooks"] {
  const file = readable(copilotHooksFile(ctx));
  if (file.status === "unwritable") return "manual";
  const section = file.status === "ok" ? file.doc["hooks"] : undefined;
  const program = hookProgram(ctx);
  return hooksStateOf(EVENTS.map(({ copilot, event, timeoutS }) => flatHookState(isObject(section) ? section[copilot] : undefined, wantedHook(program, event, timeoutS), event, COPILOT_HINT)));
}

// ---- adapter -----------------------------------------------------------------------------------------------------

export const vscodeAdapter: HarnessAdapter = {
  id: HARNESS,
  label: LABEL,
  skillAgent: "github-copilot",
  // No session variable is documented for VS Code or its Copilot harness.
  sessionVar: null,
  // `userPromptSubmitted` output is dropped, so only session-start injects.
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    if (env.which("code") !== null) return true;
    if (userDirs(env.home, env.env, env.platform).some((dir) => existsSync(dir))) return true;
    return existsSync(copilotHome(env.home, env.env));
  },

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    const dir = userDirs(ctx.home, ctx.env, ctx.platform)[0] ?? "";
    const file = join(dir, "settings.json");
    const hasVsCode = existsSync(dir) || ctx.which("code") !== null;
    // Detected only through ~/.copilot (Copilot CLI): there is no VS Code to configure.
    if (!hasVsCode) return null;
    const printed = (reason: string): ManualInstructions =>
      manual(HARNESS, "VS Code: allow the jubarteai command", [`Open ${file} (Command Palette: Preferences: Open User Settings (JSON)) and add:`, ...autoApproveJson(), "(merge it into the existing setting)"], reason);
    if (!existsSync(dir)) return printed("VS Code's user settings directory was not found");
    if (readable(file).status === "unwritable") return printed("settings.json has comments or is not plain JSON, so it is not rewritten");
    return jsonEditStep({
      id: `${HARNESS}:permission`,
      label: "VS Code: allow the jubarteai command",
      file,
      preview: `  ${AUTO_APPROVE_KEY}: { "${COMMAND_RULE}": true }`,
      createIfMissing: true,
      edit: addAutoApprove,
    });
  },

  async hooks(ctx: InitCtx): Promise<PlanStep[] | ManualInstructions | null> {
    return copilotHooksPlan(ctx, HARNESS);
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const file = join(userDirs(ctx.home, ctx.env, ctx.platform)[0] ?? "", "settings.json");
    const settings = readable(file);
    let permission: AdapterState["permission"] = "missing";
    if (settings.status === "unwritable") permission = "manual";
    else if (settings.status === "ok") {
      const rules = settings.doc[AUTO_APPROVE_KEY];
      if (isObject(rules) && rules[COMMAND_RULE] === true) permission = "configured";
    }
    const notes = ["VS Code has no per-prompt hook that can add context; the per-turn check_inbox stays a duty in the skill"];
    return { permission, hooks: copilotHooksState(ctx), mcpEntries: await findMcpEntries(HARNESS, cleanupScopeOf(ctx)), notes };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },
};
