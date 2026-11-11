// Scenarios ported from the app's src/lib/install-script.test.ts (the Codex [mcp_servers.jubarteai] table, codex_toml).
// B3 maps each deleted test to one below. The codex_toml awk rewrote the table's url and Authorization header in one
// pass; here the table and key edits are the primitives (the Codex adapter composes them), so the scenarios that are
// about http_headers being an inline table are tested where the adapter is.
//
// ported: Codex: the [mcp_servers.jubarteai] table: same key: file left byte-identical, reported as already configured
// ported: Codex: the [mcp_servers.jubarteai] table: another key: only url and http_headers change in place; the rest of the table, its sub-tables and the file are kept, mode 0600
// ported: Codex: the [mcp_servers.jubarteai] table: repeated key changes don't pile up blank lines or duplicate the table
// ported: Codex: a CRLF file: another key is replaced in place (one table, CRLF kept, the rest byte for byte), the same key is left alone
// ported: Codex: a header spelled [ mcp_servers.jubarteai ] / [mcp_servers."jubarteai"] / [mcp_servers . jubarteai] is the same table: its key replaced in place, never duplicated
// ported: Codex: jubarteai set as an inline table / dotted keys under [mcp_servers] / dotted keys at the top level / plus an http_headers sub-table: left untouched, never appended to
// ported: Codex: a symlinked config.toml is rewritten through the link: the link stays, its target gets the new key
// ported: Codex: headers that quote #, "," or "=" and the comments between tables survive a rewrite
// ported: Codex: a stdio jubarteai is replaced whole, and the comments before the next table stay with it
// ported: Codex: a header-looking line inside a multi-line string or array is not a table
// ported: Codex: the rest of the table is kept: enabled, timeouts, enabled_tools, comments and the http_headers table's other headers; an old bearer_token goes
// ported: Codex: a file starting with a UTF-8 byte order mark: its table is updated in place, never appended a second time
// ported: Codex: an escaped quote before """ in a multi-line string never ends it early: the table after it is found, not appended again
// ported: Codex: a url spread over several lines is left alone (here: its table is found and the key replaced as one statement)
// ported: fresh Codex install: appends a block with http_headers and sets file mode 0600
// ported: Codex: an old key in .codex/config.toml is replaced in place
// ported: Codex: a .codex/config.toml that reads the key from the environment gets a note; one set inline with another key fails
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTomlFile, getTomlTable, readTomlKey, removeTomlTable, setTomlKey, TomlConflictError } from "./toml-edit.js";

const T = "mcp_servers.jubarteai";
const URL_A = "https://example.test/api/mcp";
const URL_B = "https://other.test/api/mcp";
const block = (url: string): string => `[mcp_servers.jubarteai]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer jba_FAKEFAKE" }\n`;
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
const set = (text: string, table: string, key: string, value: string | boolean | number): string => setTomlKey(text, table, key, value).text;

describe("getTomlTable", () => {
  it("finds a table: its header offset, the end of its last key, and the body between", () => {
    const text = `model = "o3"\n\n${block(URL_A)}\n[profiles.fast]\nx = 1\n`;
    const got = getTomlTable(text, T);
    expect(got).not.toBeNull();
    expect(text.slice(got?.start, got?.end)).toBe(block(URL_A));
    expect(got?.body).toBe(`url = "${URL_A}"\nhttp_headers = { "Authorization" = "Bearer jba_FAKEFAKE" }\n`);
  });

  it("returns null when the table is absent, including a table that only shares the prefix", () => {
    expect(getTomlTable('[mcp_servers.jubarteai2]\nurl = "x"\n', T)).toBeNull();
    expect(getTomlTable('[mcp_servers]\njubarteai = "x"\n', T)).toBeNull();
    expect(getTomlTable("", T)).toBeNull();
  });

  it("trailing comments and blank lines belong to what follows, not the table", () => {
    const text = "[a]\nx = 1\n# about b\n\n[b]\ny = 2\n";
    const got = getTomlTable(text, "a");
    expect(text.slice(got?.start, got?.end)).toBe("[a]\nx = 1\n");
  });

  for (const header of ["[ mcp_servers.jubarteai ]", '[mcp_servers."jubarteai"]', "[mcp_servers . jubarteai]", "['mcp_servers'.'jubarteai']", "[mcp_servers.jubarteai] # hand set"]) {
    it(`a header spelled ${header} is the same table`, () => {
      expect(getTomlTable(`${header}\nurl = "x"\n`, T)?.body).toBe('url = "x"\n');
    });
  }

  it("a header-looking line inside a multi-line string or array is not a table", () => {
    const notes = '[notes]\ntext = """\n[mcp_servers.jubarteai]\nurl = "x"\n"""\nlist = [\n  ["a"],\n  [mcp_servers.jubarteai]\n]\n';
    expect(getTomlTable(notes, T)).toBeNull();
    expect(getTomlTable(notes, "notes")?.body).toBe('text = """\n[mcp_servers.jubarteai]\nurl = "x"\n"""\nlist = [\n  ["a"],\n  [mcp_servers.jubarteai]\n]\n');
  });

  it("headers quoting #, ',' , '=' or '.' are read as one key, and addressed by a quoted segment", () => {
    const text = '# my C# app\n[projects."/Users/me/C#/app"]\ntrust_level = "trusted"\n\n[projects.\'/srv/k=v # x,y.z\']\nz = 1\n';
    expect(getTomlTable(text, T)).toBeNull();
    expect(getTomlTable(text, 'projects."/Users/me/C#/app"')?.body).toBe('trust_level = "trusted"\n');
    expect(getTomlTable(text, `projects.'/srv/k=v # x,y.z'`)?.body).toBe("z = 1\n");
    expect(getTomlTable(text, "projects.srv")).toBeNull();
  });

  it("a table name that is not TOML key syntax is rejected", () => {
    expect(() => getTomlTable("", "a b")).toThrow(RangeError);
    expect(() => setTomlKey("", "", "k", 1)).toThrow(RangeError);
    expect(() => removeTomlTable("", "")).toThrow(RangeError);
  });

  it("a file starting with a byte order mark: the first header is still found", () => {
    const text = `\uFEFF${block(URL_A)}`;
    const got = getTomlTable(text, T);
    expect(got?.start).toBe(0);
    expect(got?.body.startsWith("url =")).toBe(true);
  });

  it("works with CRLF", () => {
    const text = crlf(`${block(URL_A)}\n[b]\nx = 1\n`);
    expect(getTomlTable(text, T)?.body).toBe(crlf(`url = "${URL_A}"\nhttp_headers = { "Authorization" = "Bearer jba_FAKEFAKE" }\n`));
  });

  it("an escaped quote before \"\"\" in a multi-line string never ends it early", () => {
    for (const text of [
      'notes = """one line \\""" with quotes"""\n',
      'notes = """\nfirst \\"""\nsecond\n"""\n',
      'notes = """ends in quotes"""""\n',
      "notes = '''literal \\'''\n",
    ]) {
      const all = `[profiles.fast]\n${text}\n${block(URL_A)}`;
      expect(getTomlTable(all, T)?.body, text).toBe(`url = "${URL_A}"\nhttp_headers = { "Authorization" = "Bearer jba_FAKEFAKE" }\n`);
      expect(getTomlTable(all, "profiles.fast")?.body, text).toBe(text);
    }
  });

  it("a multi-line string that spans a header-like line and closes on the same line as a key", () => {
    const text = 'a = """\n[x]\n""" # done\n[y]\nk = 1\n';
    expect(getTomlTable(text, "x")).toBeNull();
    expect(getTomlTable(text, "y")?.body).toBe("k = 1\n");
  });
});

describe("removeTomlTable", () => {
  it("removes the table and its sub-tables, and nothing else", () => {
    const text = `model = "o3"\n\n[mcp_servers.jubarteai]\nurl = "x"\n\n[mcp_servers.jubarteai.env]\nX = "1"\n\n[profiles.fast]\nargs = [\n  ["a"],\n]\n`;
    const res = removeTomlTable(text, T);
    expect(res).toEqual({ text: `model = "o3"\n\n[profiles.fast]\nargs = [\n  ["a"],\n]\n`, changed: true });
  });

  it("removes sub-tables that are not next to the main table, and array-of-tables sub-tables", () => {
    const text = '[mcp_servers.jubarteai]\nurl = "x"\n\n[other]\na = 1\n\n[mcp_servers.jubarteai.http_headers]\nA = "b"\n\n[[mcp_servers.jubarteai.rules]]\nr = 1\n';
    expect(removeTomlTable(text, T).text).toBe("[other]\na = 1\n");
  });

  it("does not touch a table that only shares a prefix of the name", () => {
    const text = '[mcp_servers.jubarteai2]\nurl = "x"\n\n[mcp_servers.jubarteai-old]\nurl = "y"\n\n[mcp_servers]\nz = 1\n';
    expect(removeTomlTable(text, T)).toEqual({ text, changed: false });
  });

  it("comments just before the next table stay with that table, and blank lines don't pile up", () => {
    const text = '[mcp_servers.jubarteai]\ncommand = "npx"\nargs = ["mcp-remote"]\n\n[mcp_servers.jubarteai.env]\nA = "1"\n\n# my C# app\n[projects."/C#/app"]\nx = 1\n';
    expect(removeTomlTable(text, T).text).toBe('# my C# app\n[projects."/C#/app"]\nx = 1\n');
  });

  it("a table at the end takes the blank lines before it along, leaving one final newline", () => {
    expect(removeTomlTable(`a = 1\n\n\n${block(URL_A)}`, T).text).toBe("a = 1\n");
    expect(removeTomlTable(block(URL_A), T).text).toBe("");
  });

  it("a table in the middle leaves exactly one blank line between its neighbours", () => {
    expect(removeTomlTable(`[a]\nx = 1\n\n${block(URL_A)}\n[b]\ny = 2\n`, T).text).toBe("[a]\nx = 1\n\n[b]\ny = 2\n");
  });

  it("a table without a final newline", () => {
    expect(removeTomlTable('a = 1\n\n[mcp_servers.jubarteai]\nurl = "x"', T).text).toBe("a = 1\n");
  });

  it("is a no-op when the table is absent", () => {
    const text = 'a = 1\n# c\n[b]\nx = "y"\n';
    expect(removeTomlTable(text, T)).toEqual({ text, changed: false });
  });

  it("keeps CRLF and a byte order mark", () => {
    const text = `\uFEFFmodel = "o3"\r\n\r\n${crlf(block(URL_A))}\r\n[b]\r\nx = 1\r\n`;
    expect(removeTomlTable(text, T).text).toBe('\uFEFFmodel = "o3"\r\n\r\n[b]\r\nx = 1\r\n');
  });

  for (const [form, text] of [
    ["an inline table under [mcp_servers]", `[mcp_servers]\njubarteai = { url = "${URL_A}" }\n`],
    ["dotted keys under [mcp_servers]", `[mcp_servers]\njubarteai.url = "${URL_A}"\n`],
    ["dotted keys at the top level", `mcp_servers.jubarteai.url = "${URL_A}"\n`],
    ["dotted keys at the top level plus a sub-table", `mcp_servers.jubarteai.url = "${URL_A}"\n\n[mcp_servers.jubarteai.http_headers]\nAuthorization = "x"\n`],
    ["an inline mcp_servers table", `mcp_servers = { jubarteai = { url = "${URL_A}" } }\n`],
  ] as const) {
    it(`throws TomlConflictError for jubarteai set as ${form}`, () => {
      expect(() => removeTomlTable(text, T)).toThrow(TomlConflictError);
      expect(() => setTomlKey(text, T, "url", URL_B)).toThrow(TomlConflictError);
    });
  }
});

describe("setTomlKey", () => {
  it("appends the table when it is absent: blank line before it, final newline, key quoted per TOML", () => {
    expect(setTomlKey('model = "o3"\n', T, "url", URL_A)).toEqual({ text: `model = "o3"\n\n[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`, changed: true });
    expect(set("", T, "url", URL_A)).toBe(`[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`);
    expect(set('model = "o3"', T, "url", URL_A)).toBe(`model = "o3"\n\n[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`);
    expect(set('model = "o3"\n\n\n', T, "url", URL_A)).toBe(`model = "o3"\n\n\n[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`);
  });

  it("quotes a key or table segment that is not a bare key", () => {
    expect(set("", 'a."b c"', "k e y", "v")).toBe('[a."b c"]\n"k e y" = "v"\n');
    expect(set("", 'projects."/Users/me/C#/app"', "trust_level", "trusted")).toBe('[projects."/Users/me/C#/app"]\ntrust_level = "trusted"\n');
    expect(set('[a."b c"]\nx = 1\n', 'a."b c"', "x", 2)).toBe('[a."b c"]\nx = 2\n');
  });

  it("replaces a value in place: the rest of the table, its sub-tables, its comments and the file stay byte for byte", () => {
    const before = `model = "o3"\n\n[mcp_servers.jubarteai]   # set up by hand\nurl = "https://old.test/mcp"  # the endpoint\nhttp_headers = { "Authorization" = "Bearer OLDTOKEN" }\n\n[mcp_servers.jubarteai.env]\nX = "1"\n\n[profiles.fast]\nargs = [\n  ["a"],\n]\n`;
    const after = before.replace("https://old.test/mcp", URL_A);
    expect(setTomlKey(before, T, "url", URL_A)).toEqual({ text: after, changed: true });
  });

  it("the same value is left alone, whatever its quoting", () => {
    const text = `[mcp_servers.jubarteai]\nurl='${URL_A}'\nenabled = true\ntimeout = 30\n`;
    expect(setTomlKey(text, T, "url", URL_A)).toEqual({ text, changed: false });
    expect(setTomlKey(text, T, "enabled", true)).toEqual({ text, changed: false });
    expect(setTomlKey(text, T, "timeout", 30)).toEqual({ text, changed: false });
  });

  it("changing a boolean, a number and a literal string in place", () => {
    const text = "[sandbox_workspace_write]\nnetwork_access = false  # off\nlimit = 5\nname = 'x'\n";
    expect(set(text, "sandbox_workspace_write", "network_access", true)).toBe("[sandbox_workspace_write]\nnetwork_access = true  # off\nlimit = 5\nname = 'x'\n");
    expect(set(text, "sandbox_workspace_write", "limit", 12.5)).toBe("[sandbox_workspace_write]\nnetwork_access = false  # off\nlimit = 12.5\nname = 'x'\n");
    expect(set(text, "sandbox_workspace_write", "name", "y")).toBe('[sandbox_workspace_write]\nnetwork_access = false  # off\nlimit = 5\nname = "y"\n');
  });

  it("adds a missing key after the table's last key, before its sub-tables and the comments that belong to the next table", () => {
    const text = `[mcp_servers.jubarteai]\nurl = "${URL_A}"\n\n[mcp_servers.jubarteai.env]\nX = "1"\n\n# next\n[other]\nz = 1\n`;
    expect(set(text, T, "enabled", true)).toBe(`[mcp_servers.jubarteai]\nurl = "${URL_A}"\nenabled = true\n\n[mcp_servers.jubarteai.env]\nX = "1"\n\n# next\n[other]\nz = 1\n`);
  });

  it("adds a key to an empty table, and to the last table of a file with no final newline", () => {
    expect(set("[t]\n\n[u]\nk = 1\n", "t", "a", 1)).toBe("[t]\na = 1\n\n[u]\nk = 1\n");
    expect(set("[t]\nk = 1", "t", "a", 1)).toBe("[t]\nk = 1\na = 1\n");
    expect(set("[t]", "t", "a", 1)).toBe("[t]\na = 1\n");
  });

  it("keeps CRLF in the lines it adds", () => {
    const text = crlf(`model = "o3"\n\n${block("https://old.test/mcp")}\n[profiles.fast]\nx = 1\n`);
    expect(set(text, T, "url", URL_A)).toBe(crlf(`model = "o3"\n\n${block(URL_A)}\n[profiles.fast]\nx = 1\n`));
    expect(set(crlf("[t]\nk = 1\n"), "t", "a", true)).toBe(crlf("[t]\nk = 1\na = true\n"));
    expect(set(crlf("a = 1\n"), T, "url", URL_A)).toBe(crlf(`a = 1\n\n[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`));
  });

  it("a file starting with a byte order mark: the table is updated in place, never appended a second time", () => {
    const text = `\uFEFF${block("https://old.test/mcp")}\n[profiles.fast]\nx = 1\n`;
    expect(set(text, T, "url", URL_A)).toBe(`\uFEFF${block(URL_A)}\n[profiles.fast]\nx = 1\n`);
    expect(set(`\uFEFFa = 1\n`, T, "url", URL_A).startsWith("\uFEFFa = 1\n\n[mcp_servers")).toBe(true);
  });

  it("repeated changes don't pile up blank lines or duplicate the table", () => {
    let text = `model = "o3"\n\n${block("https://v0.test/mcp")}`;
    for (const url of ["https://v1.test/mcp", "https://v2.test/mcp", URL_A]) text = set(text, T, "url", url);
    expect(text).toBe(`model = "o3"\n\n${block(URL_A)}`);
  });

  it("replaces a multi-line value as one statement, keeping the comment after it", () => {
    const text = `[mcp_servers.jubarteai]\nurl = """\n${URL_B}""" # was multi-line\nenabled = true\n`;
    expect(set(text, T, "url", URL_A)).toBe(`[mcp_servers.jubarteai]\nurl = "${URL_A}" # was multi-line\nenabled = true\n`);
    const arr = '[t]\nlist = [\n  ["a"],\n]\nk = 1\n';
    expect(set(arr, "t", "list", "x")).toBe('[t]\nlist = "x"\nk = 1\n');
  });

  it("only a key of the named table counts: the same key in another table or a sub-table is left alone", () => {
    const text = '[a]\nurl = "a"\n\n[a.b]\nurl = "ab"\n\n[c]\nurl = "c"\n';
    expect(set(text, "a", "url", "new")).toBe('[a]\nurl = "new"\n\n[a.b]\nurl = "ab"\n\n[c]\nurl = "c"\n');
    expect(set(text, "a.b", "url", "new")).toBe('[a]\nurl = "a"\n\n[a.b]\nurl = "new"\n\n[c]\nurl = "c"\n');
  });

  it("a key whose name appears inside a multi-line string is not the key", () => {
    const text = '[t]\nnotes = """\nurl = "fake"\n"""\n';
    expect(set(text, "t", "url", "real")).toBe('[t]\nnotes = """\nurl = "fake"\n"""\nurl = "real"\n');
  });

  it("escapes a value per TOML basic strings", () => {
    const tricky = 'a "quoted" \\ back\\slash\nnew\tline\u0001end\u007f';
    const out = set("", "t", "k", tricky);
    expect(out).toBe('[t]\nk = "a \\"quoted\\" \\\\ back\\\\slash\\nnew\\tline\\u0001end\\u007f"\n');
    expect(readTomlKey(out, "t", "k")).toBe(tricky);
  });

  it("refuses values TOML can't hold", () => {
    expect(() => set("", "t", "k", Number.NaN)).toThrow(RangeError);
    expect(() => set("", "t", "k", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => set("", "t", "k", "lone \uD800 surrogate")).toThrow(RangeError);
  });

  it("a string containing a newline can't escape its key line", () => {
    const out = set("", "t", "k", 'x"\n[evil]\nz = "1');
    expect(getTomlTable(out, "evil")).toBeNull();
    expect(getTomlTable(out, "t")).not.toBeNull();
  });
});

describe("readTomlKey", () => {
  const text = `top = 1\n[t]\ns = "str \\"q\\" \\u00e9"\nl = 'lit\\x'\nb = true\nf = false\ni = 1_000\nx = -2.5e3\nm = """\nmulti"""\nt = { a = 1 }\nlist = [1, 2]\n"quoted key" = "qk"\ndotted.key = "dk"\n[u]\ns = "other"\n`;

  it("reads strings, literal strings, booleans and decimal numbers", () => {
    expect(readTomlKey(text, "t", "s")).toBe('str "q" é');
    expect(readTomlKey(text, "t", "l")).toBe("lit\\x");
    expect(readTomlKey(text, "t", "b")).toBe(true);
    expect(readTomlKey(text, "t", "f")).toBe(false);
    expect(readTomlKey(text, "t", "i")).toBe(1000);
    expect(readTomlKey(text, "t", "x")).toBe(-2500);
    expect(readTomlKey(text, "t", "quoted key")).toBe("qk");
  });

  it("is null for anything it can't read as a one-line scalar, and for absent keys and tables", () => {
    expect(readTomlKey(text, "t", "m")).toBeNull();
    expect(readTomlKey(text, "t", "t")).toBeNull();
    expect(readTomlKey(text, "t", "list")).toBeNull();
    expect(readTomlKey(text, "t", "dotted")).toBeNull();
    expect(readTomlKey(text, "t", "missing")).toBeNull();
    expect(readTomlKey(text, "nope", "s")).toBeNull();
    expect(readTomlKey(text, "", "top")).toBe(1);
  });

  it("a trailing comment is not part of the value, a # inside the string is", () => {
    expect(readTomlKey('[t]\na = "x # y" # c\nb = 5 # c\n', "t", "a")).toBe("x # y");
    expect(readTomlKey('[t]\nb = 5 # c\n', "t", "b")).toBe(5);
  });

  it("reads through CRLF and a byte order mark", () => {
    expect(readTomlKey(crlf('\uFEFF[t]\na = "x"\nb = true\n'), "t", "a")).toBe("x");
    expect(readTomlKey(crlf("[t]\nb = true\n"), "t", "b")).toBe(true);
  });

  it("is the key of the named table only", () => {
    expect(readTomlKey(text, "u", "s")).toBe("other");
  });
});

describe("editTomlFile", () => {
  let root: string;
  let home: string;
  let savedHome: string | undefined;
  const isWindows = process.platform === "win32";
  const posix = it.skipIf(isWindows);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-toml-edit-")));
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

  const cfg = (): string => path.join(home, ".codex", "config.toml");
  const setUrl = (t: string): { text: string; changed: boolean } => setTomlKey(t, T, "url", URL_A);

  it("fresh install: creates the file with the table, mode 0600, directory 0700", () => {
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: true })).toEqual({ status: "changed" });
    expect(fs.readFileSync(cfg(), "utf8")).toBe(`[mcp_servers.jubarteai]\nurl = "${URL_A}"\n`);
    if (!isWindows) {
      expect(fs.statSync(cfg()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(cfg())).mode & 0o777).toBe(0o700);
    }
  });

  it("a missing file without createIfMissing is 'missing' and nothing is created", () => {
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false })).toEqual({ status: "missing" });
    expect(fs.existsSync(path.dirname(cfg()))).toBe(false);
  });

  it("same value: unchanged, file byte-identical", () => {
    fs.mkdirSync(path.dirname(cfg()));
    const original = `model = "o3"\n\n${block(URL_A)}`;
    fs.writeFileSync(cfg(), original);
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false })).toEqual({ status: "unchanged" });
    expect(fs.readFileSync(cfg(), "utf8")).toBe(original);
  });

  posix("another value: replaced in place, the file's own mode kept, no temp file left", () => {
    fs.mkdirSync(path.dirname(cfg()));
    fs.writeFileSync(cfg(), `model = "o3"\n\n${block(URL_B)}`);
    fs.chmodSync(cfg(), 0o644);
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false })).toEqual({ status: "changed" });
    expect(fs.readFileSync(cfg(), "utf8")).toBe(`model = "o3"\n\n${block(URL_A)}`);
    expect(fs.statSync(cfg()).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.dirname(cfg()))).toEqual(["config.toml"]);
  });

  posix("the given mode wins", () => {
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: true, mode: 0o640 }).status).toBe("changed");
    expect(fs.statSync(cfg()).mode & 0o777).toBe(0o640);
  });

  posix("a symlinked config.toml is rewritten through the link when withinHome: the link stays, its target gets the new key", () => {
    const target = path.join(home, "dotfiles", "config.toml");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, `model = "o3"\n\n${block(URL_B)}`);
    fs.mkdirSync(path.dirname(cfg()));
    fs.symlinkSync(path.join("..", "dotfiles", "config.toml"), cfg());
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false, withinHome: true })).toEqual({ status: "changed" });
    expect(fs.lstatSync(cfg()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(`model = "o3"\n\n${block(URL_A)}`);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["config.toml"]);
  });

  posix("a symlinked config.toml is refused in strict mode", () => {
    const target = path.join(root, "real.toml");
    fs.writeFileSync(target, "a = 1\n");
    fs.mkdirSync(path.dirname(cfg()));
    fs.symlinkSync(target, cfg());
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false })).toEqual({ status: "refused", reason: "symlink" });
    expect(fs.readFileSync(target, "utf8")).toBe("a = 1\n");
  });

  posix("a hard-linked file is refused, every link unchanged", () => {
    fs.mkdirSync(path.dirname(cfg()));
    fs.writeFileSync(cfg(), "a = 1\n");
    const other = path.join(root, "other.toml");
    fs.linkSync(cfg(), other);
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false })).toEqual({ status: "refused", reason: "hardlink" });
    expect(fs.readFileSync(cfg(), "utf8")).toBe("a = 1\n");
    expect(fs.readFileSync(other, "utf8")).toBe("a = 1\n");
  });

  it("a directory where the config should be is refused, never replaced", () => {
    fs.mkdirSync(cfg(), { recursive: true });
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: true }).status).toBe("refused");
    expect(fs.statSync(cfg()).isDirectory()).toBe(true);
  });

  it("bytes that are not UTF-8 are refused, never rewritten lossily", () => {
    fs.mkdirSync(path.dirname(cfg()));
    const bytes = Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a]);
    fs.writeFileSync(cfg(), bytes);
    expect(editTomlFile(cfg(), setUrl, { createIfMissing: false }).status).toBe("refused");
    expect(fs.readFileSync(cfg()).equals(bytes)).toBe(true);
  });

  it("an inline definition throws TomlConflictError and leaves the file as it was", () => {
    fs.mkdirSync(path.dirname(cfg()));
    const original = `[mcp_servers]\njubarteai = { url = "${URL_B}" }\n`;
    fs.writeFileSync(cfg(), original);
    expect(() => editTomlFile(cfg(), setUrl, { createIfMissing: false })).toThrow(TomlConflictError);
    expect(fs.readFileSync(cfg(), "utf8")).toBe(original);
  });

  it("remove through editTomlFile keeps the rest of the file byte for byte", () => {
    fs.mkdirSync(path.dirname(cfg()));
    const rest = '# top\nmodel = "o3"\n\n# about profiles\n[profiles.fast]\nx = 1\n';
    fs.writeFileSync(cfg(), `${rest.split("\n\n")[0]}\n\n${block(URL_A)}\n${rest.split("\n\n")[1]}`);
    expect(editTomlFile(cfg(), (t) => removeTomlTable(t, T), { createIfMissing: false })).toEqual({ status: "changed" });
    expect(fs.readFileSync(cfg(), "utf8")).toBe(rest);
  });
});
