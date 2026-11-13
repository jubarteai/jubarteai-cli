import { Writable } from "node:stream";

export type FakeStream = Writable & { isTTY: boolean; columns: number; getColorDepth: () => number; text(): string };

/** A stream that records what is written, claiming to be a terminal of the given size and colour depth (or a pipe). */
export function fakeStream(opts: { tty?: boolean; columns?: number; depth?: number } = {}): FakeStream {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  }) as FakeStream;
  stream.isTTY = opts.tty ?? false;
  stream.columns = opts.columns ?? 0;
  stream.getColorDepth = () => opts.depth ?? 24;
  stream.text = () => text;
  return stream;
}

import { PassThrough } from "node:stream";

import { setTtyOpenerForTests } from "../../src/prompt.js";
import type { TtyHandle } from "../../src/prompt.js";

export type FakeTerminal = {
  /** Text the "person" types. */
  type(text: string): void;
  /** Everything the terminal displayed. */
  shown(): string;
  /** The raw-mode states set, in order. */
  rawModes: boolean[];
  closed(): boolean;
  /** End of input (Ctrl-D at the device level). */
  end(): void;
  restore(): void;
};

/** Installs a terminal for prompts: `rawMode: "throws"` models a console that refuses raw mode, "missing" one that has no setRawMode. */
export function fakeTerminal(opts: { rawMode?: "ok" | "throws" | "missing"; rows?: number } = {}): FakeTerminal {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode?: (mode: boolean) => unknown };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  if (opts.rawMode !== "missing") {
    input.setRawMode = (mode: boolean) => {
      if (opts.rawMode === "throws" && mode) throw new Error("raw mode unavailable");
      rawModes.push(mode);
      return input;
    };
  }
  let shown = "";
  let closed = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      shown += chunk.toString("utf8");
      callback();
    },
  });
  if (opts.rows !== undefined) (output as Writable & { rows?: number }).rows = opts.rows;
  const handle: TtyHandle = {
    input,
    output,
    close() {
      closed = true;
    },
  };
  setTtyOpenerForTests(() => {
    closed = false;
    return handle;
  });
  return {
    type: (text) => void input.write(text),
    shown: () => shown,
    rawModes,
    closed: () => closed,
    end: () => input.end(),
    restore: () => setTtyOpenerForTests(null),
  };
}
