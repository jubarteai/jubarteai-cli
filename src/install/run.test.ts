import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  logTail,
  resolveInvocation,
  runCommand,
  runCommandSync,
  setChildOutput,
  which,
  whichWith,
  type Probe,
} from "./run.js";

const POSIX = process.platform !== "win32";
const FAKE_KEY = "jba_FAKEKEYFORTESTSONLY000000000000";

let dir: string;
let savedPath: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jubarteai-run-"));
  savedPath = process.env.PATH;
  savedToken = process.env.JUBARTEAI_TOKEN;
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.JUBARTEAI_TOKEN;
  else process.env.JUBARTEAI_TOKEN = savedToken;
  rmSync(dir, { recursive: true, force: true });
});

/** A tiny executable: a node script with a shebang naming this node, so PATH needs no node on it. */
function fakeExe(name: string, body: string, mode = 0o755): string {
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

describe.skipIf(!POSIX)("runCommand", () => {
  it("passes every argument literally: no shell sees it", async () => {
    const marker = join(dir, "pwned");
    fakeExe("echoargs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const args = ["a b", "; rm -rf /tmp/x", `$(touch ${marker})`, "`touch " + marker + "`", "x && touch " + marker, "*", "'quoted'", "--flag=v"];
    // cwd: the temp dir, so a regression that hands these to a shell can only touch the sandbox.
    const res = await runCommand("echoargs", args, { cwd: dir, timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(args);
    expect(existsSync(marker)).toBe(false);
  });

  it("never gives the child JUBARTEAI_TOKEN, even when the parent has it and the caller asks for it", async () => {
    fakeExe("showenv", "process.stdout.write(JSON.stringify({ token: process.env.JUBARTEAI_TOKEN ?? null, extra: process.env.JUBARTEAI_TEST_EXTRA ?? null, home: typeof process.env.HOME }));");
    process.env.JUBARTEAI_TOKEN = FAKE_KEY;
    const plain = await runCommand("showenv", [], { timeoutMs: 10_000 });
    expect(JSON.parse(plain.stdout)).toEqual({ token: null, extra: null, home: "string" });
    const asked = await runCommand("showenv", [], {
      timeoutMs: 10_000,
      env: { JUBARTEAI_TOKEN: FAKE_KEY, JUBARTEAI_TEST_EXTRA: "kept" },
    });
    expect(JSON.parse(asked.stdout)).toEqual({ token: null, extra: "kept", home: "string" });
    expect(plain.stdout + plain.stderr + asked.stdout + asked.stderr).not.toContain(FAKE_KEY);
    // The parent's own environment is untouched.
    expect(process.env.JUBARTEAI_TOKEN).toBe(FAKE_KEY);
  });

  it("captures stdout, stderr and a non-zero exit code", async () => {
    fakeExe("noisy", 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);');
    const res = await runCommand("noisy", [], { timeoutMs: 10_000 });
    expect(res).toEqual({ code: 3, stdout: "out", stderr: "err", timedOut: false, notFound: false });
  });

  it("kills a child that outlives the timeout and reports timedOut", async () => {
    const pidFile = join(dir, "hang.pid");
    fakeExe("hang", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const started = Date.now();
    const res = await runCommand("hang", [], { timeoutMs: 2_000 });
    expect(res.timedOut).toBe(true);
    expect(res.notFound).toBe(false);
    expect(res.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const pidFile = join(dir, "stubborn.pid");
    fakeExe(
      "stubborn",
      `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const res = await runCommand("stubborn", [], { timeoutMs: 2_000 });
    expect(res.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not report a timeout for a child that finishes in time", async () => {
    fakeExe("quick", 'process.stdout.write("done");');
    const res = await runCommand("quick", [], { timeoutMs: 10_000 });
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe("done");
  });

  it("reports notFound for a binary that is not on PATH, and for a file that is not executable", async () => {
    const missing = await runCommand("jubarteai-no-such-binary", ["x"], { timeoutMs: 10_000 });
    expect(missing).toEqual({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true });
    fakeExe("notexec", 'process.stdout.write("hi");', 0o644);
    const plain = await runCommand("notexec", [], { timeoutMs: 10_000 });
    expect(plain.notFound).toBe(true);
    expect(plain.code).toBeNull();
  });

  it("closes stdin at once when there is no input, and writes the input when there is", async () => {
    fakeExe("readin", 'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => process.stdout.write(JSON.stringify(d)));');
    const none = await runCommand("readin", [], { timeoutMs: 10_000 });
    expect(JSON.parse(none.stdout)).toBe("");
    const empty = await runCommand("readin", [], { timeoutMs: 10_000, input: "" });
    expect(JSON.parse(empty.stdout)).toBe("");
    const some = await runCommand("readin", [], { timeoutMs: 10_000, input: "line one\nli\u00e9ne two" });
    expect(JSON.parse(some.stdout)).toBe("line one\nli\u00e9ne two");
  });

  it("is not stopped by a child that closes stdin without reading it", async () => {
    fakeExe("deaf", 'process.stdout.write("ok"); process.stdin.destroy();');
    const res = await runCommand("deaf", [], { timeoutMs: 10_000, input: "x".repeat(2_000_000) });
    expect(res.stdout).toBe("ok");
    expect(res.timedOut).toBe(false);
  });

  it("runs in the given folder", async () => {
    fakeExe("where", "process.stdout.write(process.cwd());");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const res = await runCommand("where", [], { timeoutMs: 10_000, cwd: sub });
    expect(res.stdout.endsWith("/sub")).toBe(true);
  });

  it("keeps at most MAX_OUTPUT_CHARS of a flood and still lets the child finish", async () => {
    fakeExe("flood", `const chunk = "x".repeat(65536); for (let i = 0; i < 48; i++) process.stdout.write(chunk);`);
    const res = await runCommand("flood", [], { timeoutMs: 20_000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toHaveLength(MAX_OUTPUT_CHARS);
  });

  it("decodes multi-byte text split across chunks", async () => {
    fakeExe("utf", 'const b = Buffer.from("h\u00e9llo \u2713"); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 50);');
    const res = await runCommand("utf", [], { timeoutMs: 10_000 });
    expect(res.stdout).toBe("h\u00e9llo \u2713");
  });

  it("rejects a timeout that is not a positive number", async () => {
    await expect(runCommand("echoargs", [], { timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(runCommand("echoargs", [], { timeoutMs: Number.NaN })).rejects.toThrow(RangeError);
  });

  it("reports a start failure as a fixed result, not an exception", async () => {
    // An argument with a NUL byte cannot be passed to a process.
    fakeExe("anything", "process.stdout.write('x');");
    const res = await runCommand("anything", ["a\0b"], { timeoutMs: 10_000 });
    expect(res.code).toBeNull();
    expect(res.stderr).toMatch(/^could not start \([A-Za-z0-9_-]+\)$/);
    expect(res.notFound).toBe(false);
  });
});

describe.skipIf(!POSIX)("child output streaming and the log tail", () => {
  afterEach(() => setChildOutput(null));

  it("streams each line, redacted and made safe, only while a handler is set", async () => {
    fakeExe("talker", `process.stdout.write("first\\nkey ${FAKE_KEY} here\\n"); process.stderr.write("esc \\u001b[31mred\\npartial");`);
    const quiet: string[] = [];
    await runCommand("talker", [], { timeoutMs: 10_000 });
    expect(quiet).toEqual([]);
    const lines: string[] = [];
    setChildOutput((line) => lines.push(line));
    await runCommand("talker", [], { timeoutMs: 10_000 });
    expect(lines).toContain("first");
    expect(lines).toContain("key [redacted] here");
    expect(lines).toContain("esc ?[31mred");
    expect(lines).toContain("partial");
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });

  it("logTail keeps the last lines of both streams, redacted and safe", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const tail = logTail({ stdout, stderr: `boom ${FAKE_KEY}\n\u001b[2Jclear\n\n` }, 15);
    expect(tail).toHaveLength(15);
    expect(tail.at(-1)).toBe("?[2Jclear");
    expect(tail.at(-2)).toBe("boom [redacted]");
    expect(tail.join("\n")).not.toContain(FAKE_KEY);
    expect(logTail({ stdout: "", stderr: "" })).toEqual([]);
  });
});

describe.skipIf(!POSIX)("runCommandSync", () => {
  it("passes arguments literally and drops JUBARTEAI_TOKEN", () => {
    fakeExe("syncecho", "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), token: process.env.JUBARTEAI_TOKEN ?? null }));");
    process.env.JUBARTEAI_TOKEN = FAKE_KEY;
    const args = ["a b", "; rm -rf /", "$(id)"];
    const res = runCommandSync("syncecho", args, { timeoutMs: 10_000, env: { JUBARTEAI_TOKEN: FAKE_KEY } });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ argv: args, token: null });
  });

  it("reports a timeout and a missing binary", () => {
    fakeExe("syncsleep", "setInterval(() => {}, 1000);");
    const slow = runCommandSync("syncsleep", [], { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBeNull();
    const missing = runCommandSync("jubarteai-no-such-binary", [], { timeoutMs: 1000 });
    expect(missing.notFound).toBe(true);
  });

  it("returns the exit code of a failing child", () => {
    fakeExe("syncfail", 'process.stderr.write("bad"); process.exit(5);');
    expect(runCommandSync("syncfail", [], { timeoutMs: 10_000 })).toEqual({ code: 5, stdout: "", stderr: "bad", timedOut: false, notFound: false });
  });
});

describe.skipIf(!POSIX)("which", () => {
  it("finds an executable on PATH and returns null for a missing or non-executable one", () => {
    const exe = fakeExe("findme", "");
    fakeExe("plainfile", "", 0o644);
    expect(which("findme")).toBe(exe);
    expect(which("plainfile")).toBeNull();
    expect(which("jubarteai-no-such-binary")).toBeNull();
    expect(which("")).toBeNull();
  });

  it("takes a path with a slash as it is, and a directory is not a command", () => {
    const exe = fakeExe("bypath", "");
    expect(which(exe)).toBe(exe);
    expect(which(dir)).toBeNull();
  });

  it("looks in the environment it is given, not only the process's", () => {
    const exe = fakeExe("customenv", "");
    expect(which("customenv", { PATH: dir })).toBe(exe);
    expect(which("customenv", { PATH: "/nonexistent-dir" })).toBeNull();
  });

  it("ignores empty and relative PATH entries: nothing runs out of the current folder", () => {
    fakeExe("localonly", "");
    const original = process.cwd();
    try {
      process.chdir(dir);
      expect(which("localonly", { PATH: `${delimiter}.${delimiter}bin` })).toBeNull();
    } finally {
      process.chdir(original);
    }
  });
});

// The Windows rules, run against a fake machine so they are checked on every platform.
function fakeWindows(files: string[], env: Record<string, string>, execPath = "C:\\node\\node.exe"): Probe {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: "win32",
    env,
    execPath,
    isFile: (p) => present.has(p.toLowerCase()),
    isExecutable: (p) => present.has(p.toLowerCase()),
  };
}

describe("Windows lookup and invocation", () => {
  it("resolves a bare name through PATHEXT, reading the PATH variable whatever its case", () => {
    const probe = fakeWindows(["C:\\tools\\codex.CMD"], { Path: "C:\\tools;C:\\other", PATHEXT: ".EXE;.CMD" });
    expect(whichWith("codex", probe)).toBe("C:\\tools\\codex.CMD");
    expect(whichWith("missing", probe)).toBeNull();
  });

  it("uses the default PATHEXT when the variable is absent, and skips relative PATH entries", () => {
    const probe = fakeWindows(["C:\\tools\\git.exe", "bin\\evil.exe"], { PATH: "bin;;C:\\tools" });
    expect(whichWith("git", probe)).toBe("C:\\tools\\git.exe");
    expect(whichWith("evil", probe)).toBeNull();
  });

  it("runs npm and npx as node plus the npm-cli scripts next to node, never through a shell", () => {
    const probe = fakeWindows(["C:\\node\\npx.cmd", "C:\\node\\node_modules\\npm\\bin\\npx-cli.js"], { PATH: "C:\\node" });
    expect(resolveInvocation("npx", ["-y", "skills@1.7.4", "add", "x/y"], probe)).toEqual({
      ok: true,
      file: "C:\\node\\node.exe",
      args: ["C:\\node\\node_modules\\npm\\bin\\npx-cli.js", "-y", "skills@1.7.4", "add", "x/y"],
    });
  });

  it("falls back to cmd.exe for an npm shim whose npm-cli is missing, only for arguments cmd.exe leaves alone", () => {
    const probe = fakeWindows(["C:\\tools\\npm.cmd"], { PATH: "C:\\tools", ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(resolveInvocation("npm", ["--version"], probe)).toEqual({
      ok: true,
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "C:\\tools\\npm.cmd", "--version"],
    });
    for (const bad of ["a b", "x&calc", "x|y", "%PATH%", "^x", "a\"b", "x>y", "!x"]) {
      expect(resolveInvocation("npm", [bad], probe), bad).toEqual({ ok: false, reason: "unsafe-shim" });
    }
  });

  it("refuses a shim whose own path has characters cmd.exe treats as syntax", () => {
    const probe = fakeWindows(["C:\\Program Files\\x\\codex.cmd", "C:\\a&b\\codex.cmd"], { PATH: "C:\\Program Files\\x;C:\\a&b" });
    expect(resolveInvocation("codex", ["--version"], probe)).toEqual({ ok: false, reason: "unsafe-shim" });
  });

  it("starts a real .exe directly with its arguments untouched", () => {
    const probe = fakeWindows(["C:\\tools\\claude.exe"], { PATH: "C:\\tools" });
    expect(resolveInvocation("claude", ["plugin list", "a&b"], probe)).toEqual({
      ok: true,
      file: "C:\\tools\\claude.exe",
      args: ["plugin list", "a&b"],
    });
  });

  it("reports not-found when nothing matches", () => {
    expect(resolveInvocation("nothing", [], fakeWindows([], { PATH: "C:\\tools" }))).toEqual({ ok: false, reason: "not-found" });
  });

  it("on POSIX, hands the found path and the arguments through unchanged", () => {
    const probe: Probe = { platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/usr/bin/node", isFile: () => true, isExecutable: (p) => p === "/usr/bin/npx" };
    expect(resolveInvocation("npx", ["a b"], probe)).toEqual({ ok: true, file: "/usr/bin/npx", args: ["a b"] });
  });
});
