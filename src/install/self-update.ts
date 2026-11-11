// The CLI's own update: what the npm registry says is the latest `jubarteai`, and whether that is newer than the
// running one. `update` uses this to offer `npm install -g jubarteai@<v>` before it updates anything else; `doctor`
// uses it to say a newer CLI exists. Nothing here reads, sends or prints a key: the registry is asked anonymously,
// npm and the re-executed CLI get childEnv() (never JUBARTEAI_TOKEN).
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { CLI_NAME } from "../constants.js";
import { homeDir } from "../paths.js";
import { childEnv } from "../process-env.js";
import { resolveInvocation, runCommand, type Probe } from "./run.js";

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

export type CliInstallOutcome =
  | { ok: true }
  | { ok: false; eacces: boolean; timedOut: boolean; notFound: boolean };

/**
 * npm runs from the home folder with node options emptied: started in the project it would read that repository's
 * own .npmrc, where a `registry=` or `node-options=` line could swap the package being installed globally. The user's
 * ~/.npmrc (a corporate mirror) still applies.
 */
const NPM_ENV: Readonly<Record<string, string>> = { npm_config_node_options: "", NODE_OPTIONS: "" };

/** npm's own words for "can't write to the global folder" (it prints the code; the message is never shown). */
const PERMISSION_CODES = /\b(EACCES|EPERM)\b/;

/**
 * `npm install -g jubarteai@<version>` through runCommand (argument array, no shell, childEnv: no key), from the
 * home folder, 180 s.
 * Never throws; npm's output is only searched for a permission code, never printed (it can carry paths).
 */
export async function installCliVersion(version: string): Promise<CliInstallOutcome> {
  if (!isSemver(version)) return { ok: false, eacces: false, timedOut: false, notFound: false };
  const res = await runCommand("npm", ["install", "-g", `jubarteai@${version}`], {
    cwd: homeDir(),
    env: { ...NPM_ENV },
    timeoutMs: CLI_INSTALL_TIMEOUT_MS,
  });
  if (res.code === 0 && !res.timedOut) return { ok: true };
  return { ok: false, eacces: PERMISSION_CODES.test(`${res.stderr}\n${res.stdout}`), timedOut: res.timedOut, notFound: res.notFound };
}

export type ReexecOutcome = { started: true; code: number } | { started: false; reason: "not-found" | "unsafe-shim" | "spawn-failed" };

function probe(env: NodeJS.ProcessEnv): Probe {
  return {
    platform: process.platform,
    env,
    execPath: process.execPath,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (p) => {
      try {
        if (!statSync(p).isFile()) return false;
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Exit code of a child that ended on a signal, as a shell reports it (128 + the signal number). */
function signalCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const n = osConstants.signals[signal];
  return typeof n === "number" ? 128 + n : 1;
}

/**
 * Runs the `jubarteai` now on PATH (the one npm just installed) with `args`, inheriting the terminal, and resolves
 * with its exit code. The environment is childEnv() (never the key). While it runs, SIGINT and SIGTERM don't end
 * this process: Ctrl-C reaches the child through the terminal, and a SIGTERM is passed on to it.
 */
export async function reexecCli(args: string[]): Promise<ReexecOutcome> {
  const env = childEnv();
  const invocation = resolveInvocation(CLI_NAME, args, probe(env));
  if (!invocation.ok) return { started: false, reason: invocation.reason };
  return new Promise<ReexecOutcome>((done) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.file, invocation.args, { env, stdio: "inherit", shell: false, windowsHide: false });
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
