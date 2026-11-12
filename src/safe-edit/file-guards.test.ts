// Scenarios ported from the app's src/lib/install-script.test.ts (the bash
// installer these guards replace). B3 maps each deleted test to one below:
//
// ported: writes configs through random, exclusively created temp files, never into a file another user owns   (foreign owner)
// ported: a JSON config another user owns is never written: the user file is skipped, an old key in a project file fails the step   (foreign owner)
// ported: a hard-linked config is never split by a rewrite: the user file is skipped, a project file fails, every link unchanged   (hard link)
// ported: a symlinked config.toml is rewritten through the link: the link stays, its target gets the new key   (through-link, withinHome)
// ported: a symlinked mcp.json is written through the link: the link stays, its target gets the new key   (through-link, withinHome)
// ported: a relative link under a symlinked directory is followed from the real directory, never written as a stray file   (realTarget)
// ported: a dangling link is followed from the real directory too: the target is created, the link stays   (realTarget)
// ported: a directory where the config should be is reported as failed, never replaced   (a lstat error is not "missing")
//
// New in the CLI (spec §3.1): strict mode refuses any symlinked file or parent
// directory, and the Windows reparse-point reason; withinHome adds "outside-home".
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeTarget, assertSafeTargetWith, defaultGuardEnv, realTarget, type GuardEnv } from "./file-guards.js";

const isWindows = process.platform === "win32";
const myUid = typeof process.getuid === "function" ? process.getuid() : 0;
const myGid = typeof process.getgid === "function" ? process.getgid() : 0;

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-guards-")));
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

function write(file: string, data = "{}\n"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
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

describe("assertSafeTarget, strict (the credential store)", () => {
  it("accepts a regular file and a missing one when allowMissing, and calls a missing one missing otherwise", () => {
    const file = write(path.join(home, ".config", "jubarteai", "credentials.json"));
    expect(assertSafeTarget(file, { allowMissing: false })).toEqual({ ok: true });
    const fresh = path.join(home, ".config", "jubarteai", "new", "deeper", "x.json");
    expect(assertSafeTarget(fresh, { allowMissing: true })).toEqual({ ok: true });
    expect(assertSafeTarget(fresh, { allowMissing: false })).toEqual({ ok: false, reason: "missing" });
  });

  it.skipIf(isWindows)("refuses a symlinked file, and a dangling one even when the file may be missing", () => {
    const real = write(path.join(root, "elsewhere", "creds.json"));
    const link = path.join(home, "creds.json");
    fs.symlinkSync(real, link);
    expect(assertSafeTarget(link, { allowMissing: false })).toEqual({ ok: false, reason: "symlink" });

    const dangling = path.join(home, "dangling.json");
    fs.symlinkSync(path.join(root, "nowhere.json"), dangling);
    expect(assertSafeTarget(dangling, { allowMissing: true })).toEqual({ ok: false, reason: "symlink" });
  });

  it.skipIf(isWindows)("refuses a file in a symlinked directory, at any depth below home", () => {
    const realDir = path.join(root, "dotfiles", "config");
    write(path.join(realDir, "jubarteai", "credentials.json"));
    fs.symlinkSync(realDir, path.join(home, ".config"));
    expect(assertSafeTarget(path.join(home, ".config", "jubarteai", "credentials.json"), { allowMissing: true })).toEqual({
      ok: false,
      reason: "symlink",
    });
    // A missing file under it too: the directory is what is wrong.
    expect(assertSafeTarget(path.join(home, ".config", "jubarteai", "other.json"), { allowMissing: true })).toEqual({
      ok: false,
      reason: "symlink",
    });
  });

  it.skipIf(isWindows)("does not hold the home directory itself against the user: a symlinked home is fine", () => {
    const realHome = path.join(root, "realhome");
    fs.mkdirSync(realHome);
    const linkedHome = path.join(root, "linkedhome");
    fs.symlinkSync(realHome, linkedHome);
    process.env.HOME = linkedHome;
    const file = path.join(linkedHome, ".config", "jubarteai", "credentials.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    expect(assertSafeTarget(file, { allowMissing: false })).toEqual({ ok: true });
  });

  it("refuses a file with another hard link, and leaves both names alone", () => {
    const file = write(path.join(home, "creds.json"), "A");
    const twin = path.join(root, "twin.json");
    fs.linkSync(file, twin);
    expect(assertSafeTarget(file, { allowMissing: true })).toEqual({ ok: false, reason: "hardlink" });
    expect(fs.readFileSync(twin, "utf8")).toBe("A");
    expect(fs.statSync(file).nlink).toBe(2);
  });

  it.skipIf(isWindows)("refuses a file another uid owns (the uid getter is injected: a test cannot chown)", () => {
    const file = write(path.join(home, "creds.json"));
    expect(assertSafeTargetWith(file, { allowMissing: true }, env({ getuid: () => myUid + 1 }))).toEqual({
      ok: false,
      reason: "foreign-owner",
    });
    expect(assertSafeTargetWith(file, { allowMissing: true }, env({ getuid: () => myUid }))).toEqual({ ok: true });
  });

  it.skipIf(isWindows)("reports a foreign owner before other hard links, as install.sh did", () => {
    const file = write(path.join(home, "creds.json"));
    fs.linkSync(file, path.join(root, "twin.json"));
    expect(assertSafeTargetWith(file, { allowMissing: true }, env({ getuid: () => myUid + 1 }))).toEqual({
      ok: false,
      reason: "foreign-owner",
    });
  });

  it("a directory where the file should be is not 'missing' and not refused by a reason: the write is left to fail", () => {
    const dirAsFile = path.join(home, "mcp.json");
    fs.mkdirSync(dirAsFile);
    expect(assertSafeTarget(dirAsFile, { allowMissing: false })).toEqual({ ok: true });
    expect(fs.statSync(dirAsFile).isDirectory()).toBe(true);
  });

  it("does not mistake an unreadable path for a missing one: a file where a directory should be throws", () => {
    const file = write(path.join(home, "a-file"));
    expect(() => assertSafeTarget(path.join(file, "creds.json"), { allowMissing: true })).toThrow();
  });
});

describe("assertSafeTargetWith, the platform and the filesystem stubbed", () => {
  const fileStats = (over: Partial<{ symlink: boolean; uid: number; nlink: number }> = {}) => ({
    isSymbolicLink: () => over.symlink ?? false,
    isDirectory: () => false,
    uid: over.uid ?? myUid,
    gid: myGid,
    nlink: over.nlink ?? 1,
    mode: over.symlink ? 0o120777 : 0o100600,
  });

  it("Windows: a reparse point (a symlink or junction in lstat) is 'reparse-point', and the uid check is skipped", () => {
    const file = write(path.join(home, "creds.json"));
    const stub = (symlink: boolean): GuardEnv =>
      env({
        platform: "win32",
        getuid: undefined,
        fs: { ...fs, lstatSync: (p: string) => (p === file ? fileStats({ symlink, uid: 99999 }) : fs.lstatSync(p)) },
      });
    expect(assertSafeTargetWith(file, { allowMissing: true }, stub(true))).toEqual({ ok: false, reason: "reparse-point" });
    // Same file, not a reparse point, owned by "someone else": Windows has no uid to compare.
    expect(assertSafeTargetWith(file, { allowMissing: true }, stub(false))).toEqual({ ok: true });
  });

  it("Windows: a reparse point in a parent directory is refused too", () => {
    const file = write(path.join(home, "config", "creds.json"));
    const parent = path.join(home, "config");
    const stub = env({
      platform: "win32",
      getuid: undefined,
      fs: { ...fs, lstatSync: (p: string) => (p === parent ? fileStats({ symlink: true }) : fs.lstatSync(p)) },
    });
    expect(assertSafeTargetWith(file, { allowMissing: true }, stub)).toEqual({ ok: false, reason: "reparse-point" });
  });

  it("outside home, a root-owned link in a parent (macOS /var, /tmp) is the system's own, a link anyone else owns is refused", () => {
    const outside = path.join(root, "other", "sys", "creds.json");
    write(outside);
    const sys = path.join(root, "other", "sys");
    const stub = (uid: number): GuardEnv =>
      env({
        platform: "linux",
        getuid: () => myUid,
        fs: { ...fs, lstatSync: (p: string) => (p === sys ? fileStats({ symlink: true, uid }) : fs.lstatSync(p)) },
      });
    expect(assertSafeTargetWith(outside, { allowMissing: true }, stub(0))).toEqual({ ok: true });
    expect(assertSafeTargetWith(outside, { allowMissing: true }, stub(myUid + 1000))).toEqual({ ok: false, reason: "symlink" });
  });

  it("under home, a root-owned link in a parent is still refused: the exemption is for system paths only", () => {
    const file = write(path.join(home, "config", "creds.json"));
    const parent = path.join(home, "config");
    const stub = env({
      platform: "linux",
      getuid: () => myUid,
      fs: { ...fs, lstatSync: (p: string) => (p === parent ? fileStats({ symlink: true, uid: 0 }) : fs.lstatSync(p)) },
    });
    expect(assertSafeTargetWith(file, { allowMissing: true }, stub)).toEqual({ ok: false, reason: "symlink" });
  });
});

describe.skipIf(isWindows)("assertSafeTarget withinHome (a user-managed config, written through links)", () => {
  it("accepts a symlinked config whose target is in home, and a plain file", () => {
    const target = write(path.join(home, "dotfiles", "cursor-mcp.json"));
    const link = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(target, link);
    expect(assertSafeTarget(link, { allowMissing: false, withinHome: true })).toEqual({ ok: true });
    expect(assertSafeTarget(target, { allowMissing: false, withinHome: true })).toEqual({ ok: true });
  });

  it("follows a relative link under a symlinked directory from the real directory", () => {
    const realDir = path.join(home, "dotfiles", "cursor");
    const shared = write(path.join(home, "dotfiles", "shared", "mcp.json"));
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(path.join("..", "shared", "mcp.json"), path.join(realDir, "mcp.json"));
    fs.symlinkSync(realDir, path.join(home, ".cursor"));
    const config = path.join(home, ".cursor", "mcp.json");
    expect(realTarget(config, defaultGuardEnv().fs)).toBe(shared);
    expect(assertSafeTarget(config, { allowMissing: false, withinHome: true })).toEqual({ ok: true });
  });

  it("follows a dangling link hop by hop: a missing target is fine to create, never one 'missing' for a required file", () => {
    const realDir = path.join(home, "dotfiles", "cursor");
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.join(home, "dotfiles", "shared"));
    fs.symlinkSync(path.join("..", "shared", "mcp.json"), path.join(realDir, "mcp.json"));
    fs.symlinkSync(realDir, path.join(home, ".cursor"));
    const config = path.join(home, ".cursor", "mcp.json");
    expect(realTarget(config, defaultGuardEnv().fs)).toBe(path.join(home, "dotfiles", "shared", "mcp.json"));
    expect(assertSafeTarget(config, { allowMissing: true, withinHome: true })).toEqual({ ok: true });
    expect(assertSafeTarget(config, { allowMissing: false, withinHome: true })).toEqual({ ok: false, reason: "missing" });
  });

  it("a HOME that is itself a symlink (macOS /var -> /private/var) works with directories not created yet; a link out of the real home is still refused", () => {
    const realHome = path.join(root, "realhome");
    fs.mkdirSync(realHome);
    const linkedHome = path.join(root, "linkedhome");
    fs.symlinkSync(realHome, linkedHome);
    process.env.HOME = linkedHome;

    // ~/.gemini does not exist, and HOME is not realpath'd.
    const missing = path.join(linkedHome, ".gemini", "settings.json");
    expect(assertSafeTarget(missing, { allowMissing: true, withinHome: true })).toEqual({ ok: true });
    expect(realTarget(missing, defaultGuardEnv().fs)).toBe(path.join(realHome, ".gemini", "settings.json"));
    // Deeper still, and with the directory there.
    expect(assertSafeTarget(path.join(linkedHome, "a", "b", "c.json"), { allowMissing: true, withinHome: true })).toEqual({ ok: true });
    fs.mkdirSync(path.join(realHome, ".gemini"));
    expect(assertSafeTarget(missing, { allowMissing: true, withinHome: true })).toEqual({ ok: true });

    // A link inside home that points outside the real home is still refused, existing or not below it.
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(linkedHome, "escape"));
    expect(assertSafeTarget(path.join(linkedHome, "escape", "x.json"), { allowMissing: true, withinHome: true })).toEqual({
      ok: false,
      reason: "outside-home",
    });
    expect(assertSafeTarget(path.join(linkedHome, "escape", "new", "x.json"), { allowMissing: true, withinHome: true })).toEqual({
      ok: false,
      reason: "outside-home",
    });
  });

  it("refuses a link that leaves the home directory, however it gets there", () => {
    const outside = write(path.join(root, "outside", "mcp.json"));
    const direct = path.join(home, "direct.json");
    fs.symlinkSync(outside, direct);
    const viaDir = path.join(home, "viadir");
    fs.symlinkSync(path.join(root, "outside"), viaDir);
    const dangling = path.join(home, "dangling.json");
    fs.symlinkSync(path.join(root, "outside", "new.json"), dangling);
    for (const file of [direct, path.join(viaDir, "mcp.json"), dangling]) {
      expect(assertSafeTarget(file, { allowMissing: true, withinHome: true }), file).toEqual({ ok: false, reason: "outside-home" });
    }
    // A path that is not under home at all is the same refusal, not a pass.
    expect(assertSafeTarget(outside, { allowMissing: true, withinHome: true })).toEqual({ ok: false, reason: "outside-home" });
  });

  it("checks the owner and the hard links of the file the link names, not of the link", () => {
    const target = write(path.join(home, "dotfiles", "mcp.json"));
    const link = path.join(home, "mcp.json");
    fs.symlinkSync(target, link);
    expect(assertSafeTargetWith(link, { allowMissing: true, withinHome: true }, foreignFile(target))).toEqual({
      ok: false,
      reason: "foreign-owner",
    });
    fs.linkSync(target, path.join(root, "twin.json"));
    expect(assertSafeTarget(link, { allowMissing: true, withinHome: true })).toEqual({ ok: false, reason: "hardlink" });
  });

  it("calls a link loop a symlink, not a file", () => {
    fs.symlinkSync(path.join(home, "b"), path.join(home, "a"));
    fs.symlinkSync(path.join(home, "a"), path.join(home, "b"));
    expect(assertSafeTarget(path.join(home, "a"), { allowMissing: true, withinHome: true })).toEqual({ ok: false, reason: "symlink" });
  });
});

describe("assertSafeTarget: the directory the file sits in (unsafe-parent)", () => {
  const dirStats = (uid: number, mode: number, gid: number) => ({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid,
    gid,
    nlink: 2,
    mode: 0o40000 | mode,
  });
  /** `dir` reads as owned by `uid` with `mode`; everything else is the real filesystem. */
  const withDir = (dir: string, uid: number, mode: number, over: Partial<GuardEnv> = {}, gid = myGid): GuardEnv =>
    env({
      getuid: () => myUid,
      getgid: () => myGid,
      ...over,
      fs: { ...fs, lstatSync: (p: string) => (p === dir ? dirStats(uid, mode, gid) : fs.lstatSync(p)) },
    });
  const mkdir = (dir: string, mode: number): string => {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, mode);
    return dir;
  };

  it.skipIf(isWindows)("accepts a directory this user owns that others cannot write: 0700 and 0755 (~/.config)", () => {
    for (const mode of [0o700, 0o755, 0o750]) {
      const dir = mkdir(path.join(home, `d${mode.toString(8)}`), mode);
      expect(assertSafeTarget(path.join(dir, "creds.json"), { allowMissing: true }), mode.toString(8)).toEqual({ ok: true });
    }
  });

  it.skipIf(isWindows)("refuses an other-writable directory, for a missing file and an existing one", () => {
    for (const mode of [0o777, 0o757, 0o772, 0o702]) {
      const dir = mkdir(path.join(home, `w${mode.toString(8)}`), mode);
      write(path.join(dir, "have.json"));
      for (const name of ["new.json", "have.json"]) {
        expect(assertSafeTarget(path.join(dir, name), { allowMissing: true }), `${mode.toString(8)} ${name}`).toEqual({
          ok: false,
          reason: "unsafe-parent",
        });
      }
    }
  });

  it.skipIf(isWindows)("group-writable: accepted only for this user's directory in this user's primary group (Ubuntu's 0775 ~/.config)", () => {
    const dir = mkdir(path.join(home, "grp"), 0o755);
    const file = path.join(dir, "creds.json");
    // 0775, owned by the uid, group == getgid(): accepted.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid, 0o775, {}, myGid))).toEqual({ ok: true });
    // Same mode and owner, any other group: refused.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid, 0o775, {}, myGid + 1))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // Other-writable is refused whatever the group.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid, 0o777, {}, myGid))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid, 0o757, {}, myGid))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // Someone else's directory in my group is not mine.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid + 1000, 0o775, {}, myGid))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // No group id to compare: group-writable is refused.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(dir, myUid, 0o775, { getgid: undefined }, myGid))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
  });

  it.skipIf(isWindows)("a real 0775 directory of this user (gid is its own primary group here) is accepted, 0777 is not", () => {
    const dir = mkdir(path.join(home, "real775"), 0o775);
    fs.chownSync(dir, myUid, myGid);
    expect(assertSafeTarget(path.join(dir, "x.json"), { allowMissing: true })).toEqual({ ok: true });
    fs.chmodSync(dir, 0o777);
    expect(assertSafeTarget(path.join(dir, "x.json"), { allowMissing: true })).toEqual({ ok: false, reason: "unsafe-parent" });
  });

  it.skipIf(isWindows)("refuses an unsafe directory further up, below home, even when the immediate one is fine", () => {
    mkdir(path.join(home, "open"), 0o777);
    mkdir(path.join(home, "open", "inner"), 0o700);
    expect(assertSafeTarget(path.join(home, "open", "inner", "creds.json"), { allowMissing: true })).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // A missing directory in between is skipped: the nearest one that exists is what counts.
    expect(assertSafeTarget(path.join(home, "open", "not", "yet", "creds.json"), { allowMissing: true })).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
  });

  it.skipIf(isWindows)("another user pre-creating /tmp/jubarteai/sessions 0777 is refused (ownership and mode stubbed)", () => {
    const sessions = path.join(root, "tmp", "jubarteai", "sessions");
    mkdir(sessions, 0o700);
    const file = path.join(sessions, "abc.json");
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sessions, myUid + 1000, 0o777))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // Owned by someone else but not writable: still not ours to put a key in.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sessions, myUid + 1000, 0o755))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // Ours, 0700: fine.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sessions, myUid, 0o700))).toEqual({ ok: true });
  });

  it.skipIf(isWindows)("a root-owned sticky directory (/tmp itself) is accepted; root-owned without the sticky bit is not", () => {
    const tmp = mkdir(path.join(root, "faketmp"), 0o700);
    const file = path.join(tmp, "x.json");
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(tmp, 0, 0o1777))).toEqual({ ok: true });
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(tmp, 0, 0o777))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // Root-owned and not writable, but not the file's own to put a key in: only this user's directory (or sticky /tmp) will do.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(tmp, 0, 0o755))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    // The sticky bit does not excuse a directory some other user owns.
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(tmp, myUid + 1000, 0o1777))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
  });

  it.skipIf(isWindows)("a system directory above the file's own (root-owned, not writable) is fine outside home; a writable one is not", () => {
    const sys = mkdir(path.join(root, "other", "sys"), 0o755);
    mkdir(path.join(sys, "mine"), 0o700);
    const file = path.join(sys, "mine", "x.json");
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sys, 0, 0o755))).toEqual({ ok: true });
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sys, 0, 0o775))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
    expect(assertSafeTargetWith(file, { allowMissing: true }, withDir(sys, myUid + 1000, 0o755))).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
  });

  it("Windows: the directory rule is skipped", () => {
    const dir = mkdir(path.join(home, "shared"), 0o777);
    const win = withDir(dir, 12345, 0o777, { platform: "win32", getuid: undefined });
    expect(assertSafeTargetWith(path.join(dir, "x.json"), { allowMissing: true }, win)).toEqual({ ok: true });
  });

  it.skipIf(isWindows)("withinHome checks the real file's directory too", () => {
    const realDir = mkdir(path.join(home, "dotfiles"), 0o700);
    const target = write(path.join(realDir, "mcp.json"));
    const link = path.join(home, "mcp.json");
    fs.symlinkSync(target, link);
    expect(assertSafeTarget(link, { allowMissing: true, withinHome: true })).toEqual({ ok: true });
    fs.chmodSync(realDir, 0o777);
    expect(assertSafeTarget(link, { allowMissing: true, withinHome: true })).toEqual({ ok: false, reason: "unsafe-parent" });
    // A not-yet-created target is judged by the nearest directory that exists.
    expect(assertSafeTarget(path.join(realDir, "new", "x.json"), { allowMissing: true, withinHome: true })).toEqual({
      ok: false,
      reason: "unsafe-parent",
    });
  });
});

describe.skipIf(isWindows)("assertSafeTarget withinRoot (a file inside a project the repo's contents steer)", () => {
  function project(): string {
    const dir = path.join(home, "proj");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("a link whose target stays inside the project is followed (CLAUDE.md -> AGENTS.md)", () => {
    const proj = project();
    write(path.join(proj, "AGENTS.md"), "x\n");
    fs.symlinkSync("AGENTS.md", path.join(proj, "CLAUDE.md"));
    expect(assertSafeTarget(path.join(proj, "CLAUDE.md"), { allowMissing: false, withinRoot: proj })).toEqual({ ok: true });
  });

  it("a file link into the home directory (AGENTS.md -> ../.zshrc) is refused as symlink, even though home is allowed elsewhere", () => {
    const proj = project();
    const zshrc = write(path.join(home, ".zshrc"), "export A=1\n");
    fs.symlinkSync("../.zshrc", path.join(proj, "AGENTS.md"));
    expect(assertSafeTarget(path.join(proj, "AGENTS.md"), { allowMissing: true, withinRoot: proj })).toEqual({ ok: false, reason: "symlink" });
    expect(assertSafeTarget(path.join(proj, "AGENTS.md"), { allowMissing: true, withinHome: true })).toEqual({ ok: true });
    expect(fs.readFileSync(zshrc, "utf8")).toBe("export A=1\n");
  });

  it("a linked directory above the file (.codex -> ../.codex) is refused too, and a dangling link out of the project", () => {
    const proj = project();
    write(path.join(home, ".codex", "config.toml"), "a = 1\n");
    fs.symlinkSync("../.codex", path.join(proj, ".codex"));
    expect(assertSafeTarget(path.join(proj, ".codex", "config.toml"), { allowMissing: true, withinRoot: proj })).toEqual({ ok: false, reason: "symlink" });
    fs.symlinkSync("../nothing-yet", path.join(proj, "dangling.md"));
    expect(assertSafeTarget(path.join(proj, "dangling.md"), { allowMissing: true, withinRoot: proj })).toEqual({ ok: false, reason: "symlink" });
  });

  it("a project reached through a link is judged by its real path", () => {
    const proj = project();
    const alias = path.join(root, "alias");
    fs.symlinkSync(proj, alias);
    write(path.join(proj, "AGENTS.md"));
    expect(assertSafeTarget(path.join(alias, "AGENTS.md"), { allowMissing: false, withinRoot: alias })).toEqual({ ok: true });
    expect(assertSafeTarget(path.join(alias, "AGENTS.md"), { allowMissing: false, withinRoot: proj })).toEqual({ ok: true });
  });

  it("still refuses a hard-linked file and a foreign owner inside the project", () => {
    const proj = project();
    const file = write(path.join(proj, "AGENTS.md"));
    fs.linkSync(file, path.join(proj, "copy.md"));
    expect(assertSafeTarget(file, { allowMissing: false, withinRoot: proj })).toEqual({ ok: false, reason: "hardlink" });
    const other = write(path.join(proj, "OTHER.md"));
    expect(assertSafeTargetWith(other, { allowMissing: false, withinRoot: proj }, foreignFile(other))).toEqual({ ok: false, reason: "foreign-owner" });
  });
});
