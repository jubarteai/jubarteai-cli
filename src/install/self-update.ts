// The CLI's own update: what the npm registry says is the latest `jubarteai`, and whether that is newer than the
// running one. `update` uses this to offer `npm install -g jubarteai@<v>` before it updates anything else; `doctor`
// uses it to say a newer CLI exists. Nothing here reads, sends or prints a key: the registry is asked anonymously,
// npm and the re-executed CLI get childEnv() (never JUBARTEAI_TOKEN).
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { CLI_NAME } from "../constants.js";
import { homeDir } from "../paths.js";
import { childEnv } from "../process-env.js";
import { logTail, runCommand } from "./run.js";

/** The registry document for the `latest` dist-tag of the package. */
export const CLI_REGISTRY_LATEST_URL = "https://registry.npmjs.org/jubarteai/latest";

/** How long the registry lookup may take before it counts as offline. */
export const CLI_REGISTRY_TIMEOUT_MS = 5_000;

/** The most of the registry's answer that is read (one version's manifest is a few kilobytes). */
const REGISTRY_BODY_MAX_BYTES = 1024 * 1024;

/** A semantic version: MAJOR.MINOR.PATCH, an optional pre-release, an optional build (ignored when comparing). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Parsed = { core: [bigint, bigint, bigint]; pre: string[] };

function parse(version: string): Parsed | null {
  const m = SEMVER.exec(version.trim());
  if (m === null) return null;
  return {
    core: [BigInt(m[1] ?? "0"), BigInt(m[2] ?? "0"), BigInt(m[3] ?? "0")],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** True when `value` is a semantic version (what the registry must answer with). */
export function isSemver(value: string): boolean {
  return parse(value) !== null;
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/** Semantic-version precedence: negative, zero or positive as `a` is older than, equal to or newer than `b`. */
function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i += 1) {
    const x = a.core[i] ?? 0n;
    const y = b.core[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  // A release is newer than any pre-release of the same core version.
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdentifiers(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * True when `latest` is a strictly newer semantic version than `current`. Anything that isn't a semantic version on
 * either side is never "newer", so an odd registry answer or a development build can't trigger an install loop.
 */
export function isNewer(latest: string, current: string): boolean {
  const l = parse(latest);
  const c = parse(current);
  if (l === null || c === null) return false;
  return compare(l, c) > 0;
}

async function readCapped(res: Response): Promise<string | null> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REGISTRY_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The version the npm registry tags `latest` for `jubarteai`, or null on any failure: offline, a timeout
 * (`timeoutMs`, default 5 s), a non-200 answer, an oversized or non-JSON body, or a version that isn't semver.
 * Never throws and never says why: a failed lookup is only ever an advisory line.
 */
export async function fetchLatestVersion(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? CLI_REGISTRY_TIMEOUT_MS;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts?.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
    const res = await fetch(CLI_REGISTRY_LATEST_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readCapped(res);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
      return null;
    }
    const version = parsed.version.trim();
    return isSemver(version) ? version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Installing the newer CLI and handing over to it
// ---------------------------------------------------------------------------

/** How long `npm install -g` may take before it is stopped. */
export const CLI_INSTALL_TIMEOUT_MS = 180_000;
/** How long `npm prefix -g` may take. */
const NPM_PREFIX_TIMEOUT_MS = 10_000;

/**
 * npm runs from the home folder with node options emptied: started in the project it would read that repository's
 * own .npmrc, where a `registry=` or `node-options=` line could swap the package being installed globally. The user's
 * ~/.npmrc (a corporate mirror) still applies.
 */
const NPM_ENV: Readonly<Record<string, string>> = { npm_config_node_options: "", NODE_OPTIONS: "" };

/** npm's own words for "can't write to the global folder" (it prints the code; the message is never shown). */
const PERMISSION_CODES = /\b(EACCES|EPERM)\b/;

/** Where the running CLI lives in npm's global layout. */
export type CliInstall = {
  /** npm's global prefix this copy was installed under (`npm install -g --prefix <this>` updates it in place). */
  prefix: string;
  /** The package's bin script under that prefix: the file `npm install -g` replaces, run with `node <entry>`. */
  entry: string;
};

/** The bin script npm installs under `prefix` (POSIX `lib/node_modules/…`, Windows `node_modules\…`). */
export function cliEntryFor(prefix: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? win32 : posix;
  return platform === "win32"
    ? p.join(prefix, "node_modules", CLI_NAME, "bin", `${CLI_NAME}.js`)
    : p.join(prefix, "lib", "node_modules", CLI_NAME, "bin", `${CLI_NAME}.js`);
}

type LocateOptions = {
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
  isFile?: (path: string) => boolean;
};

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the running CLI is installed, from the real path of its bin script (`process.argv[1]`, a symlink or a .cmd
 * shim on PATH resolves to it): POSIX `<prefix>/lib/node_modules/jubarteai/bin/jubarteai.js`, Windows
 * `<prefix>\node_modules\jubarteai\bin\jubarteai.js` (and, since a project-local install has that same shape there,
 * only with npm's global shim `<prefix>\jubarteai.cmd` beside it). Null for anything else: an npx cache, a
 * project's node_modules, a development checkout. Such a copy is not updated by `npm install -g`.
 */
export function globalInstallOf(argv1: string | undefined, opts: LocateOptions = {}): CliInstall | null {
  if (argv1 === undefined || argv1 === "") return null;
  const platform = opts.platform ?? process.platform;
  const realpath = opts.realpath ?? ((x: string) => realpathSync(x));
  const isFile = opts.isFile ?? fileExists;
  const p = platform === "win32" ? win32 : posix;
  let real: string;
  try {
    real = realpath(argv1);
  } catch {
    return null;
  }
  const bin = p.dirname(real);
  const pkg = p.dirname(bin);
  const modules = p.dirname(pkg);
  const same = (a: string, b: string): boolean => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(p.basename(real), `${CLI_NAME}.js`) || !same(p.basename(bin), "bin") || !same(p.basename(pkg), CLI_NAME)) return null;
  if (!same(p.basename(modules), "node_modules")) return null;
  let prefix: string;
  if (platform === "win32") {
    prefix = p.dirname(modules);
    if (!isFile(p.join(prefix, `${CLI_NAME}.cmd`))) return null;
  } else {
    const lib = p.dirname(modules);
    if (p.basename(lib) !== "lib") return null;
    prefix = p.dirname(lib);
  }
  return { prefix, entry: cliEntryFor(prefix, platform) };
}

/** npm's configured global prefix (`npm prefix -g`, from HOME, node options off), or null when it can't be read. */
export async function npmGlobalPrefix(): Promise<string | null> {
  const res = await runCommand("npm", ["prefix", "-g"], { cwd: homeDir(), env: { ...NPM_ENV }, timeoutMs: NPM_PREFIX_TIMEOUT_MS });
  if (res.code !== 0 || res.timedOut) return null;
  const line = res.stdout.trim().split("\n")[0]?.trim() ?? "";
  return line === "" ? null : line;
}

function samePath(a: string, b: string): boolean {
  const norm = (x: string): string => {
    try {
      return realpathSync(x);
    } catch {
      return resolve(x);
    }
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export type CliInstallOutcome =
  | { ok: true }
  | { ok: false; eacces: boolean; timedOut: boolean; notFound: boolean; log?: string[] };

/**
 * `npm install -g jubarteai@<version>` into `prefix`, the prefix the running CLI was installed under: when that is
 * not npm's configured global prefix (the `--prefix "$HOME/.local"` fallback of the install shim), `--prefix
 * <prefix>` is passed, so the copy that runs is the one updated (and a fallback install doesn't hit EACCES on every
 * run). A failed `npm prefix -g` lookup passes `--prefix` too: naming the prefix is always right. Through runCommand
 * (argument array, no shell, childEnv: no key), from the home folder, 180 s. Never throws; npm's output is only
 * searched for a permission code, never printed (it can carry paths).
 */
export async function installCliVersion(version: string, prefix: string): Promise<CliInstallOutcome> {
  if (!isSemver(version)) return { ok: false, eacces: false, timedOut: false, notFound: false };
  const configured = await npmGlobalPrefix();
  const prefixArgs = configured !== null && samePath(configured, prefix) ? [] : ["--prefix", prefix];
  const res = await runCommand("npm", ["install", "-g", ...prefixArgs, `jubarteai@${version}`], {
    cwd: homeDir(),
    env: { ...NPM_ENV },
    timeoutMs: CLI_INSTALL_TIMEOUT_MS,
  });
  if (res.code === 0 && !res.timedOut) return { ok: true };
  const log = logTail(res);
  return { ok: false, eacces: PERMISSION_CODES.test(`${res.stderr}\n${res.stdout}`), timedOut: res.timedOut, notFound: res.notFound, ...(log.length === 0 ? {} : { log }) };
}

export type ReexecOutcome = { started: true; code: number } | { started: false; reason: "not-found" | "spawn-failed" };

/** Exit code of a child that ended on a signal, as a shell reports it (128 + the signal number). */
function signalCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const n = osConstants.signals[signal];
  return typeof n === "number" ? 128 + n : 1;
}

/**
 * Runs `node <entry> <args>` — `entry` is the bin script npm just replaced in place under the running install's
 * prefix, never whatever `jubarteai` comes first on PATH (that can be another, stale copy) — with this process's own
 * Node, inheriting the terminal, and resolves with its exit code. The environment is childEnv() (never the key).
 * While it runs, SIGINT and SIGTERM don't end this process: Ctrl-C reaches the child through the terminal, and a
 * SIGTERM is passed on to it.
 */
export async function reexecCli(entry: string, args: string[]): Promise<ReexecOutcome> {
  if (!fileExists(entry)) return { started: false, reason: "not-found" };
  const env = childEnv();
  return new Promise<ReexecOutcome>((done) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry, ...args], { env, stdio: "inherit", shell: false, windowsHide: false });
    } catch {
      done({ started: false, reason: "spawn-failed" });
      return;
    }
    const onInt = (): void => {
      // The terminal sends Ctrl-C to the child too; this process waits for it to finish.
    };
    const onTerm = (): void => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    let settled = false;
    const finish = (outcome: ReexecOutcome): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      done(outcome);
    };
    child.once("error", () => finish({ started: false, reason: "spawn-failed" }));
    child.once("exit", (code, signal) => finish({ started: true, code: code ?? signalCode(signal) }));
  });
}
