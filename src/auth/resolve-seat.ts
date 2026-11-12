import { CliError, ExitCode } from "../errors.js";
import { findBinding } from "../binding/binding.js";
import type { Binding } from "../binding/binding.js";
import { envOrigin, takeEnvToken } from "../process-env.js";
import { readCredentials } from "./credentials.js";
import type { Credentials, StoredSeat } from "./credentials.js";

export type ResolvedSeat = {
  seatId: string | null;
  origin: string;
  token: string;
  source: "flag" | "env" | "binding" | "default";
  seat: StoredSeat | null;
};

export type ResolveError = { error: string; exitCode: 2 | 5; emails?: string[] };

export function isResolveError(v: ResolvedSeat | ResolveError): v is ResolveError {
  return "error" in v;
}

type Candidate = [seatId: string, seat: StoredSeat];

const NOT_SIGNED_IN = "Not signed in. Run: jubarteai login";

/** Echoes a user-typed value with control characters (terminal escapes) replaced. */
function printable(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }
  return out;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolved(candidate: Candidate, source: "flag" | "binding" | "default"): ResolvedSeat {
  const [seatId, seat] = candidate;
  // I2: a stored key goes only to the origin stored with it; JUBARTEAI_URL never changes it.
  return { seatId, origin: seat.origin, token: seat.token, source, seat };
}

function emailsOf(candidates: Candidate[]): string[] {
  return [...new Set(candidates.map(([, seat]) => seat.user.email))].sort();
}

function ambiguous(slug: string, candidates: Candidate[]): ResolveError {
  const emails = emailsOf(candidates);
  return {
    error:
      `Workspace ${printable(slug)} has saved logins for ${emails.join(" and ")}. ` +
      "Run from a repo bound to one of them, or log in again as the one you want to make the default.",
    exitCode: 5,
    emails,
  };
}

/** Of several seats in one workspace, the one for the default seat's user, if that user is among them. */
function byDefaultUser(credentials: Credentials, candidates: Candidate[]): Candidate | null {
  const defaultId = credentials.default_seat;
  const defaultSeat = defaultId === null ? undefined : credentials.seats[defaultId];
  if (defaultSeat === undefined) return null;
  return candidates.find(([, seat]) => seat.user.id === defaultSeat.user.id) ?? null;
}

function bindingFor(cwd: string): Binding | null | ResolveError {
  try {
    return findBinding(cwd);
  } catch (error) {
    if (error instanceof CliError) return { error: error.message, exitCode: 2 };
    throw error;
  }
}

function isBindingError(v: Binding | null | ResolveError): v is ResolveError {
  return v !== null && "error" in v;
}

function resolveWorkspaceFlag(slug: string, cwd: string): ResolvedSeat | ResolveError {
  const credentials = readCredentials();
  const wanted = slug.trim();
  const candidates = Object.entries(credentials.seats).filter(([, seat]) => seat.company.slug === wanted);
  const [first, second] = candidates;
  if (first === undefined) {
    return {
      error: `No saved login for workspace ${printable(wanted)}. Run: jubarteai login --workspace ${printable(wanted)}`,
      exitCode: 5,
    };
  }
  if (second === undefined) return resolved(first, "flag");

  // Two users in one workspace: the repo's user first, then the default seat's user.
  const binding = bindingFor(cwd);
  if (isBindingError(binding)) return binding;
  if (binding?.email != null) {
    const bindingEmail = binding.email;
    const match = candidates.find(([, seat]) => sameEmail(seat.user.email, bindingEmail));
    if (match !== undefined) return resolved(match, "flag");
  }
  const byDefault = byDefaultUser(credentials, candidates);
  if (byDefault !== null) return resolved(byDefault, "flag");
  return ambiguous(wanted, candidates);
}

function resolveBinding(binding: Binding, credentials: Credentials): ResolvedSeat | ResolveError {
  const inWorkspace = Object.entries(credentials.seats).filter(([, seat]) => seat.company.id === binding.workspace.id);
  const slug = binding.workspace.slug;
  const login = `Run: jubarteai login --workspace ${slug}`;

  if (binding.email !== null) {
    const bindingEmail = binding.email;
    const match = inWorkspace.find(([, seat]) => sameEmail(seat.user.email, bindingEmail));
    if (match !== undefined) return resolved(match, "binding");
    return { error: `This repo uses workspace ${slug} as ${bindingEmail}. ${login}`, exitCode: 5 };
  }

  // A shared binding whose user hasn't been recorded on this machine (no config.local.json).
  const [first, second] = inWorkspace;
  if (first === undefined) return { error: `This repo uses workspace ${slug}. ${login}`, exitCode: 5 };
  if (second === undefined) return resolved(first, "binding");
  const byDefault = byDefaultUser(credentials, inWorkspace);
  return byDefault !== null ? resolved(byDefault, "binding") : ambiguous(slug, inWorkspace);
}

/**
 * Picks the seat for a command that talks to the server (spec §4): `--workspace`, then
 * `JUBARTEAI_TOKEN`, then the nearest binding, then `default_seat`. The environment key is read
 * (and removed from `process.env`) first, whatever wins, so no later child process inherits it.
 */
export function resolveSeat(opts: { workspace?: string; cwd: string }): ResolvedSeat | ResolveError {
  const envToken = takeEnvToken();

  if (opts.workspace !== undefined) return resolveWorkspaceFlag(opts.workspace, opts.cwd);

  if (envToken !== null) {
    return { seatId: null, origin: envOrigin(), token: envToken, source: "env", seat: null };
  }

  const binding = bindingFor(opts.cwd);
  if (isBindingError(binding)) return binding;
  const credentials = readCredentials();
  if (binding !== null) return resolveBinding(binding, credentials);

  const defaultId = credentials.default_seat;
  const defaultSeat = defaultId === null ? undefined : credentials.seats[defaultId];
  if (defaultId === null || defaultSeat === undefined) return { error: NOT_SIGNED_IN, exitCode: ExitCode.NO_SEAT };
  return resolved([defaultId, defaultSeat], "default");
}
