import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { setTtyOpenerForTests } from "../../src/prompt.js";
import type { TtyHandle } from "../../src/prompt.js";
import { resetEnvTokenForTests } from "../../src/process-env.js";

// A throwaway machine for init/link tests: a fake HOME, a git repo, and stub `npx`, `claude` and `codex` programs on a
// PATH that holds nothing else but the system's own tools, so no real editor is ever detected. Every stub call is
// appended to one log (its arguments and its whole environment), which is how tests prove what the CLI ran and that
// the key never reached a child. Prompts never reach a real terminal: the sandbox installs a "no terminal" opener,
// and `scriptedTty` swaps in a terminal that answers prompts from a function.

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "PATH",
  "TMPDIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "JUBARTEAI_TOKEN",
  "JUBARTEAI_URL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

export type StubCall = { name: string; args: string[]; pwd: string; env: string };

export type InitSandbox = {
  /** Real path of the sandbox folder. */
  root: string;
  /** The fake HOME. */
  home: string;
  /** A git repository inside it (initialised). */
  repo: string;
  /** Every call the stubs received, in order. */
  calls(): StubCall[];
  /** The whole call log as text (arguments and environments). */
  callLog(): string;
  /** Runs git in `dir` (default: the repo). */
  git(args: string[], dir?: string): string;
  /** Puts back the environment and removes the sandbox. */
  restore(): void;
};

export type SandboxOptions = {
  /** Which stubs to put on PATH (default: npx, claude, codex). */
  stubs?: Array<"npx" | "claude" | "codex">;
  /** What `codex --version` prints. */
  codexVersion?: string;
  /** The exit code of `npx` (default 0). */
  npxExit?: number;
};

function stubScript(name: string, log: string, body: string): string {
  return [
    "#!/bin/sh",
    "{",
    `  echo "CALL ${name}"`,
    '  for a in "$@"; do echo "ARG $a"; done',
    '  echo "PWD $PWD"',
    '  echo "ENV"',
    "  /usr/bin/env",
    '  echo "END"',
    `} >> "${log}"`,
    body,
    "",
  ].join("\n");
}

const NPX_BODY = (exitCode: number): string => `
prev=""
for a in "$@"; do
  if [ "$prev" = "-a" ]; then
    case "$a" in
      claude-code) d=.claude/skills;;
      windsurf) d=.windsurf/skills;;
      *) d=.agents/skills;;
    esac
    mkdir -p "$PWD/$d/jubarteai" && echo "# jubarteai skill" > "$PWD/$d/jubarteai/SKILL.md"
  fi
  prev="$a"
done
exit ${exitCode}`;

const CLAUDE_BODY = `
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
if [ "$1" = "--version" ]; then echo "2.1.300 (Claude Code)"; exit 0; fi
exit 0`;

const codexBody = (version: string): string => `
if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi
exit 0`;

export function createInitSandbox(options: SandboxOptions = {}): InitSandbox {
  const saved: Record<string, string | undefined> = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jba-init-")));
  const home = join(root, "home");
  const repo = join(home, "work", "repo");
  const bin = join(root, "bin");
  const log = join(root, "stub-calls.log");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, "");

  const stubs = options.stubs ?? ["npx", "claude", "codex"];
  const bodies: Record<string, string> = {
    npx: NPX_BODY(options.npxExit ?? 0),
    claude: CLAUDE_BODY,
    codex: codexBody(options.codexVersion ?? "0.162.1"),
  };
  for (const name of stubs) {
    const file = join(bin, name);
    writeFileSync(file, stubScript(name, log, bodies[name] ?? ""));
    chmodSync(file, 0o755);
  }

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TMPDIR = join(root, "tmp");
  mkdirSync(process.env.TMPDIR);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const name of ["XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"]) delete process.env[name];
  resetEnvTokenForTests();
  setTtyOpenerForTests(() => null);

  const git = (args: string[], dir: string = repo): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git(["init", "-q"]);

  return {
    root,
    home,
    repo,
    git,
    callLog: () => readFileSync(log, "utf8"),
    calls(): StubCall[] {
      return readFileSync(log, "utf8")
        .split("END\n")
        .filter((block) => block.trim() !== "")
        .map((block) => {
          const [head = "", env = ""] = block.split("\nENV\n");
          const lines = head.split("\n");
          return {
            name: (lines.find((l) => l.startsWith("CALL ")) ?? "").slice(5),
            args: lines.filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4)),
            pwd: (lines.find((l) => l.startsWith("PWD ")) ?? "").slice(4),
            env,
          };
        });
    },
    restore() {
      setTtyOpenerForTests(null);
      resetEnvTokenForTests();
      for (const name of ENV_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type TtyInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };

export type ScriptedTty = {
  /** Each prompt as the user saw it (question, menu and hint), in order. */
  prompts: string[];
  /** Everything the terminal displayed. */
  shown(): string;
};

/**
 * A terminal that answers confirm and choose prompts by calling `answer` with the prompt text; an empty reply takes
 * the prompt's default. Replaces the sandbox's "no terminal" opener until `restore()` or `setTtyOpenerForTests(null)`.
 */
export function scriptedTty(answer: (prompt: string) => string): ScriptedTty {
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.setRawMode = () => input;
  const prompts: string[] = [];
  let block = "";
  let shown = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf8");
      shown += text;
      block += text;
      if (/(\[(Y\/n|y\/N)(\/d)?\] |\(\d+\): |press Enter for all: )$/.test(block)) {
        const asked = block;
        block = "";
        prompts.push(asked);
        const reply = answer(asked);
        queueMicrotask(() => input.write(`${reply}\n`));
      }
      callback();
    },
  });
  const handle: TtyHandle = { input, output, close() {} };
  setTtyOpenerForTests(() => handle);
  return { prompts, shown: () => shown };
}

/** A writable that keeps what it was given. */
export function sink(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => text };
}

/** Every file under `dir` (not following links, skipping `.git`) whose text contains `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(path);
      } else if (entry.isFile()) {
        try {
          if (readFileSync(path, "utf8").includes(needle)) found.push(path);
        } catch {
          // unreadable: not a text file we care about
        }
      }
    }
  };
  walk(dir);
  return found;
}
