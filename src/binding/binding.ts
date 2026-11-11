import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BINDING_VERSION } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { homeDir } from "../paths.js";
import { childEnv } from "../process-env.js";
import { SafeEditError, writeFileAtomic } from "../safe-edit/atomic-write.js";
import {
  ensureIgnoreBlock,
  ensurePrivateGitignore,
  removeFileSafely,
  removeIgnoreBlock,
  removePrivateGitignore,
} from "./gitignore.js";

export type Binding = {
  /** The `.jubarteai` folder. */
  dir: string;
  /** The folder that holds it. */
  root: string;
  workspace: { id: string; slug: string };
  email: string | null;
  shared: boolean;
};

const BINDING_DIR = ".jubarteai";
const CONFIG_FILE = "config.json";
const LOCAL_FILE = "config.local.json";
const LOCAL_IGNORE_FILE = ".gitignore";
const LOCAL_IGNORE_BLOCK: readonly string[] = [LOCAL_FILE];
const MAX_BINDING_BYTES = 64 * 1024;
const BINDING_FILE_MODE = 0o644;
const BINDING_DIR_MODE = 0o755;

// Values from a binding are echoed in messages and can come from a cloned repo: keep them printable.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,200}$/;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function bindingError(path: string): UsageError {
  return new UsageError(`The workspace binding at ${path} is not valid. Fix it, or run: jubarteai link`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one binding file as a regular file only (a repo can contain a symlink to anything). */
function readBindingFile(path: string): unknown | undefined {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw bindingError(path);
    // A file another user owns (a planted parent binding in a shared folder) is treated as absent.
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    size = stat.size;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const code = isRecord(error) ? error["code"] : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw bindingError(path);
  }
  if (size > MAX_BINDING_BYTES) throw bindingError(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // JSON errors quote file content; keep the message fixed.
    throw bindingError(path);
  }
}

function checkVersion(doc: unknown, path: string): Record<string, unknown> {
  if (!isRecord(doc) || doc["version"] !== BINDING_VERSION) throw bindingError(path);
  return doc;
}

function parseEmail(value: unknown, path: string): string {
  if (typeof value !== "string" || !EMAIL_RE.test(value) || hasControlCharacter(value)) throw bindingError(path);
  return value;
}

/** Only `workspace` and `user.email` are ever read: an origin or key in a binding has no effect (spec §3.2). */
function parseConfig(doc: unknown, path: string): { workspace: { id: string; slug: string }; email: string | null } {
  const config = checkVersion(doc, path);
  const workspace = config["workspace"];
  if (!isRecord(workspace)) throw bindingError(path);
  const id = workspace["id"];
  const slug = workspace["slug"];
  if (typeof id !== "string" || !ID_RE.test(id) || typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw bindingError(path);
  }
  const user = config["user"];
  if (user === undefined) return { workspace: { id, slug }, email: null };
  if (!isRecord(user)) throw bindingError(path);
  return { workspace: { id, slug }, email: parseEmail(user["email"], path) };
}

function parseLocal(doc: unknown, path: string): string {
  const local = checkVersion(doc, path);
  const user = local["user"];
  if (!isRecord(user)) throw bindingError(path);
  return parseEmail(user["email"], path);
}

function readBindingAt(root: string): Binding | null {
  const dir = join(root, BINDING_DIR);
  const configPath = join(dir, CONFIG_FILE);
  const doc = readBindingFile(configPath);
  if (doc === undefined) return null;
  const { workspace, email: privateEmail } = parseConfig(doc, configPath);
  if (privateEmail !== null) {
    return { dir, root, workspace, email: privateEmail, shared: false };
  }
  const localPath = join(dir, LOCAL_FILE);
  const localDoc = readBindingFile(localPath);
  const email = localDoc === undefined ? null : parseLocal(localDoc, localPath);
  return { dir, root, workspace, email, shared: true };
}

/** The nearest folder at or above `start` that holds `.git` (a directory, or a file for worktrees and submodules). */
function gitTopLevel(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The nearest `.jubarteai/config.json`, walking up from `cwd` to the git top level (a folder holding
 * `.git`, as a directory or a file). Outside git the walk stops at the home directory, and a folder
 * outside both checks only itself, so a binding planted in a shared parent (such as /tmp) is never
 * found. Throws a UsageError (exit 2) for a binding that exists but is not valid, rather than skipping
 * to an outer one; a binding owned by another user is ignored.
 */
export function findBinding(cwd: string): Binding | null {
  const start = resolve(cwd);
  const gitTop = gitTopLevel(start);
  let ceiling: string;
  if (gitTop !== null) {
    ceiling = gitTop;
  } else {
    const home = resolve(homeDir());
    ceiling = isInsideOrEqual(start, home) ? home : start;
  }
  let current = start;
  for (;;) {
    const found = readBindingAt(current);
    if (found !== null) return found;
    if (current === ceiling) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function writeRepoFile(path: string, data: string): void {
  try {
    writeFileAtomic(path, data, { mode: BINDING_FILE_MODE, dirMode: BINDING_DIR_MODE });
  } catch (error) {
    if (error instanceof SafeEditError) {
      throw new CliError(`Cannot write ${path}: refused (${error.reason}).`, ExitCode.SERVER_ERROR, "binding_unsafe");
    }
    throw new CliError(`Cannot write ${path}.`, ExitCode.SERVER_ERROR, "binding_unwritable");
  }
}

function currentText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Writes `path` only when its content differs, so a re-run changes nothing. */
function writeIfChanged(path: string, value: unknown): boolean {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (currentText(path) === text) return false;
  writeRepoFile(path, text);
  return true;
}

type BindingInput = { workspace: { id: string; slug: string }; email: string; shared: boolean };

/** What a write did. `form` is the form now on disk; `reason` says why a requested private form became shared. */
export type BindingWriteResult = {
  changed: boolean;
  form: "private" | "shared";
  reason?: "tracked" | "existing-shared";
};

const GIT_TIMEOUT_MS = 5_000;

/**
 * Whether git tracks `.jubarteai/config.json` in `root`. Fails closed: when git can't answer (missing,
 * timed out, refused the folder) inside a repository, the file counts as tracked.
 */
function isTrackedByGit(root: string): boolean {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", `${BINDING_DIR}/${CONFIG_FILE}`], {
    cwd: root,
    env: childEnv(),
    timeout: GIT_TIMEOUT_MS,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  if (result.error === undefined && result.status === 0) return true;
  // Exit 1 is git saying the path is not in the index.
  if (result.error === undefined && result.status === 1) return false;
  return gitTopLevel(root) !== null;
}

/** True when `<root>/.jubarteai/config.json` exists, is valid, and records no email (the shared form). */
function isSharedFormOnDisk(root: string): boolean {
  const configPath = join(root, BINDING_DIR, CONFIG_FILE);
  try {
    const doc = readBindingFile(configPath);
    return doc !== undefined && parseConfig(doc, configPath).email === null;
  } catch {
    return false;
  }
}

/**
 * Brings `<root>/.jubarteai` to the requested form. The order keeps the address out of anything git
 * could pick up at every step: a private binding is ignored before the email is written into it, and
 * a shared one moves the email into the ignored local file before it leaves `config.json`.
 */
function applyBinding(root: string, input: BindingInput, reason?: "tracked" | "existing-shared"): BindingWriteResult {
  const dir = join(root, BINDING_DIR);
  const configPath = join(dir, CONFIG_FILE);
  const localPath = join(dir, LOCAL_FILE);
  const localIgnorePath = join(dir, LOCAL_IGNORE_FILE);
  const workspace = { id: input.workspace.id, slug: input.workspace.slug };
  if (!ID_RE.test(workspace.id) || !SLUG_RE.test(workspace.slug)) throw bindingError(configPath);
  const email = parseEmail(input.email, configPath);
  let changed = false;

  if (input.shared) {
    changed = ensureIgnoreBlock(localIgnorePath, LOCAL_IGNORE_BLOCK).changed || changed;
    changed = writeIfChanged(localPath, { version: BINDING_VERSION, user: { email } }) || changed;
    changed = writeIfChanged(configPath, { version: BINDING_VERSION, workspace }) || changed;
    changed = removePrivateGitignore(root).changed || changed;
    return reason === undefined ? { changed, form: "shared" } : { changed, form: "shared", reason };
  }
  changed = ensurePrivateGitignore(root).changed || changed;
  changed = writeIfChanged(configPath, { version: BINDING_VERSION, workspace, user: { email } }) || changed;
  changed = removeFileSafely(localPath).changed || changed;
  changed = removeIgnoreBlock(localIgnorePath, LOCAL_IGNORE_BLOCK, { deleteWhenEmpty: true }).changed || changed;
  return { changed, form: "private" };
}

/**
 * Creates or replaces the binding in `root`. A private request never puts an address into a
 * `config.json` that is already in the shared form or that git tracks (it would be committed): the
 * shared form is written instead, with the email in the ignored `config.local.json`, and `reason` says why.
 */
export function writeBinding(root: string, b: BindingInput): BindingWriteResult {
  const absolute = resolve(root);
  if (!b.shared) {
    if (isSharedFormOnDisk(absolute)) return applyBinding(absolute, { ...b, shared: true }, "existing-shared");
    if (isTrackedByGit(absolute)) return applyBinding(absolute, { ...b, shared: true }, "tracked");
  }
  return applyBinding(absolute, b);
}

/**
 * Switches an existing binding in `root` between the shared and private forms, keeping workspace and
 * email. Going private on a `config.json` git tracks is refused the same way (it stays shared, with
 * `reason: "tracked"`); an explicit switch of an untracked shared binding is honoured.
 */
export function convertBinding(root: string, shared: boolean): BindingWriteResult {
  const absolute = resolve(root);
  const existing = readBindingAt(absolute);
  if (existing === null) {
    throw new UsageError("This folder has no workspace binding. Run: jubarteai link");
  }
  if (existing.email === null) {
    throw new UsageError("This binding has no account recorded. Run: jubarteai link");
  }
  const input = { workspace: existing.workspace, email: existing.email };
  if (!shared && isTrackedByGit(absolute)) return applyBinding(absolute, { ...input, shared: true }, "tracked");
  return applyBinding(absolute, { ...input, shared });
}
