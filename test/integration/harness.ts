// The test bench for the integration suite: a throwaway machine (HOME, config, temp and a git repo as the
// working directory) around the BUILT binary (`node bin/jubarteai.js`), with recording stubs for the external
// programs the CLI starts (npx, npm, claude, codex) and a scan that proves a key never lands where it must not.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FakeServer } from "./fake-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = join(HERE, "..", "..");
export const BIN = join(CLI_ROOT, "bin", "jubarteai.js");
const STUB_SCRIPT = join(HERE, "stubs", "stub.mjs");

export const IS_WINDOWS = process.platform === "win32";
/** Why the init/update scenarios are POSIX-only: on Windows npm and npx are resolved through the npm that sits next to node, so PATH stubs never see the call. */
export const WINDOWS_STUB_REASON = "npx/npm resolve through the npm next to node on Windows, so PATH stubs cannot intercept them";

/** An obviously fake dashboard key (shape `jba_` + 8 to 128 URL-safe characters). */
export const FAKE_KEY = "jba_FAKEINTEGRATIONKEY0000000000000001";

export type StubName = "npx" | "npm" | "claude" | "codex";
export const ALL_STUBS: readonly StubName[] = ["npx", "npm", "claude", "codex"];

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
export type RunOptions = {
  cwd?: string;
  /** Written to the child's stdin, then closed. Bytes for input that is not text (invalid UTF-8). */
  stdin?: string | Uint8Array;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type StubCall = { name: string; argv: string[]; cwd: string; env: Record<string, string> };

export type Running = {
  stdout(): string;
  stderr(): string;
  /** Resolves with the first match of `pattern` in the stream's output; rejects after `timeoutMs`. */
  waitFor(stream: "stdout" | "stderr", pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  write(text: string): void;
  end(): void;
  kill(): void;
  exit: Promise<RunResult>;
};

class DistMissingError extends Error {
  constructor(reason: string) {
    super(`${reason}: run \`npm run build\` before the integration tests`);
    this.name = "DistMissingError";
  }
}

/** The newest modification time (ms) of a source file under `dir`, 0 when there is none. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(path));
    else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/** Fails fast, with the instruction, when the binary has not been built or is older than the sources it was built from. */
export function ensureBuilt(): void {
  const main = join(CLI_ROOT, "dist", "main.js");
  if (!existsSync(main)) throw new DistMissingError("dist/main.js is missing");
  // dist/main.js is the entry, but a rebuild rewrites every module: the oldest-looking check is the entry against the newest source.
  if (statSync(main).mtimeMs < newestSourceMtime(join(CLI_ROOT, "src"))) throw new DistMissingError("dist/ is older than src/");
}

function findOnPath(command: string): string | null {
  const exts = IS_WINDOWS ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * A Python 3.9+ interpreter (its real path, so a version-manager shim that needs the developer's HOME is not
 * run under the sandbox's), or null when there is none. Only the pseudo-terminal test needs one.
 */
export function locatePython(): string | null {
  const found = findOnPath("python3");
  if (found === null) return null;
  const probe = spawnSync(found, ["-I", "-c", "import os, sys; assert sys.version_info >= (3, 9) and hasattr(os, 'waitstatus_to_exitcode'); print(sys.executable)"], { encoding: "utf8" });
  const real = probe.status === 0 ? probe.stdout.trim() : "";
  return real === "" ? null : real;
}

export const PTY_SCRIPT = join(HERE, "stubs", "pty-paste.py");

export type Sandbox = {
  root: string;
  home: string;
  /** A git repository, the working directory of every run unless said otherwise. */
  repo: string;
  /** A second folder that is not a git repository and holds no binding. */
  outside: string;
  /** Where credentials.json lives. */
  credentialsFile: string;
  /** Every finished run, in order. */
  runs: Array<{ args: string[]; result: RunResult }>;
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  start(args: string[], opts?: RunOptions): Running;
  /** The sandbox's environment for a child of the caller's own (a pseudo-terminal session): HOME, PATH with only the stubs, and `extra`. */
  env(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  /** Starts any program in the sandbox's environment (stdin is left open for the caller). */
  startCommand(file: string, argv: string[], opts?: RunOptions): Running;
  /** Runs a shell command line the way a harness runs a registered hook: `sh -c`, the sandbox's environment, JSON on stdin. POSIX only. */
  runShell(command: string, opts?: RunOptions): Promise<RunResult>;
  /** `login --with-token` against `fake` with `key` (registered on the fake first). */
  signInWithKey(fake: FakeServer, key?: string): Promise<RunResult>;
  stubCalls(name?: StubName): StubCall[];
  /** Everything under root that holds one of `secrets`, plus any run output or stub record that does. Empty when clean. */
  findLeaks(secrets: string[], opts?: { allowFiles?: string[] }): string[];
  read(path: string): string;
  readJson(path: string): Record<string, unknown>;
  cleanup(): void;
};

type SandboxOptions = { stubs?: readonly StubName[]; repoName?: string };

function childEnv(box: { home: string; xdg: string; appData: string; tmp: string; path: string; stubLog: string }, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: box.home,
    USERPROFILE: box.home,
    XDG_CONFIG_HOME: box.xdg,
    APPDATA: box.appData,
    TMPDIR: box.tmp,
    TEMP: box.tmp,
    TMP: box.tmp,
    PATH: box.path,
    STUB_LOG: box.stubLog,
    // The fixed lines the tests read; the git calls the CLI makes need no identity or global config.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Hermetic: the CLI's lookups on the real internet (the npm registry, GitHub) go to a closed local port and
    // fail at once, so no test depends on, or reaches, the outside network. The fake servers are on the loopback
    // address, which NO_PROXY leaves alone. (Node reads these only with NODE_USE_ENV_PROXY.)
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    // Node 22 prints "EnvHttpProxyAgent is experimental" on stderr when the proxy variables are read; the tests
    // that expect an empty stderr (a hook) must not see Node's own notices.
    NODE_NO_WARNINGS: "1",
  };
  for (const name of ["SystemRoot", "windir", "COMSPEC", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

export function createSandbox(options: SandboxOptions = {}): Sandbox {
  ensureBuilt();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jba-int-")));
  const home = join(root, "home");
  const xdg = join(home, ".config");
  const appData = join(home, "AppData", "Roaming");
  const tmp = join(root, "tmp");
  const binDir = join(root, "bin");
  const repo = join(root, options.repoName ?? "acme-app");
  const outside = join(root, "outside");
  const stubLog = join(root, "stub-calls.jsonl");
  for (const dir of [home, xdg, appData, tmp, binDir, repo, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(stubLog, "");

  // PATH: only what the CLI needs (node, git) and the stubs. A real claude, codex or npx on the developer's
  // machine must never be found, so the node folder is not put on PATH on POSIX: node is linked in alone.
  const dirs = [binDir];
  if (IS_WINDOWS) {
    dirs.push(dirname(process.execPath));
    const git = findOnPath("git");
    if (git !== null) dirs.push(dirname(git));
  } else {
    symlinkSync(process.execPath, join(binDir, "node"));
    dirs.push("/usr/bin", "/bin");
    if (!existsSync("/usr/bin/git") && !existsSync("/bin/git")) {
      const git = findOnPath("git");
      if (git !== null) dirs.push(dirname(git));
    }
    for (const name of options.stubs ?? ALL_STUBS) {
      const wrapper = join(binDir, name);
      writeFileSync(wrapper, `#!/bin/sh\nexec "${join(binDir, "node")}" "${STUB_SCRIPT}" ${name} "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
  }
  const box = { home, xdg, appData, tmp, path: dirs.join(delimiter), stubLog };

  // git init in the repo (quietly; the default branch name does not matter).
  const init = gitInit(box, repo);
  if (init !== 0) throw new Error("git init failed in the sandbox");

  const runs: Sandbox["runs"] = [];

  function startProcess(file: string, argv: string[], args: string[], opts: RunOptions): Running {
    const child: ChildProcess = spawn(file, argv, {
      cwd: opts.cwd ?? repo,
      env: childEnv(box, opts.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: a new session, so the child has no controlling terminal and can never read a prompt from the developer's tty.
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
    });
    const kill = (): void => {
      try {
        if (!IS_WINDOWS && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timeoutMs = opts.timeoutMs ?? 45_000;
    const exit = new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        kill();
        reject(new Error(`jubarteai ${args[0] ?? ""} timed out after ${timeoutMs} ms\nstdout: ${out}\nstderr: ${err}`));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const result: RunResult = { code, signal, stdout: out, stderr: err };
        runs.push({ args, result });
        resolve(result);
      });
    });
    // A caller that only waits on part of the output must not leave an unhandled rejection behind.
    exit.catch(() => undefined);
    // A closed stdin pipe (the child exited first) must not crash the test process.
    child.stdin?.on("error", () => undefined);
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    if (opts.stdin !== undefined) child.stdin?.end();
    return {
      stdout: () => out,
      stderr: () => err,
      async waitFor(stream, pattern, waitMs = 15_000) {
        const deadline = Date.now() + waitMs;
        for (;;) {
          const match = (stream === "stdout" ? out : err).match(pattern);
          if (match !== null) return match;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(pattern)} on ${stream}\nstdout: ${out}\nstderr: ${err}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
      write(text) {
        child.stdin?.write(text);
      },
      end() {
        child.stdin?.end();
      },
      kill,
      exit,
    };
  }

  const start = (args: string[], opts: RunOptions = {}): Running => startProcess(process.execPath, [BIN, ...args], args, opts);
  const runChild = (file: string, argv: string[], opts: RunOptions): Promise<RunResult> =>
    startProcess(file, argv, [file, ...argv], { ...opts, stdin: opts.stdin ?? "" }).exit;

  const sandbox: Sandbox = {
    root,
    home,
    repo,
    outside,
    credentialsFile: IS_WINDOWS ? join(appData, "jubarteai", "credentials.json") : join(xdg, "jubarteai", "credentials.json"),
    runs,
    start,
    async run(args, opts = {}) {
      // stdin closed at once unless the test feeds it: a command that reads it sees end-of-file.
      const running = start(args, { ...opts, stdin: opts.stdin ?? "" });
      return running.exit;
    },
    startCommand: (file, argv, opts = {}) => startProcess(file, argv, [file, ...argv], opts),
    env: (extra = {}) => childEnv(box, extra),
    async runShell(command, opts = {}) {
      return runChild("/bin/sh", ["-c", command], opts);
    },
    async signInWithKey(fake, key = FAKE_KEY) {
      fake.addKey(key);
      return sandbox.run(["login", "--with-token"], { stdin: `${key}\n`, env: { JUBARTEAI_URL: fake.origin } });
    },
    stubCalls(name) {
      const text = readFileSync(stubLog, "utf8");
      const calls = text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StubCall);
      return name === undefined ? calls : calls.filter((call) => call.name === name);
    },
    findLeaks(secrets, opts = {}) {
      const found: string[] = [];
      // A key shows its first 12 characters (jba_ + 8) as its public prefix, so a match needs more than that.
      const generic = /jb[acw]_[A-Za-z0-9_-]{16,}/;
      for (const { args, result } of runs) {
        for (const [label, text] of [
          ["argv", args.join(" ")],
          ["stdout", result.stdout],
          ["stderr", result.stderr],
        ] as const) {
          if (secrets.some((s) => text.includes(s)) || generic.test(text)) found.push(`jubarteai ${args[0] ?? ""}: ${label}`);
        }
      }
      for (const line of readFileSync(stubLog, "utf8").split("\n")) {
        if (line !== "" && (secrets.some((s) => line.includes(s)) || generic.test(line))) found.push(`stub call: ${line.slice(0, 80)}`);
      }
      const allowed = new Set([...(opts.allowFiles ?? []), sandbox.credentialsFile]);
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          const info = lstatSync(path);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            walk(path);
            continue;
          }
          if (!info.isFile() || path === stubLog || allowed.has(path) || info.size > 5 * 1024 * 1024) continue;
          const bytes = readFileSync(path);
          if (secrets.some((s) => bytes.includes(s))) found.push(`file: ${path.slice(root.length + 1)}`);
        }
      };
      walk(root);
      return found;
    },
    read: (path) => readFileSync(path, "utf8"),
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return sandbox;
}

function gitInit(box: { home: string; xdg: string; appData: string; tmp: string; path: string; stubLog: string }, cwd: string): number {
  // Sync is fine here: once per sandbox, and the child's environment is the sandbox's own.
  const result = spawnSync("git", ["init", "-q"], { cwd, env: childEnv(box, {}), stdio: "ignore" });
  return result.status ?? 1;
}

/** Writes JSON to a path under the sandbox (creating folders), for planting configs. */
export function plantJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The newest history entry of the AGENTS.md section, with the repo slug filled in: what an older installer wrote. */
export function previousAgentsMdSection(slug: string): string {
  const history = JSON.parse(readFileSync(join(CLI_ROOT, "assets", "agents-md-snippet-history.json"), "utf8")) as string[];
  const last = history[history.length - 1];
  if (last === undefined) throw new Error("agents-md-snippet-history.json is empty");
  return last.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "").split("<repo-slug>").join(slug);
}
