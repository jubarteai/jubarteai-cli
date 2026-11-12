import { DEFAULT_ORIGIN, LOOPBACK_HOSTS } from "./constants.js";
import { UsageError } from "./errors.js";

// The only module that reads JUBARTEAI_TOKEN and JUBARTEAI_URL.

const TOKEN_VAR = "JUBARTEAI_TOKEN";
const URL_VAR = "JUBARTEAI_URL";

let takenToken: string | null = null;

/**
 * Returns the key passed in `JUBARTEAI_TOKEN` (trimmed; null when unset or blank) and
 * removes the variable from process.env, so nothing read later (including a child
 * process that inherits the environment) can see it. Later calls return the same value.
 */
export function takeEnvToken(): string | null {
  if (Object.prototype.hasOwnProperty.call(process.env, TOKEN_VAR)) {
    const raw = process.env[TOKEN_VAR];
    delete process.env[TOKEN_VAR];
    const trimmed = raw === undefined ? "" : raw.trim();
    takenToken = trimmed === "" ? null : trimmed;
  }
  return takenToken;
}

/** A copy of process.env for a child process: never carries the key, plus `extra`. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[TOKEN_VAR];
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) {
      if (name !== TOKEN_VAR) env[name] = value;
    }
  }
  return env;
}

/**
 * The origin of a URL string, or null unless it is `https://`, or `http://` on a
 * loopback host, with no credentials. Path, query and hash are dropped.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return url.origin;
  return null;
}

export function isValidOrigin(value: string): boolean {
  return normalizeOrigin(value) !== null;
}

/**
 * `JUBARTEAI_URL` as an origin, or the default. The message never repeats the value
 * (it could carry credentials).
 */
export function envOrigin(): string {
  const raw = process.env[URL_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ORIGIN;
  const origin = normalizeOrigin(raw);
  if (origin === null) {
    throw new UsageError(
      `${URL_VAR} must be an https:// URL, or http:// on 127.0.0.1, localhost or [::1], with no credentials.`,
    );
  }
  return origin;
}

/** Test hook: forget a token taken earlier. */
export function resetEnvTokenForTests(): void {
  takenToken = null;
}
