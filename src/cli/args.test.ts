import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UsageError } from "../errors.js";
import { GLOBAL_FLAGS, parseArgs } from "./args.js";
import type { FlagSpec } from "./args.js";

const SPECS: FlagSpec[] = [
  { name: "title", type: "string", description: "t" },
  { name: "tag", type: "string[]", description: "tags" },
  { name: "limit", type: "number", description: "n" },
  { name: "verbose", type: "boolean", description: "v" },
  { name: "json", type: "json", description: "j" },
  { name: "description", type: "string", description: "d", file: true },
  { name: "payload", type: "json", description: "p", file: true },
  ...GLOBAL_FLAGS,
];

function stdinOf(text: string): () => Buffer {
  return () => Buffer.from(text, "utf8");
}

function usageMessage(argv: string[], specs: FlagSpec[] = SPECS, readStdin?: () => Buffer): string {
  try {
    parseArgs(argv, specs, readStdin === undefined ? {} : { readStdin });
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    return (error as UsageError).message;
  }
  throw new Error("expected a UsageError");
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jubarteai-args-"));
  writeFileSync(join(dir, "body.md"), "line one\nline two\n");
  writeFileSync(join(dir, "data.json"), '{"a":[1,2]}');
  writeFileSync(join(dir, "bad.json"), "{nope");
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseArgs: values", () => {
  it("accepts --x v and --x=v", () => {
    expect(parseArgs(["--title", "a b"], SPECS).flags.title).toBe("a b");
    expect(parseArgs(["--title=a=b"], SPECS).flags.title).toBe("a=b");
    expect(parseArgs(["--title="], SPECS).flags.title).toBe("");
  });

  it("collects repeated array flags in order, mixing both forms", () => {
    const parsed = parseArgs(["--tag", "a", "--tag=b", "--tag", "c"], SPECS);
    expect(parsed.flags.tag).toEqual(["a", "b", "c"]);
  });

  it("leaves absent flags out entirely", () => {
    const parsed = parseArgs([], SPECS);
    expect(Object.keys(parsed.flags)).toEqual([]);
    expect(parsed.positionals).toEqual([]);
  });

  it("last value wins for a repeated scalar flag", () => {
    expect(parseArgs(["--title", "a", "--title", "b"], SPECS).flags.title).toBe("b");
  });

  it("collects positionals around flags", () => {
    const parsed = parseArgs(["one", "--verbose", "two", "-"], SPECS);
    expect(parsed.positionals).toEqual(["one", "two", "-"]);
    expect(parsed.flags.verbose).toBe(true);
  });

  it("treats -5 as a positional and as a number value", () => {
    expect(parseArgs(["-5"], SPECS).positionals).toEqual(["-5"]);
    expect(parseArgs(["--limit", "-5"], SPECS).flags.limit).toBe(-5);
  });
});

describe("parseArgs: booleans", () => {
  it("handles --x, --no-x and explicit true/false", () => {
    expect(parseArgs(["--verbose"], SPECS).flags.verbose).toBe(true);
    expect(parseArgs(["--no-verbose"], SPECS).flags.verbose).toBe(false);
    expect(parseArgs(["--verbose=false"], SPECS).flags.verbose).toBe(false);
    expect(parseArgs(["--verbose", "--no-verbose"], SPECS).flags.verbose).toBe(false);
  });

  it("does not eat the next token as a value", () => {
    const parsed = parseArgs(["--verbose", "word"], SPECS);
    expect(parsed.flags.verbose).toBe(true);
    expect(parsed.positionals).toEqual(["word"]);
  });

  it("rejects --no-x for a non-boolean, --no-x=v and a junk boolean value", () => {
    expect(usageMessage(["--no-title"])).toContain("--no-title");
    expect(usageMessage(["--no-verbose=1"])).toContain("--no-verbose");
    expect(usageMessage(["--verbose=maybe"])).toContain("--verbose");
  });

  it("maps -h and -v to --help and --version when those flags exist", () => {
    expect(parseArgs(["-h"], SPECS).flags.help).toBe(true);
    expect(parseArgs(["-v"], SPECS).flags.version).toBe(true);
    expect(usageMessage(["-h"], [])).toContain("-h");
  });
});

describe("parseArgs: numbers", () => {
  it("parses integers and decimals", () => {
    expect(parseArgs(["--limit", "10"], SPECS).flags.limit).toBe(10);
    expect(parseArgs(["--limit=2.5"], SPECS).flags.limit).toBe(2.5);
    expect(parseArgs(["--limit=0"], SPECS).flags.limit).toBe(0);
  });

  it.each(["abc", "", "1e3", "0x10", "1,5", "Infinity", "NaN", "9".repeat(400)])("rejects %j", (value) => {
    expect(usageMessage([`--limit=${value}`])).toContain("--limit");
  });
});

describe("parseArgs: unknown and value-less flags", () => {
  it("names the unknown flag, without its value", () => {
    expect(usageMessage(["--nope"])).toBe("Unknown flag --nope");
    expect(usageMessage(["--nope=jba_FAKEFAKEFAKEFAKEFAKE"])).toBe("Unknown flag --nope");
    expect(usageMessage(["-x"])).toBe("Unknown flag -x");
    expect(usageMessage(["--=x"])).toContain("Unknown flag");
  });

  it("does not echo a key that was typed as a flag name", () => {
    expect(usageMessage(["--jba_FAKEFAKEFAKEFAKEFAKE"])).not.toContain("FAKEFAKE");
  });

  it("rejects a value-less string flag at the end, before another flag and before --", () => {
    expect(usageMessage(["--title"])).toContain("--title needs a value");
    expect(usageMessage(["--title", "--verbose"])).toContain("--title needs a value");
    expect(usageMessage(["--title", "--"])).toContain("--title needs a value");
    expect(usageMessage(["--tag"])).toContain("--tag needs a value");
    expect(usageMessage(["--limit"])).toContain("--limit needs a value");
    expect(usageMessage(["--json"])).toContain("--json needs a value");
  });

  it("lets a value that starts with -- be written with =", () => {
    expect(parseArgs(["--title=--odd"], SPECS).flags.title).toBe("--odd");
  });
});

describe("parseArgs: -- terminator", () => {
  it("ends flag parsing", () => {
    const parsed = parseArgs(["--verbose", "--", "--title", "-x", "--"], SPECS);
    expect(parsed.flags).toEqual({ verbose: true });
    expect(parsed.positionals).toEqual(["--title", "-x", "--"]);
  });
});

describe("parseArgs: --json", () => {
  it("parses inline JSON", () => {
    expect(parseArgs(["--json", '{"a":1}'], SPECS).flags.json).toEqual({ a: 1 });
    expect(parseArgs(['--json=[1,"x"]'], SPECS).flags.json).toEqual([1, "x"]);
  });

  it("reads @file", () => {
    expect(parseArgs(["--json", `@${join(dir, "data.json")}`], SPECS).flags.json).toEqual({ a: [1, 2] });
  });

  it("reads stdin for -", () => {
    expect(parseArgs(["--json", "-"], SPECS, { readStdin: stdinOf('{"from":"stdin"}\n') }).flags.json).toEqual({ from: "stdin" });
  });

  it("rejects invalid JSON without echoing it", () => {
    const message = usageMessage(["--json", '{"secret":"jba_FAKE_KEY_123"']);
    expect(message).toBe("Flag --json is not valid JSON.");
    expect(usageMessage(["--json", `@${join(dir, "bad.json")}`])).toBe("Flag --json is not valid JSON.");
  });

  it("rejects a missing file, a directory and a lone @", () => {
    expect(usageMessage(["--json", `@${join(dir, "missing.json")}`])).toContain("Cannot read");
    expect(usageMessage(["--json", `@${dir}`])).toContain("not a regular file");
    expect(usageMessage(["--json", "@"])).toContain("needs a file path");
  });
});

describe("parseArgs: --x-file", () => {
  it("reads a string flag from a file, verbatim", () => {
    expect(parseArgs(["--description-file", join(dir, "body.md")], SPECS).flags.description).toBe("line one\nline two\n");
  });

  it("reads from stdin for -", () => {
    expect(parseArgs(["--description-file", "-"], SPECS, { readStdin: stdinOf("from stdin") }).flags.description).toBe("from stdin");
  });

  it("parses a json flag's file", () => {
    expect(parseArgs([`--payload-file=${join(dir, "data.json")}`], SPECS).flags.payload).toEqual({ a: [1, 2] });
  });

  it("is unknown when the spec does not opt in", () => {
    expect(usageMessage(["--title-file", join(dir, "body.md")])).toBe("Unknown flag --title-file");
  });

  it("refuses --x together with --x-file", () => {
    expect(usageMessage(["--description", "a", "--description-file", join(dir, "body.md")])).toContain("not both");
  });

  it("reads stdin for only one flag", () => {
    const message = usageMessage(["--description-file", "-", "--json", "-"], SPECS, stdinOf("{}"));
    expect(message).toContain("only one flag");
  });

  it("rejects non-UTF-8 content and an unreadable path", () => {
    expect(usageMessage(["--description-file", join(dir, "binary.bin")])).toContain("not valid UTF-8");
    expect(usageMessage(["--description-file", join(dir, "nope.txt")])).toContain("Cannot read");
  });

  it("names the -file flag when its value is missing", () => {
    expect(usageMessage(["--description-file"])).toContain("--description-file needs a value");
  });
});

describe("GLOBAL_FLAGS", () => {
  it("are exactly workspace, agent, pretty, yes, help, version", () => {
    expect(GLOBAL_FLAGS.map((spec) => `${spec.name}:${spec.type}`)).toEqual([
      "workspace:string",
      "agent:string",
      "pretty:boolean",
      "yes:boolean",
      "help:boolean",
      "version:boolean",
    ]);
  });
});
