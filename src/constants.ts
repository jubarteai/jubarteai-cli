import { readFileSync } from "node:fs";

export const DEFAULT_ORIGIN = "https://jubarte.ai";
export const CLI_NAME = "jubarteai";

export const CREDENTIALS_VERSION = 1;
export const BINDING_VERSION = 1;
export const SESSION_CACHE_VERSION = 1;
export const SESSION_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const MCP_TIMEOUT_MS = 60_000;
/**
 * The timeout `init` registers with each harness for the session-start and user-prompt-submit hooks, in seconds
 * (Gemini CLI takes it in milliseconds: × 1000). It is the harness's limit for the whole process, Node start-up
 * included; the hook's own budget (HOOK_TOTAL_BUDGET_MS) starts only once Node is up, so it stays below this.
 * Session-end hooks register their own, shorter values (each harness allows it less time).
 */
export const HOOK_REGISTERED_TIMEOUT_S = 8;
/** The hook's internal budget, from when Node is up: below HOOK_REGISTERED_TIMEOUT_S, leaving headroom for start-up. */
export const HOOK_TOTAL_BUDGET_MS = 6_500;
export const HOOK_NETWORK_TIMEOUT_MS = 4_000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Path of the MCP endpoint on the origin a key was minted for. */
export const MCP_PATH = "/api/mcp";
/** Largest tool response read (a search or a knowledge entry is far below this). */
export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Largest error body read from a 401/402/403 (it carries one short code). */
export const MCP_AUTH_BODY_MAX_BYTES = 64 * 1024;
/** Server-written text is cut to this many characters before it is printed. */
export const MCP_SERVER_TEXT_MAX_CHARS = 2000;

/** Path of the inbox-watch long-poll endpoint on the same origin. */
export const INBOX_WATCH_PATH = "/api/mcp/inbox-watch";
/** `check_inbox --wait` is capped here, as the server caps `wait_seconds`. */
export const INBOX_WAIT_MAX_SECONDS = 40;
export const INBOX_WATCH_DEFAULT_MINUTES = 30;
export const INBOX_WATCH_MAX_MINUTES = 120;
export const INBOX_MS_PER_MINUTE = 60_000;
/** Longest one poll may last: the server answers within about 55 s, as curl's -m 58 did. */
export const INBOX_POLL_TIMEOUT_MS = 58_000;
export const INBOX_POLL_BODY_MAX_BYTES = 64 * 1024;
/** The watch ends at the server's expires_at, but never later than this past the minutes asked for. */
export const INBOX_EXPIRY_SLACK_MS = 60_000;
/** Delay before the next poll after a 5xx, a non-JSON or empty body, or an answer that is neither a wake-up nor an empty poll. */
export const INBOX_RETRY_AFTER_SERVER_MS = 10_000;
/** Delay before the next poll after a request that never completed (network down, DNS, timeout). */
export const INBOX_RETRY_AFTER_NETWORK_MS = 5_000;
/** An empty poll that comes back sooner than this waits out the rest of it, so a misbehaving server can't cause a spin loop. */
export const INBOX_MIN_POLL_MS = 1_000;
/** Retry delays get up to this fraction added, so many watchers don't retry in step. */
export const INBOX_RETRY_JITTER = 0.2;

/** Hosts for which a plain `http://` origin is accepted (local development only). */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** Largest value read from a file or stdin for a flag (`--json @file`, `--x-file`). */
export const ARG_INPUT_MAX_BYTES = 1024 * 1024;

/**
 * Largest `preToolUse` payload the guard reads (`jubarteai hook pre-tool-use`). The whole payload must be read for a
 * padded command to be seen; past it the call is denied as too large to check (review R-S14). A model's whole output
 * turn is a few hundred KiB at most (128k tokens), so 4 MiB is still far beyond any one tool call, and it is what keeps
 * the scan's worst case well inside the hook's fail-open timeout: GUARD_SCAN_BUDGET is twice this, and the slowest
 * content scans at about 235 ns a character (review round 12 R-S1).
 */
export const GUARD_INPUT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The guard's scan budget for one payload, in characters: every string collected from the tool arguments counts its
 * length (a JSON-looking string and each string parsed out of it separately), and every value walked and every JSON
 * parse attempt counts a fixed cost on top (GUARD_SCAN_VALUE_COST, GUARD_SCAN_PARSE_COST), since the work per string is
 * not only its characters. Twice the read cap covers the Copilot runtime's own nesting (`toolArgs` is a JSON string
 * holding `command`); JSON nested deeper than that inside a large argument, or millions of tiny strings, would otherwise
 * push the scan into the hook's timeout, which fails open, so past this budget the call is denied as too large to check
 * (review R-S1, rounds 9 and 11). Every character the matcher scans is charged here, so the scan's time is bounded by
 * this budget times the slowest content per character (a backslash or backtick between separators: at most about 235 ns
 * on an M1 Pro, a JSON-shaped string's raw text and its parsed strings both counted): under 2 s for 8 Mi characters,
 * against the 8 s timeout (review round 12 R-S1, R-S2).
 */
export const GUARD_SCAN_BUDGET = 2 * GUARD_INPUT_MAX_BYTES;

/**
 * What every value the guard walks costs in GUARD_SCAN_BUDGET on top of a string's own length: an array, an object, a
 * key, a number or a string. A string's fixed cost (its readings and their scans) is about a microsecond whatever its
 * length, so this caps a payload at about 130 thousand values, far beyond any tool call a model emits (review R-S1,
 * round 11).
 */
export const GUARD_SCAN_VALUE_COST = 64;

/**
 * What every JSON.parse attempt on a JSON-looking string costs in GUARD_SCAN_BUDGET on top of the string: a failed parse
 * throws, and an exception costs a few microseconds, so a payload of tiny invalid JSON strings (`"[]]"`) is capped at
 * about 26 thousand attempts (review R-S1, round 11).
 */
export const GUARD_SCAN_PARSE_COST = 256;

/** Deepest nesting of arrays, objects and JSON-in-strings the guard walks; deeper arguments are denied, not skipped. */
export const GUARD_SCAN_MAX_DEPTH = 20;

/** Longest answer accepted at an interactive prompt. */
export const PROMPT_MAX_CHARS = 8192;

/** How many times a prompt re-asks after an unusable answer before taking its default. */
export const PROMPT_MAX_ATTEMPTS = 5;

let cachedVersion: string | undefined;

/** The package version, read once from the package.json that sits next to src/ and dist/. */
export function cliVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const manifest = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    cachedVersion = parsed.version;
    return cachedVersion;
  }
  throw new Error("package.json has no version");
}

// Company skills sync (`jubarteai skills sync`, the session hooks).
/** After a failed sync, no new background sync starts for this long. */
export const SKILLS_BACKOFF_MS = 10 * 60 * 1000;
/** A sync lock older than this is stale (a crashed process) and is taken over. */
export const SKILLS_LOCK_STALE_MS = 5 * 60 * 1000;
export const SKILLS_DOWNLOAD_TIMEOUT_MS = 30_000;
/** One skill file, and the whole skill, never exceed what the server accepts (5 MiB). */
export const SKILLS_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SKILLS_MAX_FILES = 512;
export const SKILLS_MARKER_FILE = ".jubarteai-skill.json";
export const SKILLS_TMP_PREFIX = ".jubarteai-tmp-";
export const SKILLS_STATE_VERSION = 1;
export const SKILLS_SYNC_TIMEOUT_MS = 20_000;
