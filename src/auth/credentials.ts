import { chmodSync, closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CREDENTIALS_VERSION } from "../constants.js";
import { CliError, ExitCode } from "../errors.js";
import { isValidOrigin } from "../process-env.js";
import { credentialsPath } from "../paths.js";
import { assertSafeTarget } from "../safe-edit/file-guards.js";
import { SafeEditError, writeFileAtomic } from "../safe-edit/atomic-write.js";

export type StoredSeat = {
  origin: string;
  token: string;
  minted_by: "cli" | "dashboard";
  key: { id: string | null; prefix: string; name: string };
  user: { id: string; email: string };
  company: { id: string; slug: string; name: string };
  saved_at: string;
};

export type Credentials = {
  version: 1;
  default_seat: string | null;
  seats: Record<string, StoredSeat>;
};

const MAX_FILE_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const UNSAFE_REASON_TEXT: Record<string, string> = {
  symlink: "it, or a folder above it, is a symbolic link",
  hardlink: "it has more than one hard link",
  "foreign-owner": "it is not owned by the current user",
  "reparse-point": "it, or a folder above it, is a reparse point",
  "outside-home": "it is outside the home folder",
  missing: "it is missing",
};

function unsafeError(path: string, reason: string): CliError {
  const why = UNSAFE_REASON_TEXT[reason] ?? "it failed a safety check";
  return new CliError(`Refusing to use ${path}: ${why}.`, ExitCode.SERVER_ERROR, "credentials_unsafe");
}

function malformedError(path: string): CliError {
  return new CliError(
    `The credentials file at ${path} is not valid. Fix or delete it, then run: jubarteai login`,
    ExitCode.SERVER_ERROR,
    "credentials_malformed",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

// A token ends up in an Authorization header: printable ASCII, no whitespace.
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** Stored as a bare origin (no path, query or trailing slash): that is what a key is pinned to (spec I2). */
function isCanonicalOrigin(value: string): boolean {
  if (!isValidOrigin(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function validateSeat(value: unknown): StoredSeat | null {
  if (!isRecord(value)) return null;
  const { origin, token, minted_by: mintedBy, key, user, company, saved_at: savedAt } = value;
  if (typeof origin !== "string" || !isCanonicalOrigin(origin)) return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token) || token.length > 512) return null;
  if (mintedBy !== "cli" && mintedBy !== "dashboard") return null;
  if (!isRecord(key) || !isRecord(user) || !isRecord(company)) return null;
  const keyId = key["id"] === null ? null : str(key["id"]);
  const prefix = str(key["prefix"]);
  const keyName = typeof key["name"] === "string" && key["name"].length <= 4096 ? key["name"] : null;
  const userId = str(user["id"]);
  const email = str(user["email"]);
  const companyId = str(company["id"]);
  const slug = str(company["slug"]);
  const companyName = typeof company["name"] === "string" && company["name"].length <= 4096 ? company["name"] : null;
  if (key["id"] !== null && keyId === null) return null;
  if (prefix === null || keyName === null) return null;
  if (userId === null || email === null || companyId === null || slug === null || companyName === null) return null;
  if (typeof savedAt !== "string" || savedAt.length === 0 || savedAt.length > 64) return null;
  return {
    origin,
    token,
    minted_by: mintedBy,
    key: { id: keyId, prefix, name: keyName },
    user: { id: userId, email },
    company: { id: companyId, slug, name: companyName },
    saved_at: savedAt,
  };
}

function emptyCredentials(): Credentials {
  return { version: CREDENTIALS_VERSION, default_seat: null, seats: {} };
}

export type CredentialsReport = {
  credentials: Credentials;
  /** Ids (control characters replaced) of seat entries that could not be read and were left out. */
  invalid_seats: string[];
};

type Store = CredentialsReport & {
  /** The unreadable entries as stored, written back untouched so a save never deletes what it can't read. */
  preserved: Record<string, unknown>;
};

function displayId(id: string): string {
  let out = "";
  for (const char of id.slice(0, 128)) {
    out += hasControlCharacter(char) ? "?" : char;
  }
  return out;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validSeatId(id: string): boolean {
  return id.length > 0 && id.length <= 128;
}

function readStore(): Store {
  const path = credentialsPath();
  const guard = assertSafeTarget(path, { allowMissing: true });
  if (!guard.ok) throw unsafeError(path, guard.reason);

  let raw: string;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw malformedError(path);
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = isRecord(error) ? error["code"] : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { credentials: emptyCredentials(), invalid_seats: [], preserved: {} };
    }
    throw new CliError(`Cannot read the credentials file at ${path}.`, ExitCode.SERVER_ERROR, "credentials_unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // V8's SyntaxError message quotes a snippet of the input, which may hold a token: never forward it.
    throw malformedError(path);
  }
  if (!isRecord(parsed)) throw malformedError(path);
  const version = parsed["version"];
  if (typeof version !== "number") throw malformedError(path);
  if (version !== CREDENTIALS_VERSION) {
    throw new CliError("Upgrade jubarteai to read this credentials file", ExitCode.SERVER_ERROR, "credentials_version");
  }
  const rawSeats = parsed["seats"];
  if (!isRecord(rawSeats)) throw malformedError(path);

  // One bad entry must not lock the user out of the others: it is skipped and reported.
  // Object.fromEntries defines own properties, so a "__proto__" key can't touch the prototype.
  const entries: Array<[string, StoredSeat]> = [];
  const invalid: Array<[string, unknown]> = [];
  for (const [seatId, rawSeat] of Object.entries(rawSeats)) {
    const seat = validSeatId(seatId) ? validateSeat(rawSeat) : null;
    if (seat === null) invalid.push([seatId, rawSeat]);
    else entries.push([seatId, seat]);
  }
  const seats: Record<string, StoredSeat> = Object.fromEntries(entries);

  const rawDefault = parsed["default_seat"];
  if (rawDefault !== undefined && rawDefault !== null && typeof rawDefault !== "string") throw malformedError(path);
  const defaultSeat = typeof rawDefault === "string" && Object.hasOwn(seats, rawDefault) ? rawDefault : null;
  return {
    credentials: { version: CREDENTIALS_VERSION, default_seat: defaultSeat, seats },
    invalid_seats: invalid.map(([id]) => displayId(id)),
    preserved: Object.fromEntries(invalid),
  };
}

/**
 * Reads the credential store, with the ids of any seat entries that were unreadable (skipped, never
 * returned). A missing file is an empty store; bad JSON, a wrong version or a non-object `seats` still
 * fail. Never echoes file content in an error.
 */
export function readCredentialsReport(): CredentialsReport {
  const { credentials, invalid_seats: invalidSeats } = readStore();
  return { credentials, invalid_seats: invalidSeats };
}

/** The readable seats of the credential store (see readCredentialsReport for the skipped ones). */
export function readCredentials(): Credentials {
  return readStore().credentials;
}

function writeCredentials(credentials: Credentials, preserved: Record<string, unknown>): void {
  const path = credentialsPath();
  const document: Record<string, unknown> = { version: CREDENTIALS_VERSION };
  if (credentials.default_seat !== null) document["default_seat"] = credentials.default_seat;
  document["seats"] = Object.fromEntries([...Object.entries(preserved), ...Object.entries(credentials.seats)]);
  try {
    writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: FILE_MODE, dirMode: DIR_MODE });
  } catch (error) {
    if (error instanceof SafeEditError) throw unsafeError(path, error.reason);
    throw new CliError(`Cannot write the credentials file at ${path}.`, ExitCode.SERVER_ERROR, "credentials_unwritable");
  }
  tightenDirectory(dirname(path));
}

/** The folder is ours (guards passed); an older, looser one is tightened to 0700. Best effort, POSIX only. */
function tightenDirectory(dir: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, DIR_MODE);
  } catch {
    // The credential file itself is 0600; a failure here must not fail the save.
  }
}

const LOCK_FILE = "credentials.lock";
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MIN_MS = 5;
const LOCK_POLL_MAX_MS = 80;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockedError(): CliError {
  return new CliError(
    "Another jubarteai process is updating the credentials. Try again in a moment.",
    ExitCode.SERVER_ERROR,
    "credentials_locked",
  );
}

function lockAgeMs(lockPath: string): number {
  try {
    const [, stamp] = readFileSync(lockPath, "utf8").split(" ");
    const written = Number(stamp);
    if (Number.isFinite(written) && written > 0) return Date.now() - written;
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function tryCreateLock(lockPath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
  } catch (error) {
    if (isRecord(error) && error["code"] === "EEXIST") return false;
    throw new CliError(`Cannot lock the credentials file at ${lockPath}.`, ExitCode.SERVER_ERROR, "credentials_unwritable");
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock(lockPath: string, content: string): void {
  try {
    // Only remove a lock that is still ours (a stale-lock sweep by another process may have replaced it).
    if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/**
 * Runs a read-modify-write of the credential store under `<configDir>/credentials.lock` (O_EXCL, 0600,
 * pid + timestamp). Waits up to ~3 s; a lock older than 30 s is a crashed holder's and is swept once.
 */
function withCredentialsLock<T>(run: () => T): T {
  const lockPath = join(dirname(credentialsPath()), LOCK_FILE);
  const guard = assertSafeTarget(lockPath, { allowMissing: true });
  if (!guard.ok) throw unsafeError(lockPath, guard.reason);
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: DIR_MODE });
  } catch {
    throw new CliError(`Cannot create ${dirname(lockPath)}.`, ExitCode.SERVER_ERROR, "credentials_unwritable");
  }

  const content = `${process.pid} ${Date.now()} ${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let swept = false;
  let delay = LOCK_POLL_MIN_MS;
  while (!tryCreateLock(lockPath, content)) {
    if (!swept && lockAgeMs(lockPath) > LOCK_STALE_MS) {
      swept = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else swept it first: just retry.
      }
      continue;
    }
    if (Date.now() >= deadline) throw lockedError();
    sleepSync(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, LOCK_POLL_MAX_MS);
  }
  try {
    return run();
  } finally {
    releaseLock(lockPath, content);
  }
}

function invalidSeatError(): CliError {
  return new CliError(
    "Refusing to save this login: its details are incomplete or invalid.",
    ExitCode.SERVER_ERROR,
    "credentials_invalid_seat",
  );
}

/**
 * Stores or replaces a seat (validated exactly as on read; an invalid one is refused before anything is
 * written). `default_seat` follows the seat logged into most recently, so `makeDefault` moves it; a store
 * with no default (first login) adopts the seat either way. The whole read-modify-write holds the lock.
 */
export function saveSeat(seatId: string, seat: StoredSeat, opts: { makeDefault: boolean }): void {
  const valid = validSeatId(seatId) ? validateSeat(seat) : null;
  if (valid === null) throw invalidSeatError();
  withCredentialsLock(() => {
    const store = readStore();
    const { credentials, preserved } = store;
    delete preserved[seatId];
    credentials.seats[seatId] = valid;
    if (opts.makeDefault || credentials.default_seat === null) credentials.default_seat = seatId;
    writeCredentials(credentials, preserved);
  });
}

function savedAtMillis(seat: StoredSeat): number {
  const millis = Date.parse(seat.saved_at);
  return Number.isNaN(millis) ? Number.NEGATIVE_INFINITY : millis;
}

/**
 * Deletes a seat (an unreadable entry too, so a logout can clear it). Removing the default moves it to
 * the most recently saved remaining seat (seat id as the tiebreak), or clears it. Removing an unknown
 * seat writes nothing.
 */
export function removeSeat(seatId: string): { removed: boolean; newDefault: string | null } {
  return withCredentialsLock(() => {
    const { credentials, preserved } = readStore();
    const wasInvalid = Object.hasOwn(preserved, seatId);
    if (!wasInvalid && !Object.hasOwn(credentials.seats, seatId)) {
      return { removed: false, newDefault: credentials.default_seat };
    }
    delete preserved[seatId];
    delete credentials.seats[seatId];
    if (credentials.default_seat === seatId) {
      const remaining = Object.entries(credentials.seats).sort(([idA, a], [idB, b]) => {
        const diff = savedAtMillis(b) - savedAtMillis(a);
        if (diff !== 0 && !Number.isNaN(diff)) return diff;
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });
      credentials.default_seat = remaining[0]?.[0] ?? null;
    }
    writeCredentials(credentials, preserved);
    return { removed: true, newDefault: credentials.default_seat };
  });
}
