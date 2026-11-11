import { readFileSync } from "node:fs";

export const DEFAULT_ORIGIN = "https://jubarte.ai";
export const CLI_NAME = "jubarteai";

export const CREDENTIALS_VERSION = 1;
export const BINDING_VERSION = 1;
export const SESSION_CACHE_VERSION = 1;
export const SESSION_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const MCP_TIMEOUT_MS = 60_000;
export const HOOK_TOTAL_BUDGET_MS = 8_000;
export const HOOK_NETWORK_TIMEOUT_MS = 5_000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Hosts for which a plain `http://` origin is accepted (local development only). */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** Largest value read from a file or stdin for a flag (`--json @file`, `--x-file`). */
export const ARG_INPUT_MAX_BYTES = 1024 * 1024;

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
