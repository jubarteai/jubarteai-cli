// `jubarteai update` and the hooks `init` wrote (spec §6.3): a hook's command line starts with the absolute Node and bin
// paths of the install that ran `init`. After a Node upgrade (or a move of the install) those paths are gone and every
// registered hook exits 127, in every session, until the entries are rewritten. `update` is the maintenance path, so it
// rewrites the program part of the hook entries that are already ours, in place, to the running install's command.
//
// It reuses each adapter's own hooks() step rather than merging JSON itself: that step updates an entry of ours whose
// program, timeout or duplicates differ (mergeCommandHooks and its siblings), and it is sensitive with the exact entries
// as its preview, like init's. What this module adds is the restriction: only an adapter whose hooks are present but
// stale is touched. An adapter with no hooks of ours, or with only some of the events registered, is init's to
// finish (update adds no session entries), and an adapter that can only print instructions gets the `init` hint instead.
// One exception: the shared Copilot file's step writes its entries as a set, so refreshing it also adds the deny-only
// preToolUse guard when it is missing (a file from before the guard), even when the session hooks are current; the step
// stays sensitive, previews it, and is labelled as adding the guard when that is all it changes.
import { ownHookEvents, ownHookRegistered } from "../hooks/events.js";
import { PERSON_COMMAND_LIST } from "../harness/agent-commands.js";
import { CODEX_CODES } from "../harness/codex.js";
import { COPILOT_HOOKS_STEP_ID, copilotRefreshAddsGuardOnly } from "../harness/vscode.js";
import type { HarnessAdapter, InitCtx, ManualInstructions } from "../harness/types.js";
import type { PlanStep } from "../safe-edit/plan.js";

export const HOOK_REFRESH_COPY = {
  incomplete: "some of the session hooks are missing; run jubarteai init to add them",
} as const;

export type HookRefreshPlan = {
  /**
   * One sensitive step per hook file whose entries are ours and differ from what init writes (another program, timeout
   * or duplicates), or, for the shared Copilot file, lack the preToolUse guard.
   */
  steps: PlanStep[];
  /** Instructions for what update does not write (a file it won't rewrite, Codex's trust prompt). */
  manuals: ManualInstructions[];
  /** Adapters with hooks of ours but not every event: init completes them. */
  incomplete: HarnessAdapter[];
};

/** Whether every event `init` registers for this adapter is registered in its hook file (read-only). */
function hasEveryEvent(adapter: HarnessAdapter, ctx: InitCtx): boolean {
  const events = ownHookEvents(adapter.id);
  return events.length > 0 && events.every((event) => ownHookRegistered(adapter.id, event, ctx.home, ctx.env));
}

/**
 * The hook files that hold our entries with a program other than `ctx.hookCommand`, as steps; reads only.
 * `ctx.hookCommand` must be the running install's command (cliCommandInfo), never the bare name of an npx copy.
 */
export async function planHookRefresh(adapters: HarnessAdapter[], ctx: InitCtx): Promise<HookRefreshPlan> {
  const plan: HookRefreshPlan = { steps: [], manuals: [], incomplete: [] };
  const seenFiles = new Set<string>();
  for (const adapter of adapters) {
    if (ownHookEvents(adapter.id).length === 0) continue;
    let state: string;
    try {
      state = (await adapter.inspect(ctx)).hooks;
    } catch {
      continue;
    }
    // "configured": exactly the wanted command. "missing": nothing of ours to refresh. "manual"/"n/a": nothing update can read.
    if (state !== "partial") continue;
    if (!hasEveryEvent(adapter, ctx)) {
      plan.incomplete.push(adapter);
      continue;
    }
    const result = await adapter.hooks(ctx);
    if (result === null) continue;
    if (!Array.isArray(result)) {
      plan.manuals.push(result);
      continue;
    }
    for (const step of result) {
      // A non-sensitive step is one with nothing to write; a file two adapters share (VS Code and Copilot CLI) is one step.
      const key = step.files.join("\n");
      if (!step.sensitive || seenFiles.has(key)) continue;
      seenFiles.add(key);
      const label =
        step.id === COPILOT_HOOKS_STEP_ID && copilotRefreshAddsGuardOnly(ctx)
          ? `Add the preToolUse guard that denies an agent's ${PERSON_COMMAND_LIST} to ${step.files.join(", ")}`
          : `Refresh the hook command in ${adapter.label} (${step.files.join(", ")})`;
      plan.steps.push({
        ...step,
        label,
        async apply() {
          const done = await step.apply();
          return { ...done, label };
        },
      });
      if (adapter.id === "codex" && adapter.extras !== undefined) {
        // Codex runs a changed hook only after it is trusted once; init prints that line, so update does too.
        const extras = await adapter.extras(ctx);
        plan.manuals.push(...extras.filter((i): i is ManualInstructions => "kind" in i && i.kind === "manual" && i.code === CODEX_CODES.trustHooks));
      }
    }
  }
  return plan;
}
