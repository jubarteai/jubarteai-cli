// Scenarios ported from the app's src/lib/install-script.test.ts (the bash
// installer this writer replaces). B3 maps each deleted test to one below:
//
// ported: writes configs through random, exclusively created temp files, never into a file another user owns
// ported: temp files get a random name, created exclusively: a file planted at the old fixed name is never written through
// ported: a JSON config another user owns is never written: the user file is skipped, an old key in a project file fails the step
// ported: a hard-linked config is never split by a rewrite: the user file is skipped, a project file fails, every link unchanged
// ported: a symlinked config.toml is rewritten through the link: the link stays, its target gets the new key
// ported: a symlinked mcp.json is written through the link: the link stays, its target gets the new key
// ported: a relative link under a symlinked directory is followed from the real directory, never written as a stray file
// ported: a dangling link is followed from the real directory too: the target is created, the link stays
// ported: Ctrl-C mid-rewrite leaves no temp file holding the key: node finishes its write, an interrupted Codex rewrite's mktemp file is removed
// ported: a config it can't write is reported as failed (exit 1) and left as it was
// ported: a directory where the config should be is reported as failed, never replaced
// ported: fresh Codex install: appends a block with http_headers and sets file mode 0600
//
// New in the CLI (spec §3.1, plan C2): the mode is exact whatever the umask, the
// directory is 0700, symlinked files and directories are refused in strict mode,
// and a SIGKILL between temp and rename leaves the old file byte-identical.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeEditError, writeFileAtomic, writeFileAtomicWith } from "./atomic-write.js";
import { defaultGuardEnv, type GuardEnv, type RefusalReason } from "./file-guards.js";

// A switch for the exclusive-create test: while on, the temp name is predictable.
const fixedName = vi.hoisted(() => ({ on: false }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = ((size: number) => (fixedName.on ? Buffer.alloc(size, 0xab) : actual.randomBytes(size))) as typeof actual.randomBytes;
  return { ...actual, randomBytes };
});

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const myUid = typeof process.getuid === "function" ? process.getuid() : 0;
const SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CRASH_CHILD = path.resolve(SRC_DIR, "..", "test", "helpers", "crash-child.mjs");

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-atomic-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
  fixedName.on = false;
});

afterEach(() => {
  fixedName.on = false;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  // Tests that make a directory read-only restore it, but a failed one must not leave an undeletable tree.
  for (const dir of [home, path.join(home, "ro")]) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // not created by this test
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, data: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode });
  return file;
}

function env(over: Partial<GuardEnv>): GuardEnv {
  return { ...defaultGuardEnv(), ...over };
}

/** This process's own uid, but `file` reads as owned by another user (a test cannot chown). */
function foreignFile(file: string): GuardEnv {
  return env({
    fs: {
      ...fs,
      lstatSync: (p: string) => {
        const st = fs.lstatSync(p);
        if (p !== file) return st;
        return { isSymbolicLink: () => st.isSymbolicLink(), isDirectory: () => st.isDirectory(), uid: myUid + 1, gid: st.gid, nlink: st.nlink, mode: st.mode };
      },
    },
  });
}

/** Every entry under `dir` with its content or kind, so "nothing was written" is one equality. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`;
      else if (st.isDirectory()) {
        out[rel] = "<dir>";
        walk(full);
      } else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

function tempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith(".jubarteai.tmp"));
}

function refusal(fn: () => void): RefusalReason {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SafeEditError);
    return (e as SafeEditError).reason;
  }
  throw new Error("expected the write to be refused");
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("writeFileAtomic: mode and content", () => {
  it.skipIf(isWindows)("writes the file 0600 and every directory it creates 0700, whatever the umask", () => {
    for (const umask of [0o000, 0o077, 0o022, 0o277]) {
      const old = process.umask(umask);
      try {
        const file = path.join(home, `umask-${umask.toString(8)}`, "a", "b", "credentials.json");
        writeFileAtomic(file, '{"k":1}\n', { mode: 0o600 });
        expect(fs.readFileSync(file, "utf8")).toBe('{"k":1}\n');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        for (const dir of [path.dirname(file), path.dirname(path.dirname(file)), path.dirname(path.dirname(path.dirname(file)))]) {
          expect(fs.statSync(dir).mode & 0o777, dir).toBe(0o700);
        }
      } finally {
        process.umask(old);
      }
    }
  });

  it.skipIf(isWindows)("honours a dirMode, and leaves a directory that already exists as it was", () => {
    const existing = path.join(home, "existing");
    fs.mkdirSync(existing, { mode: 0o755 });
    fs.chmodSync(existing, 0o755);
    writeFileAtomic(path.join(existing, "sub", "f.txt"), "x", { mode: 0o640, dirMode: 0o750 });
    expect(fs.statSync(existing).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(existing, "sub")).mode & 0o777).toBe(0o750);
    expect(fs.statSync(path.join(existing, "sub", "f.txt")).mode & 0o777).toBe(0o640);
  });

  it("replaces an existing file's content (and its looser mode), touches no other file, leaves no temp", () => {
    const file = write(path.join(home, "cfg", "credentials.json"), "OLD", 0o644);
    const other = write(path.join(home, "cfg", "other.json"), "UNRELATED");
    const sibling = write(path.join(home, "cfg", ".credentials.json.hidden"), "ALSO UNRELATED");

    writeFileAtomic(file, "NEW ünïcode ✓\n", { mode: 0o600 });

    expect(fs.readFileSync(file, "utf8")).toBe("NEW ünïcode ✓\n");
    if (!isWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(other, "utf8")).toBe("UNRELATED");
    expect(fs.readFileSync(sibling, "utf8")).toBe("ALSO UNRELATED");
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([".credentials.json.hidden", "credentials.json", "other.json"]);
  });

  it("writes an empty string as an empty file", () => {
    const file = path.join(home, "empty.json");
    writeFileAtomic(file, "", { mode: 0o600 });
    expect(fs.statSync(file).size).toBe(0);
  });

  it("the temp file is created exclusively: a file or link planted at its name is never written through", () => {
    fixedName.on = true;
    const file = write(path.join(home, "cfg", "mcp.json"), "OLD");
    const capture = write(path.join(root, "capture.txt"), "");
    const tempName = `.mcp.json.${"ab".repeat(8)}.jubarteai.tmp`;
    const planted = path.join(home, "cfg", tempName);
    fs.symlinkSync(capture, planted);
    const before = snapshot(root);

    expect(() => writeFileAtomic(file, "KEY", { mode: 0o600 })).toThrow(/EEXIST/);

    expect(fs.readFileSync(capture, "utf8")).toBe("");
    expect(snapshot(root)).toEqual(before);
    // The planted link is not ours to remove either.
    expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
  });

  it("each write picks a fresh temp name", () => {
    const seen = new Set<string>();
    const file = path.join(home, "f.txt");
    for (let i = 0; i < 5; i++) {
      writeFileAtomicWith(file, String(i), { mode: 0o600 }, {
        guard: defaultGuardEnv(),
        beforeRename: () => {
          const temps = tempFiles(home);
          expect(temps).toHaveLength(1);
          seen.add(temps[0] as string);
        },
      });
    }
    expect(seen.size).toBe(5);
  });
});

describe("writeFileAtomic: refusals write nothing", () => {
  function expectRefused(reason: RefusalReason, watch: string, run: () => void): void {
    const before = snapshot(watch);
    expect(refusal(run)).toBe(reason);
    expect(snapshot(watch)).toEqual(before);
    expect(JSON.stringify(snapshot(watch))).not.toContain(".jubarteai.tmp");
  }

  it.skipIf(isWindows)("a symlinked target: refused, the link and its target unchanged", () => {
    const real = write(path.join(root, "elsewhere", "creds.json"), "OLD");
    const link = path.join(home, "creds.json");
    fs.symlinkSync(real, link);
    expectRefused("symlink", root, () => writeFileAtomic(link, "NEW", { mode: 0o600 }));
    expect(fs.readFileSync(real, "utf8")).toBe("OLD");
  });

  it.skipIf(isWindows)("a dangling symlink target: refused, nothing created at its destination", () => {
    const link = path.join(home, "creds.json");
    fs.symlinkSync(path.join(root, "nowhere", "creds.json"), link);
    expectRefused("symlink", root, () => writeFileAtomic(link, "NEW", { mode: 0o600 }));
    expect(fs.existsSync(path.join(root, "nowhere"))).toBe(false);
  });

  it.skipIf(isWindows)("a symlinked parent directory: refused, the directory it leads to unchanged and no directory made in it", () => {
    const realDir = path.join(root, "dotfiles", "config");
    write(path.join(realDir, "jubarteai", "credentials.json"), "OLD");
    fs.symlinkSync(realDir, path.join(home, ".config"));
    const file = path.join(home, ".config", "jubarteai", "credentials.json");
    expectRefused("symlink", root, () => writeFileAtomic(file, "NEW", { mode: 0o600 }));
    // A deeper directory that does not exist yet is not created through the link either.
    const deeper = path.join(home, ".config", "new", "sub", "credentials.json");
    expectRefused("symlink", root, () => writeFileAtomic(deeper, "NEW", { mode: 0o600 }));
  });

  it("a file with another hard link: refused, every name unchanged and still one inode", () => {
    const file = write(path.join(home, "creds.json"), "OLD");
    const twin = path.join(root, "twin.json");
    fs.linkSync(file, twin);
    const ino = fs.statSync(file).ino;
    expectRefused("hardlink", root, () => writeFileAtomic(file, "NEW", { mode: 0o600 }));
    expect(fs.statSync(file).ino).toBe(ino);
    expect(fs.statSync(twin).ino).toBe(ino);
    expect(fs.statSync(file).nlink).toBe(2);
  });

  it.skipIf(isWindows)("a file another uid owns (uid getter injected): refused, content unchanged", () => {
    const file = write(path.join(home, "creds.json"), "OLD");
    const guard = env({ getuid: () => myUid + 1 });
    expectRefused("foreign-owner", root, () => writeFileAtomicWith(file, "NEW", { mode: 0o600 }, { guard }));
  });

  it("Windows: a reparse point (platform and lstat stubbed): refused, nothing written", () => {
    const file = write(path.join(home, "creds.json"), "OLD");
    const guard = env({
      platform: "win32",
      getuid: undefined,
      fs: {
        ...fs,
        lstatSync: (p: string) =>
          p === file
            ? { isSymbolicLink: () => true, isDirectory: () => false, uid: myUid, gid: 0, nlink: 1, mode: 0o120777 }
            : fs.lstatSync(p),
      },
    });
    expectRefused("reparse-point", root, () => writeFileAtomicWith(file, "NEW", { mode: 0o600 }, { guard }));
  });

  it.skipIf(isWindows)("an unsafe parent directory (group/other-writable, or another user's): refused, nothing written, nothing created", () => {
    const open = path.join(home, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    write(path.join(open, "creds.json"), "OLD");
    expectRefused("unsafe-parent", root, () => writeFileAtomic(path.join(open, "creds.json"), "NEW", { mode: 0o600 }));
    expectRefused("unsafe-parent", root, () => writeFileAtomic(path.join(open, "new", "sub", "creds.json"), "NEW", { mode: 0o600 }));

    // Owned by "someone else" (uid getter injected), mode 0755.
    const theirs = path.join(home, "theirs");
    fs.mkdirSync(theirs);
    write(path.join(theirs, "creds.json"), "OLD");
    const guard = env({ getuid: () => myUid + 1 });
    expectRefused("unsafe-parent", root, () => writeFileAtomicWith(path.join(theirs, "creds.json"), "NEW", { mode: 0o600 }, { guard }));
  });

  it.skipIf(isWindows)("a 0755 directory the user owns (~/.config) is accepted, and the directories created under it are 0700", () => {
    const config = path.join(home, ".config");
    fs.mkdirSync(config);
    fs.chmodSync(config, 0o755);
    writeFileAtomic(path.join(config, "jubarteai", "credentials.json"), "{}", { mode: 0o600 });
    expect(fs.statSync(config).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(config, "jubarteai")).mode & 0o777).toBe(0o700);
  });

  it("a refusal says which file and why, in fixed words", () => {
    const file = write(path.join(home, "creds.json"), "OLD");
    fs.linkSync(file, path.join(root, "twin.json"));
    let message = "";
    try {
      writeFileAtomic(file, "SECRET-VALUE", { mode: 0o600 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(`Refusing to write ${file}: it has other hard links, which a rewrite would split from it.`);
    expect(message).not.toContain("SECRET-VALUE");
  });
});

describe.skipIf(isWindows)("writeFileAtomic withinRoot: a project file is written through a link only while it stays in the project", () => {
  it("CLAUDE.md -> AGENTS.md: the link stays, AGENTS.md gets the content", () => {
    const proj = path.join(home, "proj");
    const agents = write(path.join(proj, "AGENTS.md"), "old\n", 0o644);
    fs.symlinkSync("AGENTS.md", path.join(proj, "CLAUDE.md"));
    writeFileAtomic(path.join(proj, "CLAUDE.md"), "NEW\n", { mode: 0o644, withinRoot: proj });
    expect(fs.lstatSync(path.join(proj, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(agents, "utf8")).toBe("NEW\n");
  });

  it("AGENTS.md -> ../.zshrc: refused as symlink, ~/.zshrc byte-identical", () => {
    const proj = path.join(home, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const zshrc = write(path.join(home, ".zshrc"), "export A=1\n", 0o644);
    fs.symlinkSync("../.zshrc", path.join(proj, "AGENTS.md"));
    expect(refusal(() => writeFileAtomic(path.join(proj, "AGENTS.md"), "x\n", { mode: 0o644, withinRoot: proj }))).toBe("symlink");
    expect(fs.readFileSync(zshrc, "utf8")).toBe("export A=1\n");
    expect(fs.readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a linked .codex directory leading out of the project: refused, nothing created in the target directory", () => {
    const proj = path.join(home, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const config = write(path.join(home, ".codex", "config.toml"), "a = 1\n", 0o600);
    fs.symlinkSync("../.codex", path.join(proj, ".codex"));
    expect(refusal(() => writeFileAtomic(path.join(proj, ".codex", "config.toml"), "x\n", { mode: 0o600, withinRoot: proj }))).toBe("symlink");
    expect(fs.readFileSync(config, "utf8")).toBe("a = 1\n");
    expect(fs.readdirSync(path.join(home, ".codex"))).toEqual(["config.toml"]);
  });
});

describe.skipIf(isWindows)("writeFileAtomic withinHome: a user-managed config is written through its link", () => {
  it("a symlinked config: the link stays, the file it names is replaced, mode 0600, no stray file", () => {
    const target = write(path.join(home, "dotfiles", "cursor-mcp.json"), JSON.stringify({ other: 1 }), 0o644);
    const link = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.join("..", "dotfiles", "cursor-mcp.json"), link);

    writeFileAtomic(link, "NEW\n", { mode: 0o600, withinHome: true });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("NEW\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["cursor-mcp.json"]);
    expect(fs.readdirSync(path.dirname(link))).toEqual(["mcp.json"]);
  });

  it("a relative link under a symlinked directory is followed from the real directory, never written as a stray file", () => {
    const realDir = path.join(home, "dotfiles", "cursor");
    const shared = write(path.join(home, "dotfiles", "shared", "mcp.json"), "OLD");
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(path.join("..", "shared", "mcp.json"), path.join(realDir, "mcp.json"));
    fs.symlinkSync(realDir, path.join(home, ".cursor"));

    writeFileAtomic(path.join(home, ".cursor", "mcp.json"), "NEW", { mode: 0o600, withinHome: true });

    expect(fs.readFileSync(shared, "utf8")).toBe("NEW");
    expect(fs.lstatSync(path.join(realDir, "mcp.json")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, "shared"))).toBe(false);
  });

  it("a dangling link: the target is created where the link points, the link stays", () => {
    const realDir = path.join(home, "dotfiles", "cursor");
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.join(home, "dotfiles", "shared"));
    fs.symlinkSync(path.join("..", "shared", "mcp.json"), path.join(realDir, "mcp.json"));
    fs.symlinkSync(realDir, path.join(home, ".cursor"));

    writeFileAtomic(path.join(home, ".cursor", "mcp.json"), "NEW", { mode: 0o600, withinHome: true });

    expect(fs.readFileSync(path.join(home, "dotfiles", "shared", "mcp.json"), "utf8")).toBe("NEW");
    expect(fs.lstatSync(path.join(realDir, "mcp.json")).isSymbolicLink()).toBe(true);
  });

  it("a link out of the home directory: refused, nothing written at either end", () => {
    const outside = write(path.join(root, "outside", "mcp.json"), "OLD");
    const link = path.join(home, "mcp.json");
    fs.symlinkSync(outside, link);
    const before = snapshot(root);
    expect(refusal(() => writeFileAtomic(link, "NEW", { mode: 0o600, withinHome: true }))).toBe("outside-home");
    expect(snapshot(root)).toEqual(before);
  });

  it("the file the link names is held to the hard-link and owner rules", () => {
    const target = write(path.join(home, "dotfiles", "mcp.json"), "OLD");
    const link = path.join(home, "mcp.json");
    fs.symlinkSync(target, link);
    const owner = foreignFile(target);
    expect(refusal(() => writeFileAtomicWith(link, "NEW", { mode: 0o600, withinHome: true }, { guard: owner }))).toBe("foreign-owner");
    fs.linkSync(target, path.join(root, "twin.json"));
    expect(refusal(() => writeFileAtomic(link, "NEW", { mode: 0o600, withinHome: true }))).toBe("hardlink");
    expect(fs.readFileSync(target, "utf8")).toBe("OLD");
  });
});

describe("writeFileAtomic: failures clean up and leave the old file", () => {
  it("a failure after the temp is written removes the temp and leaves the old file byte-identical", () => {
    const file = write(path.join(home, "cfg", "credentials.json"), "OLD BYTES\n");
    const before = snapshot(home);
    expect(() =>
      writeFileAtomicWith(file, "NEW", { mode: 0o600 }, {
        guard: defaultGuardEnv(),
        beforeRename: () => {
          expect(tempFiles(path.dirname(file))).toHaveLength(1);
          throw new Error("injected failure");
        },
      }),
    ).toThrow("injected failure");
    expect(snapshot(home)).toEqual(before);
  });

  it("a directory where the file should be is never replaced, and no temp is left", () => {
    const dirAsFile = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(dirAsFile, { recursive: true });
    write(path.join(dirAsFile, "inside.txt"), "KEEP");
    const before = snapshot(home);
    expect(() => writeFileAtomic(dirAsFile, "NEW", { mode: 0o600 })).toThrow();
    expect(snapshot(home)).toEqual(before);
  });

  it.skipIf(isWindows || isRoot)("a directory it cannot write into: throws, the old file is as it was, nothing left behind", () => {
    const file = write(path.join(home, "ro", "mcp.json"), "OLD");
    fs.chmodSync(path.dirname(file), 0o555);
    const before = snapshot(home);
    expect(() => writeFileAtomic(file, "NEW", { mode: 0o600 })).toThrow(/EACCES/);
    fs.chmodSync(path.dirname(file), 0o755);
    expect(snapshot(home)).toEqual(before);
  });
});

describe.skipIf(isWindows)("writeFileAtomic: a killed process", () => {
  let compiled: string;

  // The child runs the real code, transpiled (the sources use parameter properties, which
  // Node's type stripping does not take) into a scratch directory next to nothing else.
  beforeAll(() => {
    compiled = fs.mkdtempSync(path.join(os.tmpdir(), "jba-atomic-compiled-"));
    const queue = [path.join(SRC_DIR, "safe-edit", "atomic-write.ts")];
    const seen = new Set<string>();
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      const code = fs.readFileSync(file, "utf8");
      for (const m of code.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) queue.push(path.resolve(path.dirname(file), `${m[1]}.ts`));
      const out = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      const dest = path.join(compiled, path.relative(SRC_DIR, file).replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out);
    }
    fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
    return () => fs.rmSync(compiled, { recursive: true, force: true });
  });

  /** Starts the child, waits until it is paused with the temp written, and resolves with controls. */
  async function pausedChild(file: string) {
    const ready = path.join(root, "ready");
    const go = path.join(root, "go");
    const child = spawn(process.execPath, [CRASH_CHILD, compiled, file, ready, go], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    await Promise.race([
      waitFor(() => fs.existsSync(ready), "the child to pause before its rename"),
      exited.then((r) => {
        throw new Error(`child exited early (${JSON.stringify(r)}): ${stderr}`);
      }),
    ]);
    return { child, exited, release: () => fs.writeFileSync(go, "") };
  }

  it("SIGKILL between the temp write and the rename: the old file is intact and byte-identical, and the next write works", async () => {
    const file = write(path.join(home, ".config", "jubarteai", "credentials.json"), '{"old":"bytes"}\n', 0o600);
    const oldBytes = fs.readFileSync(file);
    const oldIno = fs.statSync(file).ino;

    const { child, exited } = await pausedChild(file);
    // The point under test: the temp exists, the rename has not happened.
    expect(tempFiles(path.dirname(file))).toHaveLength(1);
    child.kill("SIGKILL");
    expect((await exited).signal).toBe("SIGKILL");

    expect(fs.readFileSync(file).equals(oldBytes)).toBe(true);
    expect(fs.statSync(file).ino).toBe(oldIno);
    // What a kill cannot clean up is private: 0600, in the 0700 directory.
    for (const temp of tempFiles(path.dirname(file))) expect(fs.statSync(path.join(path.dirname(file), temp)).mode & 0o777).toBe(0o600);

    writeFileAtomic(file, "AFTER\n", { mode: 0o600 });
    expect(fs.readFileSync(file, "utf8")).toBe("AFTER\n");
  });

  it("SIGKILL when the file did not exist yet: no file appears", async () => {
    const file = path.join(home, ".config", "jubarteai", "credentials.json");
    const { child, exited } = await pausedChild(file);
    child.kill("SIGKILL");
    await exited;
    expect(fs.existsSync(file)).toBe(false);
  });

  it("Ctrl-C mid-write: the write finishes (no temp left holding the key), then the signal takes effect", async () => {
    const file = write(path.join(home, "cfg", "mcp.json"), "OLD", 0o600);
    const { child, exited, release } = await pausedChild(file);

    child.kill("SIGINT");
    release();
    const result = await exited;

    expect(result).toEqual({ code: null, signal: "SIGINT" });
    expect(fs.readFileSync(file, "utf8")).toBe("NEW CONTENT\n");
    expect(tempFiles(path.dirname(file))).toEqual([]);
  });

  it("with no signal the same child completes normally", async () => {
    const file = write(path.join(home, "cfg", "mcp.json"), "OLD", 0o600);
    const { exited, release } = await pausedChild(file);
    release();
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(file, "utf8")).toBe("NEW CONTENT\n");
    expect(tempFiles(path.dirname(file))).toEqual([]);
  });
});
