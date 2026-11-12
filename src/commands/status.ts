import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { readCredentialsReport } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import { findBinding } from "../binding/binding.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { safeForDisplay, writeJson } from "../output.js";
import { readSession } from "../session/cache.js";
import { sessionFromEnv } from "../session/harness-env.js";

// `jubarteai status` (spec section 5.5): offline. It reads local files only and never prints a key:
// the credential's token is not copied into the report at all.

const FIELD_LIMIT = 200;

/** A stored or file-supplied value made safe for a terminal (control characters replaced, keys redacted). */
function printable(value: string): string {
  return safeForDisplay(value, FIELD_LIMIT);
}

/**
 * A key's public prefix (`jba_` plus a few characters) for display. safeForDisplay would redact anything
 * shaped like a key, so the fixed `jba_` marker is kept and only the rest is made safe.
 */
function printablePrefix(prefix: string): string {
  return prefix.startsWith("jba_") ? `jba_${printable(prefix.slice(4))}` : printable(prefix);
}

type SeatReport = {
  seat_id: string;
  default: boolean;
  origin: string;
  minted_by: "cli" | "dashboard";
  key: { id: string | null; prefix: string; name: string };
  user: { id: string; email: string };
  company: { id: string; slug: string; name: string };
  saved_at: string;
};

type BindingReport =
  | { found: false }
  | { found: true; dir: string; workspace: { id: string; slug: string }; email: string | null; shared: boolean; inherited_from?: string }
  | { found: false; error: string };

type ResolvedReport =
  | { seat_id: string | null; source: "flag" | "env" | "binding" | "default"; origin: string; user_email: string | null; workspace: string | null }
  | { error: string; exit_code: number };

type SessionReport = {
  harness: string;
  agent_id: string | null;
  name: string | null;
  origin: string | null;
  seat_id: string | null;
  /** True when a cached agent exists but was made for another workspace or origin than this folder resolves to. */
  other_workspace: boolean;
} | null;

type StatusReport = {
  seats: SeatReport[];
  invalid_seats: string[];
  credentials_error: string | null;
  binding: BindingReport;
  resolved: ResolvedReport;
  session: SessionReport;
};

function seatReport(seatId: string, seat: StoredSeat, defaultSeat: string | null): SeatReport {
  // Built field by field: the stored token is deliberately not part of this shape.
  return {
    seat_id: seatId,
    default: seatId === defaultSeat,
    origin: seat.origin,
    minted_by: seat.minted_by,
    key: { id: seat.key.id, prefix: seat.key.prefix, name: seat.key.name },
    user: { id: seat.user.id, email: seat.user.email },
    company: { id: seat.company.id, slug: seat.company.slug, name: seat.company.name },
    saved_at: seat.saved_at,
  };
}

function errorText(error: unknown): string | null {
  return error instanceof CliError ? error.message : null;
}

function bindingReport(cwd: string): BindingReport {
  try {
    const binding = findBinding(cwd);
    if (binding === null) return { found: false };
    return {
      found: true,
      dir: binding.dir,
      workspace: binding.workspace,
      email: binding.email,
      shared: binding.shared,
      ...(binding.inheritedFrom === undefined ? {} : { inherited_from: binding.inheritedFrom }),
    };
  } catch (error) {
    const message = errorText(error);
    if (message === null) throw error;
    return { found: false, error: message };
  }
}

function resolvedReport(ctx: CommandContext): ResolvedReport {
  try {
    const result = resolveSeat({ ...(ctx.globals.workspace === undefined ? {} : { workspace: ctx.globals.workspace }), cwd: ctx.cwd });
    if (isResolveError(result)) return { error: result.error, exit_code: result.exitCode };
    return {
      seat_id: result.seatId,
      source: result.source,
      origin: result.origin,
      user_email: result.seat?.user.email ?? null,
      workspace: result.seat === null ? null : result.seat.company.slug,
    };
  } catch (error) {
    const message = errorText(error);
    if (message === null) throw error;
    return { error: message, exit_code: error instanceof CliError ? error.exitCode : ExitCode.SERVER_ERROR };
  }
}

/** An agent cached for another seat or origin than the one this folder resolves to is not this folder's agent. */
function belongsToResolved(entry: { seat_id: string | null; origin: string }, resolved: ResolvedReport): boolean {
  if ("error" in resolved) return true; // nothing to compare against
  if (entry.origin !== resolved.origin) return false;
  return entry.seat_id === null || resolved.seat_id === null || entry.seat_id === resolved.seat_id;
}

function sessionReport(resolved: ResolvedReport): SessionReport {
  const session = sessionFromEnv();
  if (session === null) return null;
  const entry = readSession(session.harness, session.sessionId);
  if (entry === null) return { harness: session.harness, agent_id: null, name: null, origin: null, seat_id: null, other_workspace: false };
  if (!belongsToResolved(entry, resolved)) {
    return { harness: session.harness, agent_id: null, name: null, origin: null, seat_id: null, other_workspace: true };
  }
  return {
    harness: session.harness,
    agent_id: entry.agent_id,
    name: entry.name ?? null,
    origin: entry.origin,
    seat_id: entry.seat_id,
    other_workspace: false,
  };
}

function collect(ctx: CommandContext): StatusReport {
  let seats: SeatReport[] = [];
  let invalid: string[] = [];
  let credentialsError: string | null = null;
  try {
    const report = readCredentialsReport();
    seats = Object.entries(report.credentials.seats).map(([seatId, seat]) => seatReport(seatId, seat, report.credentials.default_seat));
    invalid = report.invalid_seats;
  } catch (error) {
    credentialsError = errorText(error);
    if (credentialsError === null) throw error;
  }
  const resolved = resolvedReport(ctx);
  return {
    seats,
    invalid_seats: invalid,
    credentials_error: credentialsError,
    binding: bindingReport(ctx.cwd),
    resolved,
    session: sessionReport(resolved),
  };
}

function render(report: StatusReport): string {
  const lines: string[] = [];
  if (report.credentials_error !== null) {
    lines.push(`Saved logins: unreadable. ${printable(report.credentials_error)}`);
  } else if (report.seats.length === 0) {
    lines.push("Saved logins: none. Run: jubarteai login");
  } else {
    lines.push("Saved logins:");
    for (const seat of report.seats) {
      const workspace = seat.company.name !== "" ? seat.company.name : seat.company.slug;
      lines.push(`  ${seat.default ? "*" : " "} ${printable(seat.user.email)} — ${printable(workspace)} (${printable(seat.company.slug)})${seat.default ? "  [default]" : ""}`);
      lines.push(
        `      key: ${printable(seat.key.name)} (${printablePrefix(seat.key.prefix)}), ${seat.minted_by === "cli" ? "browser login" : "pasted dashboard key"}, ${printable(seat.origin)}`,
      );
    }
  }
  if (report.invalid_seats.length > 0) {
    lines.push(`Unreadable entries (skipped): ${report.invalid_seats.map(printable).join(", ")}`);
  }

  const { binding } = report;
  if (binding.found) {
    lines.push(
      `Repo binding: workspace ${printable(binding.workspace.slug)}${binding.email === null ? "" : ` as ${printable(binding.email)}`} (${binding.shared ? "shared" : "private"}, ${printable(binding.dir)})`,
    );
    if (binding.inherited_from !== undefined) {
      lines.push(`  from the main checkout (this worktree, ${printable(binding.inherited_from)}, has none of its own)`);
    }
  } else if ("error" in binding) {
    lines.push(`Repo binding: unreadable. ${printable(binding.error)}`);
  } else {
    lines.push("Repo binding: none for this folder");
  }

  const { resolved } = report;
  if ("error" in resolved) {
    lines.push(`This folder would use: no login. ${printable(resolved.error)}`);
  } else if (resolved.source === "env") {
    lines.push(`This folder would use: the key in JUBARTEAI_TOKEN (not saved), sent to ${printable(resolved.origin)}`);
  } else {
    lines.push(`This folder would use: ${resolved.user_email === null ? "" : `${printable(resolved.user_email)} — `}${resolved.workspace === null ? "" : printable(resolved.workspace)} (from ${resolved.source})`);
  }

  const { session } = report;
  if (session === null) lines.push("Session agent: not in a known agent session");
  else if (session.other_workspace) lines.push("Session agent: belongs to another workspace than this folder uses");
  else if (session.agent_id === null) lines.push(`Session agent: none yet for this ${session.harness} session. Run: jubarteai connect --description "…"`);
  else lines.push(`Session agent: ${session.agent_id}${session.name === null ? "" : ` (${printable(session.name)})`} in ${session.harness}`);
  return `${lines.join("\n")}\n`;
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("status takes no arguments.");
  const report = collect(ctx);
  if (args.flags["json"] === true) writeJson(ctx.stdout, report, { pretty: ctx.globals.pretty });
  else ctx.stdout.write(render(report));
  return report.credentials_error === null ? ExitCode.OK : ExitCode.SERVER_ERROR;
}

export const statusCommand: CommandDef = {
  name: "status",
  summary: "Show saved logins, this folder's workspace binding and the session agent (offline)",
  group: "account",
  usage: "status [--json]",
  flags: [{ name: "json", type: "boolean", description: "Print the report as JSON" }],
  run,
};
