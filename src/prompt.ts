import { closeSync, openSync } from "node:fs";
import { isatty, ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from "node:tty";

import { PROMPT_MAX_ATTEMPTS, PROMPT_MAX_CHARS } from "./constants.js";
import { CliError, ExitCode, UsageError } from "./errors.js";

type TtyInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  unshift?: (chunk: string) => void;
};

export type TtyHandle = { input: TtyInput; output: NodeJS.WritableStream; close(): void };
export type TtyOpener = () => TtyHandle | null;

/** The device files that reach the controlling terminal when stdin is not a TTY. */
export function controllingTtyPaths(platform: string): { input: string; output: string } {
  return platform === "win32" ? { input: "CONIN$", output: "CONOUT$" } : { input: "/dev/tty", output: "/dev/tty" };
}

function openControllingTty(): TtyHandle | null {
  const paths = controllingTtyPaths(process.platform);
  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    inFd = openSync(paths.input, "r");
    outFd = openSync(paths.output, "w");
    if (!isatty(inFd) || !isatty(outFd)) throw new Error("not a terminal");
  } catch {
    if (inFd !== undefined) closeSync(inFd);
    if (outFd !== undefined) closeSync(outFd);
    return null;
  }
  const input = new TtyReadStream(inFd);
  const output = new TtyWriteStream(outFd);
  return {
    input,
    output,
    close() {
      try {
        input.setRawMode(false);
      } catch {
        // already closed
      }
      input.destroy();
      output.destroy();
    },
  };
}

function openStdinTty(): TtyHandle {
  const stdin = process.stdin;
  const output = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : process.stderr;
  return {
    input: stdin,
    output,
    close() {
      stdin.pause();
    },
  };
}

function defaultOpener(): TtyHandle | null {
  return process.stdin.isTTY ? openStdinTty() : openControllingTty();
}

let opener: TtyOpener = defaultOpener;

/** Test hook: where prompts read and write. `null` restores the real terminal lookup. */
export function setTtyOpenerForTests(replacement: TtyOpener | null): void {
  opener = replacement ?? defaultOpener;
}

/** True when a prompt could reach a person: stdin is a TTY, or /dev/tty (CONIN$ on Windows) opens. */
export function isInteractive(): boolean {
  const handle = opener();
  if (handle === null) return false;
  handle.close();
  return true;
}

/** Reads one line. Never echoes: the terminal does that in cooked mode, and `hidden` switches to raw mode. */
function readLine(handle: TtyHandle, hidden: boolean): Promise<string | null> {
  const input = handle.input;
  return new Promise((resolve, reject) => {
    const raw = hidden && typeof input.setRawMode === "function";
    let line = "";
    let escape: "none" | "esc" | "csi" = "none";
    let settled = false;

    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
    };
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const onEnd = (): void => settle(() => resolve(line.length > 0 ? line : null));

    function onData(chunk: string | Buffer): void {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let index = 0;
      for (const ch of text) {
        index += ch.length;
        if (escape === "esc") {
          escape = ch === "[" || ch === "O" ? "csi" : "none";
          continue;
        }
        if (escape === "csi") {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) escape = "none";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          const rest = text.slice(index);
          if (ch === "\r" && rest.startsWith("\n")) index += 1;
          const leftover = text.slice(index);
          if (hidden) handle.output.write("\n");
          settle(() => resolve(line));
          // After cleanup (listeners gone, paused), so the next prompt on this stream sees it.
          if (leftover.length > 0) input.unshift?.(leftover);
          return;
        }
        if (ch === "\u0003") {
          handle.output.write("\n");
          settle(() => reject(new CliError("Cancelled.", ExitCode.SERVER_ERROR, "cancelled")));
          return;
        }
        if (ch === "\u0004") {
          if (line.length === 0) {
            onEnd();
            return;
          }
          continue;
        }
        if (ch === "\u007f" || ch === "\b") {
          line = Array.from(line).slice(0, -1).join("");
          continue;
        }
        if (ch === "\u001b") {
          escape = "esc";
          continue;
        }
        if (ch.charCodeAt(0) < 0x20) continue;
        if (line.length + ch.length > PROMPT_MAX_CHARS) {
          settle(() => reject(new UsageError("That answer is too long.")));
          return;
        }
        line += ch;
      }
    }

    if (typeof (input as { setEncoding?: unknown }).setEncoding === "function") {
      (input as unknown as { setEncoding(encoding: string): void }).setEncoding("utf8");
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onEnd);
    if (raw) input.setRawMode?.(true);
    input.resume();
  });
}

async function withTerminal<T>(fallback: T, use: (handle: TtyHandle) => Promise<T>): Promise<T> {
  const handle = opener();
  if (handle === null) return fallback;
  try {
    return await use(handle);
  } finally {
    handle.close();
  }
}

/** Y/n question. Without a reachable TTY (or on end of input) it returns the default. */
export async function confirm(question: string, opts: { defaultYes: boolean }): Promise<boolean> {
  return withTerminal(opts.defaultYes, async (handle) => {
    const hint = opts.defaultYes ? "[Y/n]" : "[y/N]";
    for (let attempt = 0; attempt < PROMPT_MAX_ATTEMPTS; attempt++) {
      handle.output.write(`${question} ${hint} `);
      const answer = await readLine(handle, false);
      if (answer === null) return opts.defaultYes;
      const normalized = answer.trim().toLowerCase();
      if (normalized === "") return opts.defaultYes;
      if (normalized === "y" || normalized === "yes") return true;
      if (normalized === "n" || normalized === "no") return false;
      handle.output.write("Please answer y or n.\n");
    }
    return opts.defaultYes;
  });
}

/** One visible line. Empty answer → the default (or "" without one). Without a TTY → `default ?? null`. */
export async function promptLine(question: string, opts: { default?: string } = {}): Promise<string | null> {
  return withTerminal<string | null>(opts.default ?? null, async (handle) => {
    const suffix = opts.default !== undefined ? ` (${opts.default})` : "";
    handle.output.write(`${question}${suffix} `);
    const answer = await readLine(handle, false);
    if (answer === null) return opts.default ?? null;
    const trimmed = answer.trim();
    return trimmed === "" ? (opts.default ?? "") : trimmed;
  });
}

/** One line without echo, for secrets (ends trimmed). Without a TTY → null. */
export async function promptHidden(question: string): Promise<string | null> {
  return withTerminal<string | null>(null, async (handle) => {
    handle.output.write(`${question} `);
    const answer = await readLine(handle, true);
    return answer === null ? null : answer.trim();
  });
}

/** Numbered menu. Empty answer → the default. Without a TTY → the default choice. */
export async function choose<T>(
  question: string,
  choices: Array<{ label: string; value: T }>,
  opts: { defaultIndex: number },
): Promise<T> {
  const fallback = choices[opts.defaultIndex];
  if (fallback === undefined) throw new RangeError("choose: defaultIndex is out of range");
  return withTerminal<T>(fallback.value, async (handle) => {
    handle.output.write(`${question}\n`);
    choices.forEach((choice, index) => {
      handle.output.write(`  ${index + 1}) ${choice.label}\n`);
    });
    for (let attempt = 0; attempt < PROMPT_MAX_ATTEMPTS; attempt++) {
      handle.output.write(`Choose 1-${choices.length} (${opts.defaultIndex + 1}): `);
      const answer = await readLine(handle, false);
      if (answer === null) return fallback.value;
      const trimmed = answer.trim();
      if (trimmed === "") return fallback.value;
      const picked = /^\d+$/.test(trimmed) ? choices[Number(trimmed) - 1] : undefined;
      if (picked !== undefined) return picked.value;
      handle.output.write("Please enter one of the numbers shown.\n");
    }
    return fallback.value;
  });
}
