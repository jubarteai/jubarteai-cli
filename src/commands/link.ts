import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { readCredentials } from "../auth/credentials.js";
import { convertBinding, writeBinding } from "../binding/binding.js";
import type { BindingWriteResult } from "../binding/binding.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import {
  INIT_COPY,
  linkConverted,
  linkPrevious,
  linkReport,
  noLoginForWorkspace,
} from "../install/init-copy.js";
import { safeForDisplay } from "../output.js";
import { choose, confirm, isInteractive } from "../prompt.js";
import { bindingAt, projectRootOf, seatEntries, seatForBinding, seatForWorkspace, seatLabel } from "./init.js";
import type { SeatEntry } from "./init.js";

// `jubarteai link` (spec sections 3.2 and 5.5): (re)writes this repo's workspace binding for a saved login. The
// form (private or shared) stays as it is unless --share-binding / --private-binding names one; with a flag and no
// --workspace those flags only convert the form of the binding that is already there (D10, D11).

const DISPLAY_MAX = 200;

function notSignedIn(): CliError {
  return new CliError(INIT_COPY.notSignedIn, ExitCode.NO_SEAT, "not_signed_in");
}

function reasonNote(result: BindingWriteResult): string | null {
  if (result.reason === "tracked") return INIT_COPY.bindingKeptSharedTracked;
  if (result.reason === "existing-shared") return INIT_COPY.bindingKeptSharedExisting;
  return null;
}

async function pickSeat(ctx: CommandContext, root: string, tty: boolean): Promise<SeatEntry> {
  const credentials = readCredentials();
  const entries = seatEntries(credentials);
  if (ctx.globals.workspace !== undefined) {
    const named = seatForWorkspace(ctx.globals.workspace, ctx.cwd);
    if (named === null) throw new CliError(noLoginForWorkspace(safeForDisplay(ctx.globals.workspace.trim(), DISPLAY_MAX)), ExitCode.NO_SEAT, "no_seat");
    return named;
  }
  const first = entries[0];
  if (first === undefined) throw notSignedIn();
  const existing = bindingAt(root);
  const current = existing === null ? null : seatForBinding(entries, existing, credentials);
  const fallback = current ?? first;
  if (entries.length === 1 || !tty || ctx.globals.yes) return fallback;
  const defaultIndex = Math.max(0, entries.findIndex((entry) => entry.seatId === fallback.seatId));
  return choose<SeatEntry>(
    INIT_COPY.chooseAccount,
    entries.map((entry) => ({ label: seatLabel(entry.seat), value: entry })),
    { defaultIndex },
  );
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("link takes no arguments. Choose a workspace with --workspace <slug>.");
  const wantsShared = args.flags["share-binding"] === true;
  const wantsPrivate = args.flags["private-binding"] === true;
  if (wantsShared && wantsPrivate) throw new UsageError(INIT_COPY.bindingConflict);
  const form = wantsShared ? true : wantsPrivate ? false : undefined;

  const { root } = projectRootOf(ctx.cwd);
  if (root === null) throw new UsageError(INIT_COPY.linkNeedsProject);
  const existing = bindingAt(root);

  // A form flag alone converts the binding that is there; it needs no login and doesn't touch the workspace.
  if (form !== undefined && ctx.globals.workspace === undefined && existing !== null && existing.email !== null) {
    const converted = convertBinding(root, form);
    ctx.stderr.write(`${converted.changed ? linkConverted(converted.form) : INIT_COPY.bindingUnchanged}\n`);
    const note = reasonNote(converted);
    if (note !== null) ctx.stderr.write(`${note}\n`);
    return ExitCode.OK;
  }

  const tty = isInteractive();
  const { seat } = await pickSeat(ctx, root, tty);
  let shared: boolean;
  if (form !== undefined) shared = form;
  else if (existing !== null) shared = existing.shared;
  else if (tty && !ctx.globals.yes) shared = await confirm(INIT_COPY.shareBindingQuestion, { defaultYes: false });
  else shared = false;

  const written = writeBinding(root, { workspace: { id: seat.company.id, slug: seat.company.slug }, email: seat.user.email, shared });
  const slug = safeForDisplay(seat.company.slug, DISPLAY_MAX);
  ctx.stderr.write(`${linkReport(slug, safeForDisplay(seat.user.email, DISPLAY_MAX), written.form)}\n`);
  if (existing !== null && written.changed) ctx.stderr.write(`${linkPrevious(safeForDisplay(existing.workspace.slug, DISPLAY_MAX), existing.shared ? "shared" : "private")}\n`);
  if (!written.changed) ctx.stderr.write(`${INIT_COPY.bindingUnchanged}\n`);
  const note = reasonNote(written);
  if (note !== null) ctx.stderr.write(`${note}\n`);
  return ExitCode.OK;
}

export const linkCommand: CommandDef = {
  name: "link",
  summary: "Bind this repo to a saved login's workspace, or switch the binding between private and shared",
  group: "setup",
  usage: "link [--workspace <slug>] [--share-binding | --private-binding]",
  flags: [
    { name: "share-binding", type: "boolean", description: "Commit the binding for everyone who clones the repo; on its own, only converts the current binding" },
    { name: "private-binding", type: "boolean", description: "Keep the binding private to you; on its own, only converts the current binding" },
  ],
  run,
};
