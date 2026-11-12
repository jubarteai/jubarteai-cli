import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../errors.js";
import { convertBinding, findBinding, writeBinding } from "./binding.js";

const MARKER = "# jubarteai: private workspace binding";
const WORKSPACE = { id: "22222222-0000-4000-8000-000000000001", slug: "acme" };
const posix = process.platform !== "win32";

let sandbox: string;
let repo: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-binding-")));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  gitInit(repo);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
}

function gitInit(dir: string): void {
  git(dir, "init", "-q");
}

const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), "utf8");
const readJson = (...parts: string[]): unknown => JSON.parse(read(...parts));

function writeRaw(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, ".jubarteai"), { recursive: true });
  writeFileSync(join(dir, ".jubarteai", name), text);
}

function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("writeBinding private", () => {
  it("writes workspace and user into config.json and the two marked .gitignore lines", () => {
    expect(writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false })).toEqual({ changed: true, form: "private" });
    expect(readJson(".jubarteai", "config.json")).toEqual({
      version: 1,
      workspace: WORKSPACE,
      user: { email: "a@example.com" },
    });
    expect(existsSync(join(repo, ".jubarteai", "config.local.json"))).toBe(false);
    expect(existsSync(join(repo, ".jubarteai", ".gitignore"))).toBe(false);
    expect(read(".gitignore")).toBe(`${MARKER}\n/.jubarteai/\n`);
  });

  it("is idempotent and keeps existing .gitignore content", () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    const gitignore = read(".gitignore");
    expect(gitignore).toBe(`node_modules/\n${MARKER}\n/.jubarteai/\n`);
    expect(writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false })).toEqual({
      changed: false,
      form: "private",
    });
    expect(read(".gitignore")).toBe(gitignore);
  });

  it("never stores an origin or a key", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    const text = read(".jubarteai", "config.json");
    expect(text).not.toMatch(/origin|token|jba_|https?:/i);
  });

  it("rejects a workspace that would not read back", () => {
    expect(() => writeBinding(repo, { workspace: { id: WORKSPACE.id, slug: "a\nb" }, email: "a@example.com", shared: false })).toThrow(
      CliError,
    );
    expect(existsSync(join(repo, ".jubarteai"))).toBe(false);
  });
});

describe("writeBinding shared", () => {
  it("keeps the email out of config.json and puts it in the ignored local file", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    expect(readJson(".jubarteai", "config.json")).toEqual({ version: 1, workspace: WORKSPACE });
    expect(readJson(".jubarteai", "config.local.json")).toEqual({ version: 1, user: { email: "a@example.com" } });
    expect(read(".jubarteai", ".gitignore")).toBe("config.local.json\n");
    expect(read(".jubarteai", "config.json")).not.toContain("a@example.com");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("removes the marked repo-level lines but not foreign ones", () => {
    writeFileSync(join(repo, ".gitignore"), `keep/\n${MARKER}\n/.jubarteai/\n/.jubarteai-foreign/\n`);
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    expect(read(".gitignore")).toBe("keep/\n/.jubarteai-foreign/\n");
  });

  it("is idempotent", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    expect(writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true })).toEqual({ changed: false, form: "shared" });
  });
});

describe("convertBinding", () => {
  it("private to shared moves the email out of config.json, both ways", () => {
    writeFileSync(join(repo, ".gitignore"), "keep/\n");
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(convertBinding(repo, true)).toEqual({ changed: true, form: "shared" });
    expect(readJson(".jubarteai", "config.json")).toEqual({ version: 1, workspace: WORKSPACE });
    expect(readJson(".jubarteai", "config.local.json")).toEqual({ version: 1, user: { email: "a@example.com" } });
    expect(read(".gitignore")).toBe("keep/\n");
    expect(findBinding(repo)).toMatchObject({ shared: true, email: "a@example.com", workspace: WORKSPACE });

    expect(convertBinding(repo, false)).toEqual({ changed: true, form: "private" });
    expect(readJson(".jubarteai", "config.json")).toEqual({
      version: 1,
      workspace: WORKSPACE,
      user: { email: "a@example.com" },
    });
    expect(existsSync(join(repo, ".jubarteai", "config.local.json"))).toBe(false);
    expect(existsSync(join(repo, ".jubarteai", ".gitignore"))).toBe(false);
    expect(read(".gitignore")).toBe(`keep/\n${MARKER}\n/.jubarteai/\n`);
    expect(findBinding(repo)).toMatchObject({ shared: false, email: "a@example.com" });
  });

  it("converting to the form it already has changes nothing", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(convertBinding(repo, false)).toEqual({ changed: false, form: "private" });
  });

  it("keeps foreign lines in .jubarteai/.gitignore when going private", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    writeFileSync(join(repo, ".jubarteai", ".gitignore"), "mine.txt\nconfig.local.json\n");
    convertBinding(repo, false);
    expect(read(".jubarteai", ".gitignore")).toBe("mine.txt\n");
  });

  it("refuses to convert a folder with no binding, and a binding with no recorded account", () => {
    expect(thrown(() => convertBinding(repo, true)).exitCode).toBe(2);
    writeRaw(repo, "config.json", JSON.stringify({ version: 1, workspace: WORKSPACE }));
    expect(thrown(() => convertBinding(repo, false)).exitCode).toBe(2);
  });
});

describe("findBinding", () => {
  it("returns null with no binding anywhere up to the git top level", () => {
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(findBinding(join(repo, "a", "b"))).toBeNull();
  });

  it("finds a private binding from a subfolder, reporting dir, root, email and form", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(findBinding(join(repo, "src", "deep"))).toEqual({
      dir: join(repo, ".jubarteai"),
      root: repo,
      workspace: WORKSPACE,
      email: "a@example.com",
      shared: false,
    });
  });

  it("reads a shared binding's email from config.local.json, or null when it is absent", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    expect(findBinding(repo)).toMatchObject({ shared: true, email: "a@example.com" });
    rmSync(join(repo, ".jubarteai", "config.local.json"));
    expect(findBinding(repo)).toMatchObject({ shared: true, email: null });
  });

  it("the nearest binding wins", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "outer@example.com", shared: false });
    const inner = join(repo, "packages", "web");
    mkdirSync(inner, { recursive: true });
    const other = { id: "22222222-0000-4000-8000-000000000002", slug: "other" };
    writeBinding(inner, { workspace: other, email: "inner@example.com", shared: false });
    expect(findBinding(join(inner, "src"))?.workspace.slug).toBe("other");
    expect(findBinding(join(repo, "packages"))?.workspace.slug).toBe("acme");
  });

  it("stops at the git top level: a binding above the repo is not used", () => {
    writeBinding(sandbox, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(findBinding(repo)).toBeNull();
  });

  it("treats a .git file (worktree or submodule) as the top level too", () => {
    const worktree = join(sandbox, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
    writeBinding(sandbox, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(findBinding(worktree)).toBeNull();
  });

  it("outside git it walks up to the filesystem root", () => {
    const plain = join(sandbox, "plain", "sub");
    mkdirSync(plain, { recursive: true });
    writeBinding(sandbox, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(findBinding(plain)?.root).toBe(sandbox);
  });

  it("ignores any origin or key field: the binding names a workspace only", () => {
    writeRaw(
      repo,
      "config.json",
      JSON.stringify({
        version: 1,
        workspace: WORKSPACE,
        user: { email: "a@example.com" },
        origin: "https://evil.example.com",
        token: "jba_FAKEFAKE",
      }),
    );
    const found = findBinding(repo);
    expect(found).not.toBeNull();
    expect(Object.keys(found ?? {}).sort()).toEqual(["dir", "email", "root", "shared", "workspace"]);
    expect(JSON.stringify(found)).not.toMatch(/evil|jba_FAKE/);
  });

  it("malformed JSON is a fixed exit-2 error that never echoes the content", () => {
    writeRaw(repo, "config.json", '{"workspace": "secret-content-xyz" oops');
    const error = thrown(() => findBinding(repo));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain(join(repo, ".jubarteai", "config.json"));
    expect(error.message).not.toContain("secret-content-xyz");
  });

  it("does not skip a malformed inner binding for a valid outer one", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    const inner = join(repo, "pkg");
    writeRaw(inner, "config.json", "{nope");
    expect(thrown(() => findBinding(inner)).exitCode).toBe(2);
  });

  it.each([
    ["an unknown version", { version: 2, workspace: WORKSPACE }],
    ["no workspace", { version: 1 }],
    ["a slug with control characters", { version: 1, workspace: { id: WORKSPACE.id, slug: "a\u001b[31mb" } }],
    ["an email with whitespace", { version: 1, workspace: WORKSPACE, user: { email: "a b@example.com" } }],
    ["a user without an email", { version: 1, workspace: WORKSPACE, user: {} }],
  ])("rejects %s", (_name, doc) => {
    writeRaw(repo, "config.json", JSON.stringify(doc));
    expect(thrown(() => findBinding(repo)).exitCode).toBe(2);
  });

  it("rejects a malformed config.local.json on a shared binding", () => {
    writeRaw(repo, "config.json", JSON.stringify({ version: 1, workspace: WORKSPACE }));
    writeRaw(repo, "config.local.json", "garbage");
    expect(thrown(() => findBinding(repo)).exitCode).toBe(2);
  });

  it.skipIf(!posix)("refuses a config.json that is a symlink (a repo can ship one pointing anywhere)", () => {
    const target = join(sandbox, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ version: 1, workspace: WORKSPACE }));
    mkdirSync(join(repo, ".jubarteai"), { recursive: true });
    symlinkSync(target, join(repo, ".jubarteai", "config.json"));
    expect(thrown(() => findBinding(repo)).exitCode).toBe(2);
  });

  it("a .jubarteai folder with no config.json is not a binding", () => {
    writeRaw(repo, "config.local.json", JSON.stringify({ version: 1, user: { email: "a@example.com" } }));
    expect(findBinding(repo)).toBeNull();
  });
});

describe("private form never lands in a shared or tracked config.json", () => {
  const request = { workspace: WORKSPACE, email: "a@example.com", shared: false } as const;

  it("a committed shared config.json stays shared; the email goes only to config.local.json", () => {
    writeBinding(repo, { ...request, shared: true });
    git(repo, "add", "-f", ".jubarteai/config.json", ".jubarteai/.gitignore");
    const before = read(".jubarteai", "config.json");
    const result = writeBinding(repo, request);
    expect(result).toMatchObject({ form: "shared", reason: "existing-shared" });
    expect(read(".jubarteai", "config.json")).toBe(before);
    expect(read(".jubarteai", "config.json")).not.toContain("a@example.com");
    expect(readJson(".jubarteai", "config.local.json")).toEqual({ version: 1, user: { email: "a@example.com" } });
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("an untracked shared config.json also stays shared on a private write", () => {
    writeBinding(repo, { ...request, shared: true });
    expect(writeBinding(repo, request)).toEqual({ changed: false, form: "shared", reason: "existing-shared" });
  });

  it("a tracked private-form config.json is converted to the shared form on write", () => {
    writeBinding(repo, request);
    git(repo, "add", "-f", ".jubarteai/config.json");
    expect(read(".jubarteai", "config.json")).toContain("a@example.com");
    const result = writeBinding(repo, request);
    expect(result).toMatchObject({ changed: true, form: "shared", reason: "tracked" });
    expect(read(".jubarteai", "config.json")).not.toContain("a@example.com");
    expect(readJson(".jubarteai", "config.local.json")).toEqual({ version: 1, user: { email: "a@example.com" } });
    expect(read(".jubarteai", ".gitignore")).toBe("config.local.json\n");
    expect(read(".gitignore")).not.toContain(MARKER);
  });

  it("a fresh private write in a repo that does not track it stays private", () => {
    expect(writeBinding(repo, request)).toEqual({ changed: true, form: "private" });
    expect(read(".jubarteai", "config.json")).toContain("a@example.com");
  });

  it("convert to private refuses a tracked config.json and reports why", () => {
    writeBinding(repo, { ...request, shared: true });
    git(repo, "add", "-f", ".jubarteai/config.json");
    const result = convertBinding(repo, false);
    expect(result).toEqual({ changed: false, form: "shared", reason: "tracked" });
    expect(read(".jubarteai", "config.json")).not.toContain("a@example.com");
  });

  it("convert to private on an untracked shared binding is an explicit choice and is honoured", () => {
    writeBinding(repo, { ...request, shared: true });
    expect(convertBinding(repo, false)).toEqual({ changed: true, form: "private" });
  });

  describe("with git unavailable", () => {
    let savedPath: string | undefined;
    beforeEach(() => {
      savedPath = process.env.PATH;
      const empty = join(sandbox, "empty-bin");
      mkdirSync(empty);
      process.env.PATH = empty;
    });
    afterEach(() => {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    });

    it("fails closed inside a repository: shared form, reason tracked", () => {
      expect(writeBinding(repo, request)).toMatchObject({ changed: true, form: "shared", reason: "tracked" });
      expect(read(".jubarteai", "config.json")).not.toContain("a@example.com");
    });

    it("outside any repository there is nothing to track: private is written", () => {
      const plain = join(sandbox, "plain");
      mkdirSync(plain);
      expect(writeBinding(plain, request)).toEqual({ changed: true, form: "private" });
    });
  });
});

describe("findBinding ceilings and ownership", () => {
  it("outside git it never walks above the home directory", () => {
    const home = join(sandbox, "home");
    const project = join(home, "proj", "deep");
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    writeBinding(sandbox, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(findBinding(project)).toBeNull();
    writeBinding(home, { workspace: WORKSPACE, email: "a@example.com", shared: false });
    expect(findBinding(project)?.root).toBe(home);
  });

  it("a folder outside git and outside home checks only itself (a planted /tmp-like parent is ignored)", () => {
    const home = join(sandbox, "home");
    const shared = join(sandbox, "shared-tmp");
    const mine = join(shared, "work", "sub");
    mkdirSync(home);
    mkdirSync(mine, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    writeBinding(shared, { workspace: WORKSPACE, email: "planted@example.com", shared: false });
    expect(findBinding(mine)).toBeNull();
    expect(findBinding(shared)?.email).toBe("planted@example.com");
  });

  it.skipIf(!posix)("ignores a binding file owned by another user", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    expect(findBinding(repo)?.email).toBe("a@example.com");
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(findBinding(repo)).toBeNull();
  });

  it.skipIf(!posix)("ignores a foreign config.local.json but keeps the rest of the binding", () => {
    writeBinding(repo, { workspace: WORKSPACE, email: "a@example.com", shared: true });
    // Only the local file is foreign: make just that read look foreign by owning config.json via the real uid.
    const real = process.getuid;
    let calls = 0;
    vi.spyOn(process, "getuid").mockImplementation(() => {
      calls += 1;
      return (real?.call(process) ?? 0) + (calls > 1 ? 1 : 0);
    });
    expect(findBinding(repo)).toMatchObject({ shared: true, email: null });
  });

  it("rejects C1 control characters in a binding's values", () => {
    writeRaw(repo, "config.json", JSON.stringify({ version: 1, workspace: { id: WORKSPACE.id, slug: "acme" }, user: { email: "a\u0085b@example.com" } }));
    expect(thrown(() => findBinding(repo)).exitCode).toBe(2);
  });
});
