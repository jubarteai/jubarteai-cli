// `jubarteai skills <sync|status|clean>`: company skills in this repository.
//
//   sync    writes the workspace's enabled skills into the repo's skill folders (.claude/skills, .agents/skills, and
//           any other harness folder `init` set up), removes the ones no longer enabled, and adds a managed block
//           to .git/info/exclude. The hooks start the same sync in the background when the workspace's skill set
//           changed; run it by hand for harnesses without hooks.
//   status  offline: what is synced here and what is in the way.
//   clean   removes every folder this CLI synced (and only those), the exclude block and the local sync state.
import { join } from "node:path";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { ExitCode, UsageError } from "../errors.js";
import { findBinding } from "../binding/binding.js";
import { gitTop } from "../git/layout.js";
import { writeJson } from "../output.js";
import { isInteractive, confirm } from "../prompt.js";
import { skippedTargetsNotice } from "../skills/notice.js";
import { runSync } from "../skills/sync.js";
import type { SyncResult } from "../skills/sync.js";
import { writeExcludeBlock } from "../skills/exclude.js";
import { deleteState, inBackoff, readState } from "../skills/state.js";
import { skippedTargets, syncTargets } from "../skills/targets.js";
import { listManaged, listUnmanaged, removeManaged } from "../skills/writer.js";
import { agentFor, seatFor } from "./tool.js";

const NOT_BOUND = "This folder isn't in a repository bound to a workspace. Run: jubarteai link";
const SUBCOMMANDS = ["sync", "status", "clean"] as const;

function bound(ctx: CommandContext): { top: string; workspaceId: string } {
  let binding;
  try {
    binding = findBinding(ctx.cwd);
  } catch {
    binding = null;
  }
  if (binding === null) throw new UsageError(NOT_BOUND);
  return { top: gitTop(ctx.cwd) ?? binding.inheritedFrom ?? binding.root, workspaceId: binding.workspace.id };
}

const skippedNote = skippedTargetsNotice;

function summary(result: SyncResult, skipped: readonly string[]) {
  return {
    status: result.status,
    skills: result.skills,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    clashes: result.clashes,
    revision: result.revision,
    ...(skipped.length > 0 ? { skipped_targets: skipped } : {}),
    ...(result.createdFolder ? { notice: "New company skills folder created — start a new session (or /reload-skills in Claude Code) to load them." } : {}),
  };
}

async function runSkillsSync(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const { top, workspaceId } = bound(ctx);
  const seat = seatFor(ctx);
  const agentId = agentFor(ctx, seat, undefined, { required: true }) as string;
  const background = args.flags["background"] === true;
  const ifChanged = typeof args.flags["if-changed"] === "number" ? (args.flags["if-changed"] as number) : undefined;
  const result = await runSync({ seat, agentId, top, workspaceId, background, ...(ifChanged === undefined ? {} : { ifChanged }) });
  const skipped = skippedTargets(top);
  if (!background && skipped.length > 0) ctx.stderr.write(`${skippedNote(skipped)}\n`);
  if (!(background || args.flags["quiet"] === true)) writeJson(ctx.stdout, { messages: [], result: summary(result, skipped) }, { pretty: ctx.globals.pretty });
  if (result.status === "failed") {
    if (!background) ctx.stderr.write("Company skills couldn't be synced right now. Nothing was removed; try again later.\n");
    return ExitCode.NETWORK;
  }
  return ExitCode.OK;
}

function runSkillsStatus(ctx: CommandContext): number {
  const { top } = bound(ctx);
  const targets = syncTargets(top);
  const seatOrigin = (() => {
    try {
      return seatFor(ctx).origin;
    } catch {
      return "";
    }
  })();
  const state = readState(top, seatOrigin);
  const managed = targets.flatMap((target) =>
    [...listManaged(join(top, target))].map(([name, marker]) => ({ name, target, revision_id: marker.revision_id, digest: marker.digest })),
  );
  const unmanaged = targets.flatMap((target) => listUnmanaged(join(top, target)).map((name) => ({ name, target })));
  const clashes = Object.keys(state.clashes).map((name) => ({ name, dir: state.clashes[name]?.dir ?? null }));
  writeJson(
    ctx.stdout,
    {
      messages: [],
      result: {
        top,
        targets,
        skipped_targets: skippedTargets(top).map((target) => ({ target, reason: "symlink" })),
        managed,
        in_the_way: clashes,
        unmanaged_folders: unmanaged,
        revision: state.revision,
        synced_at: state.synced_at === null ? null : new Date(state.synced_at).toISOString(),
        retry_held_off: inBackoff(state, Date.now()),
      },
    },
    { pretty: ctx.globals.pretty },
  );
  return ExitCode.OK;
}

async function runSkillsClean(ctx: CommandContext): Promise<number> {
  const { top } = bound(ctx);
  const targets = syncTargets(top);
  const found = targets.flatMap((target) => [...listManaged(join(top, target)).keys()].map((name) => ({ name, target })));
  if (found.length === 0) {
    deleteState(top);
    writeExcludeBlock(top, []);
    writeJson(ctx.stdout, { messages: [], result: { removed: [] } }, { pretty: ctx.globals.pretty });
    return ExitCode.OK;
  }
  if (!ctx.globals.yes) {
    if (!isInteractive()) throw new UsageError(`${found.length} synced company skill folder(s) would be removed. Pass --yes to remove them.`);
    if (!(await confirm(`Remove ${found.length} synced company skill folder(s) from this repo?`, { defaultYes: false }))) return ExitCode.OK;
  }
  const removed: string[] = [];
  for (const { name, target } of found) if (removeManaged(join(top, target), name)) removed.push(`${target}/${name}`);
  writeExcludeBlock(top, []);
  deleteState(top);
  writeJson(ctx.stdout, { messages: [], result: { removed } }, { pretty: ctx.globals.pretty });
  return ExitCode.OK;
}

export const skillsCommand: CommandDef = {
  name: "skills",
  summary: "Sync the workspace's company skills into this repo (sync | status | clean)",
  group: "setup",
  usage: "skills <sync|status|clean> [options]",
  flags: [
    { name: "background", type: "boolean", description: "Run quietly for a hook: no output, results are left for the next prompt", hidden: true },
    { name: "if-changed", type: "number", description: "Skip when this skills_revision is already synced", hidden: true },
    { name: "quiet", type: "boolean", description: "Print nothing on success" },
  ],
  async run(ctx, args) {
    const [sub, ...rest] = args.positionals;
    if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub) || rest.length > 0) {
      throw new UsageError(`Usage: jubarteai skills <${SUBCOMMANDS.join("|")}>`);
    }
    if (sub === "sync") return runSkillsSync(ctx, args);
    if (sub === "status") return runSkillsStatus(ctx);
    return runSkillsClean(ctx);
  },
};
