// `jubarteai uninstall`: takes back what `init` wrote, behind one checklist like init's. Hooks and permission rules of every
// harness, Codex's MCP table and network opt-in, the AGENTS.md section and CLAUDE.md import, the repo binding, the skill,
// and the saved logins on this machine. It never removes the program itself: it prints the npm command for that.
//
// Signing out is local (D13): there is no server-side revoke, so the key keeps working until it is revoked in the
// dashboard, and the command says so. Because it removes the saved logins of every repo on the machine, that row is
// labelled as such and can be unchecked; `--keep-login` leaves the logins out of the plan.
import { basename, resolve } from "node:path";

import { refuseInAgentSession } from "../agent-session.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { suggest } from "../cli/suggest.js";
import { readCredentials, removeSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { bindingIsTracked, bindingRootFor, hasBindingFiles, mainCheckoutBinding, mainCheckoutRoot, removeBinding } from "../binding/binding.js";
import { CLI_NAME } from "../constants.js";
import { ExitCode, UsageError } from "../errors.js";
import { defaultDetectEnv } from "../harness/detect.js";
import { HARNESS_LABELS } from "../harness/labels.js";
import { mcpCleanupFor } from "../harness/mcp-cleanup.js";
import type { CleanupHarness } from "../harness/mcp-cleanup.js";
import { ADAPTERS } from "../harness/registry.js";
import type { CleanupScope, InitCtx, ManualInstructions } from "../harness/types.js";
import { planInstructionRemoval } from "../install/agents-md.js";
import { cliCommandInfo } from "../install/cli-command.js";
import { planSkillRemoval } from "../install/skill.js";
import { safeForDisplay } from "../output.js";
import { homeDir } from "../paths.js";
import { isInteractive } from "../prompt.js";
import { DECLINED, MACHINE_GROUP, applyPlan, repoGroup } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { HARNESS_IDS } from "../session/harness-env.js";
import type { HarnessId } from "../session/harness-env.js";
import { displayPath } from "../ui/display.js";
import { createUi } from "../ui/index.js";
import { projectRootOf } from "./init.js";

const DISPLAY_MAX = 200;
const CLEANUP_HARNESSES: readonly CleanupHarness[] = ["claude-code", "codex", "cursor", "vscode", "windsurf", "zed"];

export const UNINSTALL_COPY = {
  title: "JubarteAI uninstaller",
  checklistTitle: "Choose what to remove",
  nothing: "Nothing of JubarteAI's was found here to remove.",
  signOutLabel: "Sign out of every saved login on this machine (affects every repo)",
  stillWorks: "This key still works until you revoke it in Dashboard → API keys.",
  removeProgram: `To remove the CLI itself, run: npm uninstall -g ${CLI_NAME}`,
  restart: "Restart your editor or agent so it stops loading the hooks.",
} as const;

function isManual(item: PlanStep | ManualInstructions): item is ManualInstructions {
  return "kind" in item && item.kind === "manual";
}

function seatLabel(seat: StoredSeat): string {
  return `${safeForDisplay(seat.user.email, DISPLAY_MAX)} — ${safeForDisplay(seat.company.name !== "" ? seat.company.name : seat.company.slug, DISPLAY_MAX)}`;
}

/** The step that removes the binding: a committed (git-tracked) one is left for a commit. */
function bindingRemoval(root: string): PlanStep | ManualInstructions | null {
  if (!hasBindingFiles(root)) return null;
  if (bindingIsTracked(root)) {
    return {
      kind: "manual",
      harness: "claude-code",
      title: "The workspace binding is committed",
      lines: [`.jubarteai/config.json is tracked by git in ${root}: remove the folder in a commit (git rm -r .jubarteai).`],
      reason: "a committed binding is removed in a commit, not by the CLI",
    };
  }
  const id = "uninstall-binding";
  const label = "Remove the workspace binding from this repo";
  return {
    id,
    label,
    group: repoGroup(root),
    files: [`${root}/.jubarteai`, `${root}/.gitignore`],
    sensitive: true,
    preview: `${root}/.jubarteai: delete config.json and config.local.json, and the private-binding lines init added to .gitignore`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      try {
        const { changed } = removeBinding(root);
        return changed ? { id, label, status: "configured", detail: "removed" } : { id, label, status: "already configured", detail: "nothing to remove" };
      } catch {
        return { id, label, status: "failed", detail: "could not update the binding files" };
      }
    },
  };
}

/** The step that signs out of every saved login (local only: the keys keep working until revoked). */
function signOutStep(seats: Array<[string, StoredSeat]>): PlanStep {
  const id = "uninstall-signout";
  const label = UNINSTALL_COPY.signOutLabel;
  return {
    id,
    label,
    group: MACHINE_GROUP,
    files: [],
    sensitive: true,
    preview: ["Saved logins removed from this machine (the keys are not revoked):", ...seats.map(([, seat]) => `  ${seatLabel(seat)}`)].join("\n"),
    flag: "--yes",
    async apply(): Promise<StepResult> {
      let removed = 0;
      for (const [seatId] of seats) if (removeSeat(seatId).removed) removed += 1;
      return { id, label, status: removed > 0 ? "configured" : "already configured", detail: `signed out of ${removed} login${removed === 1 ? "" : "s"}` };
    },
  };
}

/** The saved logins, none when the store can't be read (the sign-out row is then not offered). */
function savedSeats(): Array<[string, StoredSeat]> {
  try {
    return Object.entries(readCredentials().seats);
  } catch {
    return [];
  }
}

function skippedHarnesses(raw: unknown): Set<HarnessId> {
  const out = new Set<HarnessId>();
  if (!Array.isArray(raw)) return out;
  for (const value of raw) {
    const wanted = typeof value === "string" ? value.trim().toLowerCase() : "";
    const known = HARNESS_IDS.find((id) => id === wanted);
    if (known === undefined) {
      const near = suggest(wanted, HARNESS_IDS);
      throw new UsageError(`Unknown harness "${safeForDisplay(String(value))}".${near === null ? "" : ` Did you mean "${near}"?`} Known: ${HARNESS_IDS.join(", ")}.`);
    }
    out.add(known);
  }
  return out;
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("uninstall takes no arguments.");
  // It removes the saved logins and what the hooks rely on: a person decides that, never an agent (invariant I6).
  refuseInAgentSession("uninstall");
  const flag = (name: string): boolean => args.flags[name] === true;
  const skip = skippedHarnesses(args.flags["skip-harness"]);
  const yes = ctx.globals.yes;
  const tty = isInteractive();

  const ui = createUi(ctx.stderr, { ...(ctx.globals.plain === true ? { plain: true } : {}), ...(ctx.globals.verbose === true ? { verbose: true } : {}) });
  const timeline = ui.timeline();
  const started = Date.now();
  ui.banner("uninstaller");
  timeline.open(UNINSTALL_COPY.title);

  const home = homeDir();
  const { root } = projectRootOf(ctx.cwd);
  if (root !== null) timeline.header("Project", `${safeForDisplay(basename(root).toLowerCase(), DISPLAY_MAX)}  ${displayPath(root, { home })}`);
  else timeline.header("Project", "not in a project folder: global steps only", { warn: true });

  const env = defaultDetectEnv();
  const cli = cliCommandInfo();
  const ictx: InitCtx = { ...env, projectRoot: root, cliCommand: CLI_NAME, hookCommand: cli.command, yes, tty };
  const scope: CleanupScope = { home, projectRoot: root, platform: env.platform, startDir: ctx.cwd, env: env.env };

  const items: Array<PlanStep | ManualInstructions> = [];
  const failed: StepResult[] = [];
  const guarded = async (id: string, label: string, work: () => Promise<Array<PlanStep | ManualInstructions>>): Promise<void> => {
    try {
      items.push(...(await work()));
    } catch {
      failed.push({ id, label, status: "failed", detail: "could not read its config files" });
    }
  };

  await ui.spin("Looking at your setup", async () => {
    for (const adapter of ADAPTERS.filter((a) => !skip.has(a.id))) {
      await guarded(`${adapter.id}:uninstall`, `${HARNESS_LABELS[adapter.id]} setup`, () => adapter.uninstall(ictx));
      // Every harness's leftover MCP entries go too, with no Codex gate: the user is removing JubarteAI altogether.
      if ((CLEANUP_HARNESSES as readonly string[]).includes(adapter.id)) {
        await guarded(`mcp-cleanup:${adapter.id}`, `${HARNESS_LABELS[adapter.id]} MCP cleanup`, () => mcpCleanupFor(adapter.id as CleanupHarness, scope));
      }
    }
    if (root !== null) {
      await guarded("uninstall-instructions", "AGENTS.md section", async () => planInstructionRemoval(root));
      const bound = bindingRootFor(root);
      await guarded("uninstall-binding", "workspace binding", async () => {
        const step = bindingRemoval(bound);
        if (step === null) return [];
        // A linked worktree with its own binding: once it goes, the worktree reads the main checkout's. Say so, and where it is.
        // That note is only advice: a main-checkout binding that can't be read must not cost this worktree its own removal row.
        let mainRoot = mainCheckoutRoot(bound);
        if (mainRoot === null) return [step];
        try {
          mainRoot = mainCheckoutBinding(bound)?.root ?? null;
        } catch {
          // Unreadable or invalid: the file is still there, so the same advice holds; the doctor names the problem.
        }
        if (mainRoot === null || resolve(mainRoot) === resolve(bound)) return [step];
        const note: ManualInstructions = {
          kind: "manual",
          harness: "claude-code",
          title: "The main checkout keeps its own binding",
          lines: [`${mainRoot}/.jubarteai still binds this repo, so every worktree of it without a binding of its own, this one included once its binding is gone, reads that one. To remove it too, run: jubarteai uninstall in ${mainRoot}.`],
          reason: "removing a worktree's binding leaves the main checkout's in force",
        };
        return [step, note];
      });
    }
    await guarded("uninstall-skill", "skill", () => planSkillRemoval({ root, cwd: ctx.cwd }));
  });

  const steps = items.filter((item): item is PlanStep => !isManual(item));
  const manuals = items.filter(isManual).filter((m, i, all) => all.findIndex((o) => o.title === m.title && o.lines.join("\n") === m.lines.join("\n")) === i);
  const seats = savedSeats();
  const signOut = !flag("keep-login") && seats.length > 0 ? signOutStep(seats) : null;
  if (signOut !== null) steps.push(signOut);

  if (steps.length === 0 && manuals.length === 0 && failed.length === 0) {
    timeline.note([UNINSTALL_COPY.nothing, UNINSTALL_COPY.removeProgram]);
    timeline.close({ ok: 0, skipped: 0, failed: 0 }, Date.now() - started);
    return ExitCode.OK;
  }

  const applied = await applyPlan(steps, {
    tty,
    yes,
    ui,
    timeline,
    approval: "checklist",
    title: UNINSTALL_COPY.checklistTitle,
    showChanges: flag("show-changes"),
  });
  if (applied.length > 0 && applied.every((r) => r.status === "skipped" && r.detail === DECLINED)) return ExitCode.OK;
  for (const result of failed) timeline.result(result, "");

  const results = [...applied, ...failed];
  const lines: string[] = [];
  const signedOut = applied.find((r) => r.id === "uninstall-signout");
  if (signedOut?.status === "configured") {
    for (const [, seat] of seats) lines.push(`${seatLabel(seat)}: ${UNINSTALL_COPY.stillWorks}`);
  }
  if (manuals.length > 0) {
    lines.push("", "Do these by hand:");
    for (const item of manuals) {
      lines.push(`  ${safeForDisplay(item.title, DISPLAY_MAX)}`);
      for (const line of item.lines) lines.push(`    ${safeForDisplay(line, 400)}`);
    }
  }
  if (results.some((r) => r.status === "configured" && /hooks|permission/.test(r.id))) lines.push("", UNINSTALL_COPY.restart);
  lines.push("", UNINSTALL_COPY.removeProgram);
  timeline.note(lines);

  const counts = { ok: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    if (result.status === "failed") counts.failed += 1;
    else if (result.status === "skipped") counts.skipped += 1;
    else counts.ok += 1;
  }
  timeline.close(counts, Date.now() - started);
  return counts.failed > 0 ? ExitCode.SERVER_ERROR : ExitCode.OK;
}

export const uninstallCommand: CommandDef = {
  name: "uninstall",
  summary: "Remove what init set up (hooks, permission rules, AGENTS.md section, binding, skill, saved logins); prints the npm command for the program itself",
  group: "setup",
  usage: "uninstall [--keep-login] [--skip-harness <id>]... [--show-changes] [--yes]",
  flags: [
    { name: "keep-login", type: "boolean", description: "Leave the saved logins on this machine" },
    { name: "skip-harness", type: "string[]", description: "Leave a harness out (repeat for several)" },
    { name: "show-changes", type: "boolean", description: "Print the exact entries to be removed before asking" },
  ],
  run,
};
