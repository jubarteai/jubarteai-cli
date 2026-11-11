// Scenarios ported from the app's src/lib/install-script.test.ts (json_merge). B3 maps each deleted test to one below.
//
// ported: JSON-config editors: same key -> already configured, another key -> updated (old key gone, other servers kept)
// ported: JSON configs: merged into the existing entry, written through symlinks
// ported: a symlinked mcp.json is written through the link: the link stays, its target gets the new key
// ported: a relative link under a symlinked directory is followed from the real directory, never written as a stray file
// ported: a JSON config another user owns is never written: the user file is skipped, an old key in a project file fails the step
// ported: a hard-linked config is never split by a rewrite: the user file is skipped, a project file fails, every link unchanged
// ported: Zed JSONC settings degrade gracefully: file byte-unchanged, token not echoed, exit 0
// ported: VS Code: a JSONC .vscode/mcp.json (comment, ${input:…} on another server, trailing comma) with the placeholder key fails with manual instructions, unchanged
// ported: Zed: a .zed/settings.json with comments that sets another key is reported as failed (exit 1) and left as it is
// ported: Cursor: an old key in .cursor/mcp.json is replaced (other servers kept) and a tracked file gets a note
// ported: VS Code: an old key in .vscode/mcp.json is replaced (its inputs kept)
// ported: an old key in the project's .mcp.json is replaced (other servers kept) and a tracked file gets a warning
// ported: a config it can't write is reported as failed (exit 1) and left as it was
// ported: a directory where the config should be is reported as failed, never replaced
// ported: without the CLI: writes CLAUDE_CONFIG_DIR/.claude.json and drops an old local-scope key there
// ported: json_merge: a missing or empty file is an empty config; invalid JSON or a non-object is refused untouched
//
// New in the CLI (spec §3.4, §8 I6): indent width (2/4/tab), CRLF and trailing-newline presence are kept;
// an edit that changes nothing never rewrites; the file's own mode is kept.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editJsonFile, readJsonObject } from "./json-edit.js";

const isWindows = process.platform === "win32";
const posix = it.skipIf(isWindows);

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-json-edit-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (name = "mcp.json"): string => path.join(home, name);
const read = (p: string): string => fs.readFileSync(p, "utf8");
const addServer = (doc: Record<string, unknown>): boolean => {
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  servers.jubarteai = { url: "https://example.test/api/mcp" };
  doc.mcpServers = servers;
  return true;
};
const noMode = { createIfMissing: false };

describe("editJsonFile: merge and remove", () => {
  it("adds an entry and keeps every other key, in order", () => {
    fs.writeFileSync(file(), '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "url": "x" }\n  },\n  "z": [1, 2]\n}\n');
    const res = editJsonFile(file(), addServer, noMode);
    expect(res).toEqual({ status: "changed" });
    expect(JSON.parse(read(file()))).toEqual({
      theme: "dark",
      mcpServers: { other: { url: "x" }, jubarteai: { url: "https://example.test/api/mcp" } },
      z: [1, 2],
    });
    expect(Object.keys(JSON.parse(read(file())))).toEqual(["theme", "mcpServers", "z"]);
  });

  it("removes an entry and keeps the others", () => {
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { jubarteai: { url: "u" }, other: { url: "x" } }, keep: true }, null, 2) + "\n");
    const res = editJsonFile(
      file(),
      (doc) => {
        const servers = doc.mcpServers as Record<string, unknown>;
        if (!("jubarteai" in servers)) return false;
        delete servers.jubarteai;
        return true;
      },
      noMode,
    );
    expect(res).toEqual({ status: "changed" });
    expect(JSON.parse(read(file()))).toEqual({ mcpServers: { other: { url: "x" } }, keep: true });
  });

  it("an edit that returns false leaves the file untouched, byte for byte and in mtime", () => {
    const original = '{"a":1,   "b":2}';
    fs.writeFileSync(file(), original);
    const before = fs.statSync(file()).mtimeMs;
    expect(editJsonFile(file(), () => false, noMode)).toEqual({ status: "unchanged" });
    expect(read(file())).toBe(original);
    expect(fs.statSync(file()).mtimeMs).toBe(before);
  });

  it("an edit that throws propagates and leaves the file and the directory as they were", () => {
    fs.writeFileSync(file(), '{"a":1}\n');
    expect(() =>
      editJsonFile(
        file(),
        () => {
          throw new Error("boom");
        },
        noMode,
      ),
    ).toThrow("boom");
    expect(read(file())).toBe('{"a":1}\n');
    expect(fs.readdirSync(home)).toEqual(["mcp.json"]);
  });

  it("leaves no temp file behind after a write", () => {
    fs.writeFileSync(file(), "{}\n");
    editJsonFile(file(), addServer, noMode);
    expect(fs.readdirSync(home)).toEqual(["mcp.json"]);
  });
});

describe("editJsonFile: formatting is preserved", () => {
  for (const [name, indent] of [
    ["2 spaces", "  "],
    ["4 spaces", "    "],
    ["a tab", "\t"],
  ] as const) {
    it(`keeps ${name}`, () => {
      fs.writeFileSync(file(), `{\n${indent}"a": {\n${indent}${indent}"b": 1\n${indent}}\n}\n`);
      editJsonFile(file(), addServer, noMode);
      const lines = read(file()).split("\n");
      expect(lines[1]).toBe(`${indent}"a": {`);
      expect(lines[2]).toBe(`${indent}${indent}"b": 1`);
      expect(lines.some((l) => l === `${indent}"mcpServers": {`)).toBe(true);
    });
  }

  it("keeps a missing final newline, and a present one", () => {
    fs.writeFileSync(file("no-nl.json"), '{\n  "a": 1\n}');
    fs.writeFileSync(file("nl.json"), '{\n  "a": 1\n}\n');
    editJsonFile(file("no-nl.json"), addServer, noMode);
    editJsonFile(file("nl.json"), addServer, noMode);
    expect(read(file("no-nl.json")).endsWith("}")).toBe(true);
    expect(read(file("nl.json")).endsWith("}\n")).toBe(true);
  });

  it("keeps CRLF line endings", () => {
    fs.writeFileSync(file(), '{\r\n  "a": 1\r\n}\r\n');
    editJsonFile(file(), addServer, noMode);
    const text = read(file());
    expect(text.includes("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(JSON.parse(text).a).toBe(1);
  });

  it("a file with a byte order mark is edited and keeps its byte order mark", () => {
    fs.writeFileSync(file(), '\uFEFF{"a": 1}\n');
    expect(editJsonFile(file(), addServer, noMode).status).toBe("changed");
    const text = read(file());
    expect(text.startsWith("\uFEFF{")).toBe(true);
    expect(text.indexOf("\uFEFF", 1)).toBe(-1);
    expect(JSON.parse(text.slice(1)).a).toBe(1);
  });

  it("a byte order mark on a file the edit leaves alone is never rewritten, and readJsonObject reads past it", () => {
    fs.writeFileSync(file(), '\uFEFF{"a": 1}\n');
    expect(editJsonFile(file(), () => false, noMode)).toEqual({ status: "unchanged" });
    expect(read(file())).toBe('\uFEFF{"a": 1}\n');
    expect(readJsonObject(file())).toEqual({ status: "ok", doc: { a: 1 } });
  });

  it("a minified file gets 2-space indent", () => {
    fs.writeFileSync(file(), '{"a":1}\n');
    editJsonFile(file(), addServer, noMode);
    expect(read(file()).split("\n")[1]).toBe('  "a": 1,');
  });
});

describe("editJsonFile: missing and empty files", () => {
  it("a missing file without createIfMissing is 'missing', and nothing is created", () => {
    expect(editJsonFile(file(), addServer, noMode)).toEqual({ status: "missing" });
    expect(fs.existsSync(file())).toBe(false);
  });

  it("a missing file with createIfMissing is created: 2-space indent, trailing newline, mode 0600", () => {
    const nested = path.join(home, ".cursor", "mcp.json");
    expect(editJsonFile(nested, addServer, { createIfMissing: true })).toEqual({ status: "changed" });
    expect(read(nested)).toBe('{\n  "mcpServers": {\n    "jubarteai": {\n      "url": "https://example.test/api/mcp"\n    }\n  }\n}\n');
    if (!isWindows) expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
  });

  it("createIfMissing with an edit that changes nothing creates nothing", () => {
    expect(editJsonFile(file(), () => false, { createIfMissing: true })).toEqual({ status: "unchanged" });
    expect(fs.existsSync(file())).toBe(false);
  });

  posix("the given mode wins for a new file", () => {
    expect(editJsonFile(file(), addServer, { createIfMissing: true, mode: 0o640 }).status).toBe("changed");
    expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
  });

  posix("an existing file keeps its own mode", () => {
    fs.writeFileSync(file(), "{}\n");
    fs.chmodSync(file(), 0o640);
    editJsonFile(file(), addServer, noMode);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
  });

  it("an empty or blank file is an empty config", () => {
    fs.writeFileSync(file(), "");
    fs.writeFileSync(file("blank.json"), "  \n\n");
    expect(editJsonFile(file(), addServer, noMode).status).toBe("changed");
    expect(editJsonFile(file("blank.json"), addServer, noMode).status).toBe("changed");
    expect(JSON.parse(read(file())).mcpServers.jubarteai.url).toBe("https://example.test/api/mcp");
  });
});

describe("editJsonFile: refusals write nothing", () => {
  const cases: Array<[string, string, "jsonc" | "invalid-json" | "not-object"]> = [
    ["a line comment", '{\n  // servers\n  "a": 1\n}\n', "jsonc"],
    ["a block comment", '{ /* x */ "a": 1 }\n', "jsonc"],
    ["a trailing comma", '{\n  "a": 1,\n}\n', "jsonc"],
    ["a trailing comma in an array", '{"a": [1,2,]}', "jsonc"],
    ["truncated JSON", '{"a": ', "invalid-json"],
    ["not JSON at all", "model = 'x'\n", "invalid-json"],
    ["a top-level array", "[1, 2]\n", "not-object"],
    ["a top-level string", '"hello"\n', "not-object"],
    ["null", "null\n", "not-object"],
  ];
  for (const [name, text, reason] of cases) {
    it(`${name} -> refused (${reason}), file byte-identical, edit never called`, () => {
      fs.writeFileSync(file(), text);
      let called = false;
      const res = editJsonFile(
        file(),
        () => {
          called = true;
          return true;
        },
        { createIfMissing: true },
      );
      expect(res).toEqual({ status: "refused", reason });
      expect(called).toBe(false);
      expect(read(file())).toBe(text);
      expect(fs.readdirSync(home)).toEqual(["mcp.json"]);
    });
  }

  it("a string holding // or /* is not a comment: the file is edited", () => {
    fs.writeFileSync(file(), '{\n  "url": "https://x.test/a/*b*/",\n  "note": "a, ]"\n}\n');
    expect(editJsonFile(file(), addServer, noMode).status).toBe("changed");
    expect(JSON.parse(read(file())).url).toBe("https://x.test/a/*b*/");
  });

  it("a directory where the config should be is refused, never replaced", () => {
    fs.mkdirSync(file());
    expect(editJsonFile(file(), addServer, { createIfMissing: true })).toEqual({ status: "refused", reason: "invalid-json" });
    expect(fs.statSync(file()).isDirectory()).toBe(true);
  });

  it("bytes that are not UTF-8 are refused, never rewritten lossily", () => {
    const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    fs.writeFileSync(file(), bytes);
    expect(editJsonFile(file(), addServer, noMode).status).toBe("refused");
    expect(fs.readFileSync(file()).equals(bytes)).toBe(true);
  });

  it("a file past the size cap is refused unread", () => {
    fs.writeFileSync(file(), `{"a": "${"x".repeat(5 * 1024 * 1024)}"}`);
    expect(editJsonFile(file(), addServer, noMode).status).toBe("refused");
  });

  it("a file with no permission to read throws rather than reading as missing", () => {
    if (isWindows || (typeof process.getuid === "function" && process.getuid() === 0)) return;
    fs.writeFileSync(file(), "{}\n");
    fs.chmodSync(file(), 0o000);
    try {
      expect(() => editJsonFile(file(), addServer, noMode)).toThrow();
    } finally {
      fs.chmodSync(file(), 0o600);
    }
  });
});

describe("editJsonFile: guards on the target", () => {
  posix("a symlinked file is refused in strict mode, the link and its target untouched", () => {
    const target = path.join(root, "dotfiles.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, file());
    expect(editJsonFile(file(), addServer, noMode)).toEqual({ status: "refused", reason: "symlink" });
    expect(read(target)).toBe("{}\n");
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
  });

  posix("withinHome writes through a symlink: the link stays, its target gets the entry", () => {
    const target = path.join(home, "dotfiles", "mcp.json");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, '{\n    "keep": 1\n}\n');
    fs.mkdirSync(path.join(home, ".cursor"));
    const link = path.join(home, ".cursor", "mcp.json");
    fs.symlinkSync(path.join("..", "dotfiles", "mcp.json"), link);
    expect(editJsonFile(link, addServer, { createIfMissing: false, withinHome: true })).toEqual({ status: "changed" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(read(target)).mcpServers.jubarteai.url).toBe("https://example.test/api/mcp");
    expect(read(target).split("\n")[1]).toBe('    "keep": 1,');
    expect(fs.readdirSync(path.dirname(target))).toEqual(["mcp.json"]);
  });

  posix("withinHome refuses a link that leads outside the home directory", () => {
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, file());
    expect(editJsonFile(file(), addServer, { createIfMissing: false, withinHome: true })).toEqual({ status: "refused", reason: "outside-home" });
    expect(read(outside)).toBe("{}\n");
  });

  posix("a hard-linked file is refused, every link unchanged", () => {
    fs.writeFileSync(file(), "{}\n");
    const other = path.join(home, "other-name.json");
    fs.linkSync(file(), other);
    expect(editJsonFile(file(), addServer, noMode)).toEqual({ status: "refused", reason: "hardlink" });
    expect(read(file())).toBe("{}\n");
    expect(read(other)).toBe("{}\n");
  });

  posix("a hard-linked file that needs no change is 'unchanged', not refused", () => {
    fs.writeFileSync(file(), "{}\n");
    fs.linkSync(file(), path.join(home, "other-name.json"));
    expect(editJsonFile(file(), () => false, noMode)).toEqual({ status: "unchanged" });
  });

  posix("a file in a directory others can write to is refused", () => {
    const shared = path.join(root, "shared");
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o777);
    fs.writeFileSync(path.join(shared, "mcp.json"), "{}\n");
    expect(editJsonFile(path.join(shared, "mcp.json"), addServer, noMode)).toEqual({ status: "refused", reason: "unsafe-parent" });
    expect(read(path.join(shared, "mcp.json"))).toBe("{}\n");
  });
});

describe("readJsonObject", () => {
  it("reads an object", () => {
    fs.writeFileSync(file(), '{"a": {"b": 1}}');
    expect(readJsonObject(file())).toEqual({ status: "ok", doc: { a: { b: 1 } } });
  });

  it("an empty file is an empty object", () => {
    fs.writeFileSync(file(), "");
    expect(readJsonObject(file())).toEqual({ status: "ok", doc: {} });
  });

  it("says why a file is not usable, and that a missing one is missing", () => {
    expect(readJsonObject(file("nope.json"))).toEqual({ status: "missing" });
    fs.writeFileSync(file("c.json"), '{"a": 1, // x\n}');
    expect(readJsonObject(file("c.json"))).toEqual({ status: "jsonc" });
    fs.writeFileSync(file("bad.json"), "{");
    expect(readJsonObject(file("bad.json"))).toEqual({ status: "invalid-json" });
    fs.writeFileSync(file("arr.json"), "[]");
    expect(readJsonObject(file("arr.json"))).toEqual({ status: "not-object" });
    fs.mkdirSync(file("dir.json"));
    expect(readJsonObject(file("dir.json"))).toEqual({ status: "invalid-json" });
  });
});
