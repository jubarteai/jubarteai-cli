import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import {
  ensureIgnoreBlock,
  ensurePrivateGitignore,
  hasIgnoreBlock,
  removeFileSafely,
  removeIgnoreBlock,
  removePrivateGitignore,
} from "./gitignore.js";

const MARKER = "# jubarteai: private workspace binding";
const PATTERN = "/.jubarteai/";
const posix = process.platform !== "win32";

let root: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jba-gitignore-")));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  rmSync(root, { recursive: true, force: true });
});

const file = (): string => join(root, ".gitignore");

describe("ensurePrivateGitignore", () => {
  it("creates the file with exactly the two marked lines", () => {
    expect(ensurePrivateGitignore(root)).toEqual({ changed: true });
    expect(readFileSync(file(), "utf8")).toBe(`${MARKER}\n${PATTERN}\n`);
  });

  it("appends after existing content, keeping every existing line and the trailing newline", () => {
    writeFileSync(file(), "node_modules/\n.env\n");
    ensurePrivateGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(`node_modules/\n.env\n${MARKER}\n${PATTERN}\n`);
  });

  it("adds the missing final newline before appending", () => {
    writeFileSync(file(), "dist");
    ensurePrivateGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(`dist\n${MARKER}\n${PATTERN}\n`);
  });

  it("is idempotent", () => {
    writeFileSync(file(), "dist/\n");
    ensurePrivateGitignore(root);
    const once = readFileSync(file(), "utf8");
    expect(ensurePrivateGitignore(root)).toEqual({ changed: false });
    expect(readFileSync(file(), "utf8")).toBe(once);
  });

  it("keeps CRLF line endings", () => {
    writeFileSync(file(), "dist/\r\n");
    ensurePrivateGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(`dist/\r\n${MARKER}\r\n${PATTERN}\r\n`);
    expect(ensurePrivateGitignore(root)).toEqual({ changed: false });
  });

  it.skipIf(!posix)("keeps the file's existing mode", () => {
    writeFileSync(file(), "dist/\n");
    chmodSync(file(), 0o600);
    ensurePrivateGitignore(root);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("refuses a symlinked .gitignore and writes nothing through it", () => {
    const decoy = join(root, "decoy");
    writeFileSync(decoy, "untouched\n");
    symlinkSync(decoy, file());
    expect(() => ensurePrivateGitignore(root)).toThrow(CliError);
    expect(readFileSync(decoy, "utf8")).toBe("untouched\n");
  });
});

describe("removePrivateGitignore", () => {
  it("removes exactly the two marked lines and leaves everything else", () => {
    writeFileSync(file(), `a/\n${MARKER}\n${PATTERN}\nb/\n`);
    expect(removePrivateGitignore(root)).toEqual({ changed: true });
    expect(readFileSync(file(), "utf8")).toBe("a/\nb/\n");
  });

  it("leaves a foreign /.jubarteai/ line and a foreign comment alone", () => {
    const body = `# mine\n${PATTERN}\n# jubarteai: something else\n`;
    writeFileSync(file(), body);
    expect(removePrivateGitignore(root)).toEqual({ changed: false });
    expect(readFileSync(file(), "utf8")).toBe(body);
  });

  it("removes only the marked pair when the user also has their own /.jubarteai/ line", () => {
    writeFileSync(file(), `${PATTERN}\n${MARKER}\n${PATTERN}\n`);
    removePrivateGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(`${PATTERN}\n`);
  });

  it("round-trips: ensure then remove restores the original bytes", () => {
    const original = "node_modules/\n\n# keep\n.env";
    writeFileSync(file(), `${original}\n`);
    ensurePrivateGitignore(root);
    removePrivateGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(`${original}\n`);
  });

  it("does nothing when there is no file", () => {
    expect(removePrivateGitignore(root)).toEqual({ changed: false });
    expect(existsSync(file())).toBe(false);
  });
});

describe("ensureIgnoreBlock / removeIgnoreBlock", () => {
  it("manages a single-line block and deletes a file it empties when asked", () => {
    const path = join(root, "inner.gitignore");
    expect(ensureIgnoreBlock(path, ["config.local.json"])).toEqual({ changed: true });
    expect(ensureIgnoreBlock(path, ["config.local.json"])).toEqual({ changed: false });
    expect(removeIgnoreBlock(path, ["config.local.json"], { deleteWhenEmpty: true })).toEqual({ changed: true });
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a file that still has foreign lines", () => {
    const path = join(root, "inner.gitignore");
    writeFileSync(path, "other\nconfig.local.json\n");
    removeIgnoreBlock(path, ["config.local.json"], { deleteWhenEmpty: true });
    expect(readFileSync(path, "utf8")).toBe("other\n");
  });
});

describe("hasIgnoreBlock", () => {
  const BLOCK = ["# jubarteai: private Codex network setting", "/.codex/config.toml"];

  it("is true only for the block's lines in order and next to each other", () => {
    const path = join(root, ".gitignore");
    writeFileSync(path, `node_modules\n${BLOCK.join("\n")}\ndist\n`);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(true);
    // Both lines, but apart: not the block init writes.
    writeFileSync(path, `${BLOCK[0]}\nother\n${BLOCK[1]}\n`);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(false);
    // Reversed.
    writeFileSync(path, `${BLOCK[1]}\n${BLOCK[0]}\n`);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(false);
    // Only the pattern, with no marker: the user's own line.
    writeFileSync(path, `${BLOCK[1]}\n`);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(false);
  });

  it("reads the block written by ensureIgnoreBlock, with CRLF line ends and trailing spaces too", () => {
    const path = join(root, ".gitignore");
    ensureIgnoreBlock(path, BLOCK);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(true);
    writeFileSync(path, `a\r\n${BLOCK[0]}  \r\n${BLOCK[1]}\r\n`);
    expect(hasIgnoreBlock(path, BLOCK)).toBe(true);
  });

  it("is false, never a throw, for a missing file, a directory or a refused symlink", () => {
    expect(hasIgnoreBlock(join(root, "missing.gitignore"), BLOCK)).toBe(false);
    expect(hasIgnoreBlock(root, BLOCK)).toBe(false);
    if (posix) {
      const target = join(root, "elsewhere");
      writeFileSync(target, `${BLOCK.join("\n")}\n`);
      const link = join(root, "linked.gitignore");
      symlinkSync(target, link);
      expect(hasIgnoreBlock(link, BLOCK)).toBe(false);
    }
  });
});

describe("removeFileSafely", () => {
  it("removes a file and reports a missing one as unchanged", () => {
    const path = join(root, "x.json");
    writeFileSync(path, "{}");
    expect(removeFileSafely(path)).toEqual({ changed: true });
    expect(removeFileSafely(path)).toEqual({ changed: false });
  });
});
