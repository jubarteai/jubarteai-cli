// A real pseudo-terminal (node-pty: openpty on POSIX, ConPTY on Windows) around the built binary, for the tests that
// press keys: the raw-mode checklist, the spinner, the banner at a given width. A missing or unbuildable node-pty
// skips the test loudly on a developer machine; on CI (where `npm ci` builds it) it fails the run instead.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { stripAnsi } from "../../src/ui/display.js";

type NodePty = typeof import("node-pty");

let cached: NodePty | null | undefined;

/** node-pty, or null (with one console warning) when it can't be loaded here. */
export function loadPty(): NodePty | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    // npm's prebuilt spawn-helper can arrive without its execute bit (its postinstall is what sets it).
    const prebuilds = join(dirname(dirname(entry)), "prebuilds");
    if (existsSync(prebuilds)) {
      for (const dir of readdirSync(prebuilds)) {
        const helper = join(prebuilds, dir, "spawn-helper");
        if (existsSync(helper)) chmodSync(helper, 0o755);
      }
    }
    cached = require("node-pty") as NodePty;
  } catch (error) {
    const why = error instanceof Error ? error.message : "unknown error";
    // CI builds node-pty with `npm ci`; if it can't load there, the terminal tests would pass by not running.
    if (process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false" && process.env["CI"] !== "0") {
      throw new Error(`node-pty is not usable on this CI runner, so the pty tests cannot run (${why})`, { cause: error });
    }
    console.warn(`pty tests skipped: node-pty is not usable here (${why})`);
    cached = null;
  }
  return cached;
}

export type PtySession = {
  /** Everything printed so far, escape codes included. */
  raw(): string;
  /** The same with escape codes and carriage returns removed. */
  text(): string;
  send(keys: string): void;
  /** Resolves when `pattern` appears in the plain text after `fromIndex`; rejects with the output after `timeoutMs`. */
  waitFor(pattern: string | RegExp, opts?: { timeoutMs?: number; after?: number }): Promise<number>;
  exit: Promise<{ exitCode: number; signal?: number | undefined }>;
  kill(): void;
};

export function spawnPty(
  pty: NodePty,
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols?: number; rows?: number },
): PtySession {
  const term = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
  });
  let raw = "";
  term.onData((chunk) => {
    raw += chunk;
  });
  const exit = new Promise<{ exitCode: number; signal?: number | undefined }>((resolve) => {
    term.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
  });
  const plain = (): string => stripAnsi(raw).replace(/\r/g, "");
  return {
    raw: () => raw,
    text: plain,
    send: (keys) => term.write(keys),
    async waitFor(pattern, wait = {}) {
      const deadline = Date.now() + (wait.timeoutMs ?? 20_000);
      for (;;) {
        const text = plain();
        const from = wait.after ?? 0;
        const hit = typeof pattern === "string" ? text.indexOf(pattern, from) : text.slice(from).search(pattern);
        if (hit >= 0) return typeof pattern === "string" ? hit + pattern.length : from + hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(pattern)}\n--- output ---\n${text}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    exit,
    kill: () => {
      try {
        term.kill();
      } catch {
        // Already gone.
      }
    },
  };
}
