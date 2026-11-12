import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { readCredentials, removeSeat } from "../auth/credentials.js";
import type { Credentials, StoredSeat } from "../auth/credentials.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { safeForDisplay } from "../output.js";

// `jubarteai logout` (spec section 5.5): deletes one stored seat locally. The key itself stays valid
// until it is revoked in the dashboard; there is no server-side logout (D13).

type Entry = [seatId: string, seat: StoredSeat];

function label(seat: StoredSeat): string {
  return safeForDisplay(seat.company.name !== "" ? seat.company.name : seat.company.slug, 100);
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function notSignedIn(message: string): CliError {
  return new CliError(message, ExitCode.NO_SEAT, "not_signed_in");
}

function pickSeat(credentials: Credentials, workspace: string | undefined, email: string | undefined): Entry {
  let candidates: Entry[] = Object.entries(credentials.seats);
  if (candidates.length === 0) throw notSignedIn("Not signed in, so there is nothing to log out of.");
  const named = workspace !== undefined || email !== undefined;
  if (workspace !== undefined) candidates = candidates.filter(([, seat]) => seat.company.slug === workspace.trim());
  if (email !== undefined) candidates = candidates.filter(([, seat]) => sameEmail(seat.user.email, email));
  if (named) {
    const [first, second] = candidates;
    if (first === undefined) throw notSignedIn("No saved login matches that workspace and email. Run: jubarteai status");
    if (second === undefined) return first;
    const emails = [...new Set(candidates.map(([, seat]) => safeForDisplay(seat.user.email, 100)))].sort();
    throw notSignedIn(
      workspace !== undefined && email === undefined
        ? `Workspace ${safeForDisplay(workspace)} has saved logins for ${emails.join(" and ")}. Add --email <address> to choose one.`
        : "More than one saved login matches. Add --workspace <slug> and --email <address> to choose one.",
    );
  }
  const defaultSeat = credentials.default_seat === null ? undefined : credentials.seats[credentials.default_seat];
  if (credentials.default_seat === null || defaultSeat === undefined) {
    throw notSignedIn("There is no default login. Choose one with --workspace <slug>. Run: jubarteai status");
  }
  return [credentials.default_seat, defaultSeat];
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("logout takes no arguments.");
  const email = typeof args.flags["email"] === "string" ? args.flags["email"] : undefined;
  const [seatId, seat] = pickSeat(readCredentials(), ctx.globals.workspace, email);
  const { removed } = removeSeat(seatId);
  if (!removed) throw notSignedIn("That login was already removed.");
  ctx.stderr.write(`Signed out of ${label(seat)} (${safeForDisplay(seat.user.email, 100)}).\n`);
  ctx.stderr.write("This key still works until you revoke it in Dashboard → API keys.\n");
  return 0;
}

export const logoutCommand: CommandDef = {
  name: "logout",
  summary: "Forget the saved login for this machine (the default, or --workspace)",
  group: "account",
  usage: "logout [--workspace <slug>] [--email <address>]",
  flags: [{ name: "email", type: "string", description: "Pick the login for this address when a workspace has more than one" }],
  run,
};
