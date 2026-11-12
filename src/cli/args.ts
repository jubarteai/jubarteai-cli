import { readFileSync, readSync, statSync } from "node:fs";

import { ARG_INPUT_MAX_BYTES } from "../constants.js";
import { UsageError } from "../errors.js";
import { safeForDisplay } from "../output.js";
import { suggest } from "./suggest.js";

export type FlagType = "string" | "number" | "boolean" | "string[]" | "json";

export type FlagSpec = {
  name: string;
  type: FlagType;
  description: string;
  /** Also accept `--<name>-file <path|->`, which reads the value from a file (or stdin for `-`). */
  file?: boolean;
  hidden?: boolean;
};

/**
 * Flags keep their kebab-case spec name as the key. A flag that was not given has no
 * key at all (booleans and arrays included), so callers use `flags.x ?? default`.
 */
export type ParsedArgs = { flags: Record<string, unknown>; positionals: string[] };

export type ParseOptions = {
  /** Reads all of stdin synchronously. Defaults to fd 0; tests inject a fake. */
  readStdin?: () => Buffer;
};

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "workspace", type: "string", description: "Use the stored seat for this workspace slug" },
  { name: "agent", type: "string", description: "Agent id to act as (default: this session's agent)" },
  { name: "pretty", type: "boolean", description: "Indent the JSON output" },
  { name: "yes", type: "boolean", description: "Accept every default without asking" },
  { name: "plain", type: "boolean", description: "Plain text output: no colours, banner or animation (also NO_COLOR, TERM=dumb)" },
  { name: "verbose", type: "boolean", description: "Show the output of the programs the command runs (npm, the skills installer)" },
  { name: "help", type: "boolean", description: "Show help" },
  { name: "version", type: "boolean", description: "Print the version" },
];

const SHORT_FLAGS: Readonly<Record<string, string>> = { h: "help", v: "version" };
const NUMBER_PATTERN = /^[+-]?\d+(\.\d+)?$/;

function defaultReadStdin(): Buffer {
  if (process.stdin.isTTY) {
    throw new UsageError("Standard input is a terminal; pipe the value in instead.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.alloc(64 * 1024);
  for (;;) {
    let read: number;
    try {
      read = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (code === "EOF") break;
      throw new UsageError("Could not read standard input.");
    }
    if (read === 0) break;
    total += read;
    if (total > ARG_INPUT_MAX_BYTES) throw new UsageError("Standard input is too large.");
    chunks.push(Buffer.from(chunk.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label} is not valid UTF-8 text.`);
  }
}

class Reader {
  private stdinUsed = false;

  constructor(private readonly readStdin: () => Buffer) {}

  /** The text behind `-` (stdin, once) or a regular file path. */
  text(source: string, flag: string): string {
    if (source === "-") {
      if (this.stdinUsed) throw new UsageError("Standard input can be read for only one flag.");
      this.stdinUsed = true;
      const bytes = this.readStdin();
      if (bytes.length > ARG_INPUT_MAX_BYTES) throw new UsageError("Standard input is too large.");
      return decodeUtf8(bytes, "Standard input");
    }
    if (source === "") throw new UsageError(`Flag --${flag} needs a file path.`);
    let bytes: Buffer;
    try {
      const info = statSync(source);
      if (!info.isFile()) throw new UsageError(`${safeForDisplay(source)} is not a regular file (given to --${flag}).`);
      if (info.size > ARG_INPUT_MAX_BYTES) throw new UsageError(`${safeForDisplay(source)} is too large (given to --${flag}).`);
      bytes = readFileSync(source);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`Cannot read ${safeForDisplay(source)} (given to --${flag}).`);
    }
    return decodeUtf8(bytes, safeForDisplay(source));
  }
}

function parseNumber(text: string, flag: string): number {
  const trimmed = text.trim();
  const value = NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value)) throw new UsageError(`Flag --${flag} needs a number.`);
  return value;
}

function parseJson(text: string, flag: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message can quote the input, which may hold secrets.
    throw new UsageError(`Flag --${flag} is not valid JSON.`);
  }
}

type Resolution =
  | { kind: "value"; spec: FlagSpec }
  | { kind: "file"; spec: FlagSpec }
  | { kind: "negation"; spec: FlagSpec };

/**
 * Parses argv against `specs`. Accepts `--x v`, `--x=v`, repeated array flags, `--x` / `--no-x`
 * booleans, `--json <inline|@path|->`, `--x-file <path|->` (when the spec opts in) and `--` to
 * end flags. A value that starts with `--` must be written `--x=--value`. Throws UsageError
 * (exit 2) for an unknown flag, a missing value or a bad value.
 */
export function parseArgs(argv: string[], specs: FlagSpec[], options: ParseOptions = {}): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  const byFileName = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.file === true && spec.type !== "boolean") byFileName.set(`${spec.name}-file`, spec);
  }
  const flagNames = specs.filter((spec) => spec.hidden !== true).map((spec) => spec.name);
  const reader = new Reader(options.readStdin ?? defaultReadStdin);
  const flags: Record<string, unknown> = {};
  const origin = new Map<string, "value" | "file">();
  const positionals: string[] = [];

  const resolve = (name: string): Resolution | null => {
    const direct = byName.get(name);
    if (direct !== undefined) return { kind: "value", spec: direct };
    const fromFile = byFileName.get(name);
    if (fromFile !== undefined) return { kind: "file", spec: fromFile };
    if (name.startsWith("no-")) {
      const target = byName.get(name.slice(3));
      if (target !== undefined && target.type === "boolean") return { kind: "negation", spec: target };
    }
    return null;
  };

  let terminated = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (terminated) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      name = eq < 0 ? body : body.slice(0, eq);
      inline = eq < 0 ? undefined : body.slice(eq + 1);
    } else if (/^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    } else {
      const long = arg.length === 2 ? SHORT_FLAGS[arg.slice(1)] : undefined;
      if (long === undefined || !byName.has(long)) throw new UsageError(`Unknown flag ${safeForDisplay(arg)}`);
      name = long;
      inline = undefined;
    }

    const found = name === "" ? null : resolve(name);
    if (found === null) {
      const near = name === "" ? null : suggest(name, flagNames);
      throw new UsageError(`Unknown flag --${safeForDisplay(name)}${near === null ? "" : `. Did you mean "--${near}"?`}`);
    }
    const { spec } = found;

    if (found.kind === "negation") {
      if (inline !== undefined) throw new UsageError(`Flag --${name} takes no value.`);
      flags[spec.name] = false;
      continue;
    }

    if (spec.type === "boolean") {
      if (inline === undefined || inline === "true") flags[spec.name] = true;
      else if (inline === "false") flags[spec.name] = false;
      else throw new UsageError(`Flag --${name} takes no value (or true/false).`);
      continue;
    }

    let raw: string;
    if (inline !== undefined) {
      raw = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`Flag --${name} needs a value. Write --${name}=<value> if the value starts with "--".`);
      }
      raw = next;
      i += 1;
    }

    const previous = origin.get(spec.name);
    if (previous !== undefined && previous !== found.kind) {
      throw new UsageError(`Use either --${spec.name} or --${spec.name}-file, not both.`);
    }
    origin.set(spec.name, found.kind);

    // `--x-file` always reads a file; a json flag also reads `@path` / `-` inline.
    let text = raw;
    let fromSource = found.kind === "file";
    if (!fromSource && spec.type === "json") {
      if (raw === "-") fromSource = true;
      else if (raw.startsWith("@")) {
        raw = raw.slice(1);
        fromSource = true;
      }
    }
    if (fromSource) text = reader.text(raw, found.kind === "file" ? `${spec.name}-file` : spec.name);

    switch (spec.type) {
      case "string":
        flags[spec.name] = text;
        break;
      case "number":
        flags[spec.name] = parseNumber(text, spec.name);
        break;
      case "json":
        flags[spec.name] = parseJson(text, spec.name);
        break;
      case "string[]": {
        const list = Array.isArray(flags[spec.name]) ? (flags[spec.name] as string[]) : [];
        list.push(text);
        flags[spec.name] = list;
        break;
      }
    }
  }
  return { flags, positionals };
}
