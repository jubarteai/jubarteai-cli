// Every child process the CLI starts (except the browser opener) goes through here: an argument array and
// never a shell, an environment that never carries the JubarteAI key (childEnv), a timeout that kills the
// child, and output that is read as text and capped. Callers decide what a result means.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import * as nodePath from "node:path";
import { redactSecrets, safeForDisplay } from "../output.js";
import { childEnv } from "../process-env.js";

export type RunResult = {
  /** The exit code; null when the child was killed by a signal or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The command is not on PATH (or not an executable file). */
  notFound: boolean;
};

export type RunOptions = {
  cwd?: string;
  /** The child is killed after this many milliseconds. */
  timeoutMs: number;
  /** Added to the child's environment; JUBARTEAI_TOKEN is dropped even here. */
  env?: Record<string, string>;
  /** Written to the child's stdin, then stdin is closed. Without it stdin is closed at once (like `</dev/null`). */
  input?: string;
};

let childOutput: ((line: string) => void) | null = null;
const STREAM_LINE_LIMIT = 400;

/**
 * While set (by --verbose), every line a child prints is passed to `handler`, already redacted and with control
 * characters replaced, so a progress view can show npm's and the skills installer's output as it happens. Null turns it off.
 */
export function setChildOutput(handler: ((line: string) => void) | null): void {
  childOutput = handler;
}

/** The text a child printed, as the last `lines` non-empty lines, each redacted and safe to print. For a failure's log tail. */
export function logTail(res: { stdout: string; stderr: string }, lines = 15): string[] {
  return `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .map((line) => safeForDisplay(line.trim(), STREAM_LINE_LIMIT))
    .filter((line) => line !== "")
    .slice(-lines);
}

/** Passes complete lines to the handler as chunks arrive; `flush` emits a last partial line. */
function lineStreamer(): { push(chunk: string): void; flush(): void } {
  let pending = "";
  const emit = (line: string): void => {
    const handler = childOutput;
    if (handler === null) return;
    const safe = safeForDisplay(redactSecrets(line).trim(), STREAM_LINE_LIMIT);
    if (safe !== "") handler(safe);
  };
  return {
    push(chunk) {
      if (childOutput === null) return;
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) emit(part);
    },
    flush() {
      if (pending !== "") emit(pending);
      pending = "";
    },
  };
}

/** The most output kept per stream; a child that writes more is still drained, the rest is dropped. */
export const MAX_OUTPUT_CHARS = 1024 * 1024;
/** After SIGTERM a child gets this long before SIGKILL. */
const KILL_GRACE_MS = 1500;
/** After SIGKILL, how long to wait for the pipes to close before giving up on them (a grandchild can hold them open). */
const PIPE_GRACE_MS = 1500;

const UNSAFE_SHIM = "refused to start a .cmd or .bat file through a shell with these arguments";

/** The characters a .cmd shim's path and arguments may contain when it has to run through cmd.exe: nothing cmd.exe treats as syntax. */
const SAFE_SHIM_ARG = /^[A-Za-z0-9_.:=@+,\\/-]+$/;
const SAFE_SHIM_PATH = /^[A-Za-z]:[A-Za-z0-9_.:+,\\/-]+$/;
const DEFAULT_PATHEXT = ".com;.exe;.bat;.cmd";

/** What the lookup reads from the machine; production uses `machine()`, tests inject a fake. */
export type Probe = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
};

function machine(env: NodeJS.ProcessEnv): Probe {
  return {
    platform: process.platform,
    env,
    execPath: process.execPath,
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** An environment variable by name; Windows names are case-insensitive and a copied env is a plain, case-sensitive object. */
function envVar(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The path rules of the platform being asked about (a Windows probe in a test on another system still gets Windows paths). */
function pathRules(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** `which` with its machine injected (tests). */
export function whichWith(cmd: string, probe: Probe): string | null {
  if (cmd === "" || cmd.includes("\0")) return null;
  const { delimiter, extname, isAbsolute, join, resolve } = pathRules(probe.platform);
  const win = probe.platform === "win32";
  const exts = win
    ? (envVar(probe.env, "PATHEXT", probe.platform) ?? DEFAULT_PATHEXT)
        .split(";")
        .map((e) => e.trim())
        .filter((e) => e.startsWith("."))
    : [];
  const withExtensions = (base: string): string[] => {
    if (!win) return [base];
    const own = extname(base).toLowerCase();
    return exts.some((e) => e.toLowerCase() === own) ? [base] : exts.map((e) => base + e);
  };
  const usable = (candidate: string): boolean => (win ? probe.isFile(candidate) : probe.isExecutable(candidate));

  if (cmd.includes("/") || (win && cmd.includes("\\"))) {
    const abs = resolve(cmd);
    return withExtensions(abs).find(usable) ?? null;
  }
  const pathVar = envVar(probe.env, "PATH", probe.platform) ?? "";
  for (const dir of pathVar.split(delimiter)) {
    // An empty or relative entry means "the current folder": never run something out of the folder we were started in.
    if (dir === "" || !isAbsolute(dir)) continue;
    const hit = withExtensions(join(dir, cmd)).find(usable);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** The path `cmd` would run from on PATH, found without a shell (PATHEXT on Windows); null when there is none. */
export function which(cmd: string, env: NodeJS.ProcessEnv = childEnv()): string | null {
  return whichWith(cmd, machine(env));
}

export type Invocation = { ok: true; file: string; args: string[] } | { ok: false; reason: "not-found" | "unsafe-shim" };

/**
 * What to spawn for `cmd args`. On Windows Node refuses to start a .cmd or .bat without a shell, and npm and npx
 * are .cmd shims, so those two run as `node <npm-cli.js | npx-cli.js> args` from the npm that sits next to the running
 * node. Any other shim is started through cmd.exe only when its path and every argument are free of characters cmd.exe
 * treats as syntax; otherwise it is refused. (An npm that doesn't sit next to node, as under Volta, is therefore run
 * through its shim, which is allowed for ordinary arguments.)
 */
export function resolveInvocation(cmd: string, args: string[], probe: Probe): Invocation {
  const found = whichWith(cmd, probe);
  if (found === null) return { ok: false, reason: "not-found" };
  if (probe.platform !== "win32") return { ok: true, file: found, args };
  const { basename, dirname, extname, join } = pathRules(probe.platform);
  const ext = extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { ok: true, file: found, args };

  const name = basename(found, extname(found)).toLowerCase();
  if (name === "npm" || name === "npx") {
    const script = join(dirname(probe.execPath), "node_modules", "npm", "bin", `${name}-cli.js`);
    if (probe.isFile(script)) return { ok: true, file: probe.execPath, args: [script, ...args] };
  }
  if (!SAFE_SHIM_PATH.test(found) || !args.every((a) => SAFE_SHIM_ARG.test(a))) return { ok: false, reason: "unsafe-shim" };
  const comSpec = envVar(probe.env, "ComSpec", probe.platform) ?? "cmd.exe";
  return { ok: true, file: comSpec, args: ["/d", "/s", "/c", found, ...args] };
}

function failureResult(invocation: { ok: false; reason: "not-found" | "unsafe-shim" }): RunResult {
  return invocation.reason === "not-found"
    ? { code: null, stdout: "", stderr: "", timedOut: false, notFound: true }
    : { code: null, stdout: "", stderr: UNSAFE_SHIM, timedOut: false, notFound: false };
}

/** A Node error code as fixed text, never the error's message (it can carry a path or an argument). */
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(code) ? code : "error";
}

function checkTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive number");
}

/**
 * Run `cmd args` and collect its output. Never throws for a child's own failure (a missing binary, a non-zero exit, a
 * timeout, a failed start): those are fields of the result. `stderr` is the child's, except that a failed start puts a
 * fixed `could not start (<code>)` there. A timeout sends SIGTERM, then SIGKILL, and returns `timedOut: true`; only the
 * child itself is signalled, so a grandchild it started can outlive it.
 */
export async function runCommand(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  checkTimeout(opts.timeoutMs);
  const env = childEnv(opts.env);
  const invocation = resolveInvocation(cmd, args, machine(env));
  if (!invocation.ok) return failureResult(invocation);

  return new Promise<RunResult>((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const streams = { out: lineStreamer(), err: lineStreamer() };

    const finish = (result: Omit<RunResult, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      streams.out.flush();
      streams.err.flush();
      for (const t of timers) clearTimeout(t);
      done({ ...result, stdout, stderr, timedOut });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: opts.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = `could not start (${codeOf(error)})`;
      finish({ code: null, notFound: false });
      return;
    }

    const take = (current: string, chunk: string): string =>
      current.length >= MAX_OUTPUT_CHARS ? current : current + chunk.slice(0, MAX_OUTPUT_CHARS - current.length);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = take(stdout, chunk);
      streams.out.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = take(stderr, chunk);
      streams.err.push(chunk);
    });
    if (child.stdin !== null) {
      child.stdin.on("error", () => {
        // The child closed its input early (EPIPE): what it printed is the answer.
      });
      child.stdin.end(opts.input);
    }

    child.once("error", (error) => {
      const code = codeOf(error);
      if (code !== "ENOENT") stderr = `could not start (${code})`;
      finish({ code: null, notFound: code === "ENOENT" });
    });
    child.once("close", (code) => {
      finish({ code, notFound: false });
    });

    timers.push(
      setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        timers.push(
          setTimeout(() => {
            child.kill("SIGKILL");
            timers.push(
              setTimeout(() => {
                // Something that outlived the child holds its pipes open: stop waiting for them.
                child.stdout?.destroy();
                child.stderr?.destroy();
                finish({ code: null, notFound: false });
              }, PIPE_GRACE_MS),
            );
          }, KILL_GRACE_MS),
        );
      }, opts.timeoutMs),
    );
  });
}

/**
 * runCommand for the few callers that must answer synchronously (a repository's remote while a plan is being
 * built). Same rules: argument array, no shell, `childEnv`, a timeout (SIGKILL), capped output.
 */
export function runCommandSync(cmd: string, args: string[], opts: Omit<RunOptions, "input">): RunResult {
  checkTimeout(opts.timeoutMs);
  const env = childEnv(opts.env);
  const invocation = resolveInvocation(cmd, args, machine(env));
  if (!invocation.ok) return failureResult(invocation);

  const res = spawnSync(invocation.file, invocation.args, {
    cwd: opts.cwd,
    env,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_CHARS,
  });
  const stdout = (res.stdout ?? "").slice(0, MAX_OUTPUT_CHARS);
  const stderr = (res.stderr ?? "").slice(0, MAX_OUTPUT_CHARS);
  if (res.error !== undefined) {
    const code = codeOf(res.error);
    if (code === "ENOENT") return { code: null, stdout, stderr, timedOut: false, notFound: true };
    if (code === "ETIMEDOUT") return { code: null, stdout, stderr, timedOut: true, notFound: false };
    return { code: null, stdout, stderr: stderr === "" ? `could not start (${code})` : stderr, timedOut: false, notFound: false };
  }
  return { code: res.status, stdout, stderr, timedOut: false, notFound: false };
}
