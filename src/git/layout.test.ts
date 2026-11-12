import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitTop, linkedWorktree, originSlug, slugFromRemoteUrl } from "./layout.js";

const IS_WINDOWS = process.platform === "win32";
const posix = IS_WINDOWS ? it.skip : it;

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "jba-layout-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

function repoWithWorktree(): { main: string; tree: string } {
  const main = path.join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  writeFileSync(path.join(main, "a.txt"), "a");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const tree = path.join(root, "4f6a6395-feature");
  git(main, "worktree", "add", "-q", tree);
  return { main, tree };
}

describe("gitTop", () => {
  it("finds the nearest folder holding .git, directory or file", () => {
    mkdirSync(path.join(root, "a", ".git"), { recursive: true });
    mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(path.join(root, "a", "b", ".git"), "gitdir: x\n");
    expect(gitTop(path.join(root, "a", "b", "c"))).toBe(path.join(root, "a", "b"));
    expect(gitTop(path.join(root, "a"))).toBe(path.join(root, "a"));
  });
  it("is null outside git", () => {
    mkdirSync(path.join(root, "plain"));
    expect(gitTop(path.join(root, "plain"))).toBeNull();
  });
});

describe("linkedWorktree", () => {
  posix("returns the main checkout for a real git worktree", () => {
    const { main, tree } = repoWithWorktree();
    const found = linkedWorktree(tree);
    expect(found?.mainCheckout).toBe(main);
    expect(found?.top).toBe(tree);
    expect(found?.commonDir).toBe(path.join(main, ".git"));
  });

  posix("is null for the main checkout itself", () => {
    const { main } = repoWithWorktree();
    expect(linkedWorktree(main)).toBeNull();
  });

  posix("rejects a forged .git file that points at someone else's git dir", () => {
    const { main } = repoWithWorktree();
    const forged = path.join(root, "forged");
    mkdirSync(forged);
    const realGitDir = path.join(main, ".git", "worktrees", "4f6a6395-feature");
    writeFileSync(path.join(forged, ".git"), `gitdir: ${realGitDir}\n`);
    expect(linkedWorktree(forged)).toBeNull();
    writeFileSync(path.join(forged, ".git"), "gitdir: /elsewhere\n");
    expect(linkedWorktree(forged)).toBeNull();
  });

  posix("is null for a submodule-style .git file (no commondir)", () => {
    const sub = path.join(root, "sub");
    const modules = path.join(root, "super", ".git", "modules", "sub");
    mkdirSync(sub);
    mkdirSync(modules, { recursive: true });
    writeFileSync(path.join(sub, ".git"), `gitdir: ${modules}\n`);
    expect(linkedWorktree(sub)).toBeNull();
  });

  posix("a worktree of a bare repository has no main checkout", () => {
    const bare = path.join(root, "bare.git");
    git(root, "init", "-q", "--bare", bare);
    const seed = path.join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q");
    writeFileSync(path.join(seed, "a.txt"), "a");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", bare, "HEAD:refs/heads/main");
    const tree = path.join(root, "bare-tree");
    git(bare, "worktree", "add", "-q", tree, "main");
    const found = linkedWorktree(tree);
    expect(found).not.toBeNull();
    expect(found?.mainCheckout).toBeNull();
  });

  it("does not import child_process", () => {
    const source = readFileSync(new URL("./layout.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process/);
  });
});

describe("slugFromRemoteUrl / originSlug", () => {
  it("canonicalises ssh, https and relative remotes", () => {
    expect(slugFromRemoteUrl("git@github.com:org/JubarteAI.git")).toBe("jubarteai");
    expect(slugFromRemoteUrl("https://github.com/org/jubarteai.git")).toBe("jubarteai");
    expect(slugFromRemoteUrl("../jubarteai")).toBe("jubarteai");
    expect(slugFromRemoteUrl("https://github.com/org/jubarteai/")).toBe("jubarteai");
    expect(slugFromRemoteUrl("")).toBeNull();
    expect(slugFromRemoteUrl("https://x/y/-bad")).toBeNull();
    expect(slugFromRemoteUrl("https://x/y/we ird")).toBeNull();
  });

  it("reads [remote \"origin\"] from the config and ignores other remotes", () => {
    const dir = path.join(root, "gd");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "config"), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@h:o/other.git\n[remote "origin"]\n\turl = git@github.com:org/JubarteAI.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    expect(originSlug(dir)).toBe("jubarteai");
  });

  it("is null with no origin, no config, or an oversize config", () => {
    const dir = path.join(root, "gd2");
    mkdirSync(dir);
    expect(originSlug(dir)).toBeNull();
    writeFileSync(path.join(dir, "config"), '[remote "upstream"]\n\turl = x/y.git\n');
    expect(originSlug(dir)).toBeNull();
    writeFileSync(path.join(dir, "config"), `[remote "origin"]\n\turl = x/y.git\n${"#".repeat(70 * 1024)}`);
    expect(originSlug(dir)).toBeNull();
  });
});
