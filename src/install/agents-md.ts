// The "JubarteAI Agent Identity" section in a project's AGENTS.md, and the @AGENTS.md import in its CLAUDE.md.
// Ported from the app's update.sh (src/lib/update-script/instructions.ts) and install.sh (install-script.ts,
// "AGENTS.md / CLAUDE.md"; update-sh grill D6, D7, D12, D13, D24, D25, D26).
//
// What may change (D13): the section is appended when no file mentions JubarteAI, an older installer's section
// (byte-identical to a snippet in the history, slug filled in) is refreshed, and CLAUDE.md gets an @AGENTS.md line
// when Claude Code would otherwise not read the section. Anything else, such as an edited section, a file that only
// mentions JubarteAI, an unmarked or unbalanced marker pair, is reported and never touched. Zed's `.rules`-style files
// and Codex's `AGENTS.override.md` shadow AGENTS.md: reported only (D25). Run from `~` or `/`, nothing is planned (D26).
//
// Every write goes through a PlanStep and writeFileAtomic. Each step re-reads the files when it runs, so a plan that
// went stale (another process, an earlier step that was skipped) never overwrites newer text.
import * as nodeFs from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { homeDir } from "../paths.js";
import { SafeEditError, writeFileAtomic } from "../safe-edit/atomic-write.js";
import { defaultGuardEnv, realTarget, type RefusalReason } from "../safe-edit/file-guards.js";
import { repoGroup } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { AGENTS_MD_MARKERS, SKILL_REPO, agentsMdSnippet, agentsMdSnippetHistory } from "./constants.js";
import { runCommand, runCommandSync } from "./run.js";

export type SectionState = "missing" | "current" | "known-old" | "edited" | "shadowed";

export type InstructionOptions = {
  /**
   * init, like install.sh, also creates CLAUDE.md (`@AGENTS.md`) when it is the one that adds the section and
   * no CLAUDE.md-family file exists; update creates it only for a Claude Code that needs it (D13).
   */
  mode: "init" | "update";
  /** The repository's slug, filled into the section's `<repo-slug>`. Default: derived from `origin`, else the folder name. */
  slug?: string;
  /** The installed Claude Code's version, when known: before 2.1.277 it reads AGENTS.md only through an import. */
  claudeCodeVersion?: string | null;
};

export type InspectOptions = {
  slug?: string;
  claudeCodeVersion?: string | null;
  /**
   * Which harnesses are installed. A shadowing file is reported unless its harness is explicitly `false`:
   * the facts on disk are true whether or not the harness was detected.
   */
  harnesses?: { zed?: boolean; codex?: boolean };
};

/** The first Claude Code that reads AGENTS.md itself, without an @AGENTS.md import in CLAUDE.md. */
const NATIVE_AGENTS_MD_CLAUDE_CODE = "2.1.277";

/**
 * Files Zed reads instead of AGENTS.md when they exist in the project root, first match wins (AGENTS.md is 7th in
 * Zed's list; checked against zed-industries/zed docs/src/ai/rules.md).
 */
const ZED_RULES_BEFORE_AGENTS_MD: readonly string[] = [
  ".rules",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".github/copilot-instructions.md",
  "AGENT.md",
];

/** The files Claude Code reads for a project (besides the user's own). */
const CLAUDE_FAMILY: readonly string[] = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

const CURRENT_SECTION_URL = `https://github.com/${SKILL_REPO}/blob/main/AGENTS.md`;
const IMPORT_RE = /@(\.\/|\.\.\/)?AGENTS\.md/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A bigger instruction file is not read (and so not rewritten): it is not one a person edits by hand. */
const MAX_INSTRUCTIONS_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const NEW_FILE_MODE = 0o644;

type FileState = "missing" | "current" | "known-old" | "custom" | "mention" | "unreadable" | "linked" | "covered";
type Classified = { state: "missing" | "current" | "known-old" | "custom" | "mention"; next?: string };
type Loaded = { name: string; file: string; exists: boolean; text: string; state: FileState; next?: string };
type Texts = { current: string; old: string[]; section: string };
type Project = { root: string; agents: Loaded; claude: Loaded; texts: Texts };

// install.sh read its snippet with `read -r -d ''`, which trims blanks at both ends: do the same so the bytes match.
const trimBlanks = (s: string): string => s.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
const count = (text: string, needle: string): number => text.split(needle).length - 1;

function sectionTexts(slug: string | null): Texts {
  const fill = (snippet: string): string => {
    const trimmed = trimBlanks(snippet);
    return slug === null ? trimmed : trimmed.split("<repo-slug>").join(slug);
  };
  const current = fill(agentsMdSnippet());
  return {
    current,
    old: agentsMdSnippetHistory().map(fill),
    section: `${AGENTS_MD_MARKERS.begin}\n${current}\n${AGENTS_MD_MARKERS.end}`,
  };
}

/** What kind of text this is, and for a known-old section the text with it refreshed. */
function classify(text: string, texts: Texts): Classified {
  const { begin, end } = AGENTS_MD_MARKERS;
  const nb = count(text, begin);
  const ne = count(text, end);
  if (nb > 0 || ne > 0) {
    const b = text.indexOf(begin);
    const e = text.indexOf(end);
    if (nb !== 1 || ne !== 1 || e < b) return { state: "custom" };
    // The marker lines may end in \r\n (a CRLF file): the section's own text is compared with line endings normalized.
    const afterBegin = b + begin.length;
    const start = afterBegin + (text.startsWith("\r\n", afterBegin) ? 2 : 1);
    const finish = e - (text.startsWith("\n", e - 1) && text.charAt(e - 2) === "\r" ? 2 : 1);
    if (text.charAt(start - 1) !== "\n" || text.charAt(e - 1) !== "\n" || finish < start) return { state: "custom" };
    const crlf = text.startsWith("\r\n", afterBegin);
    const inner = crlf ? text.slice(start, finish).replace(/\r\n/g, "\n") : text.slice(start, finish);
    if (inner === texts.current) return { state: "current" };
    if (texts.old.includes(inner)) {
      const fresh = crlf ? texts.current.replace(/\n/g, "\r\n") : texts.current;
      return { state: "known-old", next: text.slice(0, start) + fresh + text.slice(finish) };
    }
    return { state: "custom" };
  }
  if (text.includes(texts.current)) return { state: "current" };
  for (const old of texts.old) {
    if (text.includes(old)) return { state: "known-old", next: text.split(old).join(texts.section) };
  }
  if (/^#{1,6}[ \t]*JubarteAI Agent Identity/im.test(text)) return { state: "custom" };
  if (/jubarteai/i.test(text)) return { state: "mention" };
  return { state: "missing" };
}

type Read = { kind: "absent" } | { kind: "bad" } | { kind: "ok"; text: string };

/** The file's text: regular files only (a repo can hold a FIFO), size-capped, strict UTF-8 with any BOM kept in the text. */
function readText(file: string): Read {
  try {
    const st = nodeFs.statSync(file);
    if (!st.isFile() || st.size > MAX_INSTRUCTIONS_BYTES) return { kind: "bad" };
    const bytes = nodeFs.readFileSync(file);
    return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "bad" };
  }
}

function isRegularFile(path: string): boolean {
  try {
    return nodeFs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return nodeFs.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The two paths are one file: a symlink either way round (dangling included), or a hard link. */
function sameFile(a: string, b: string): boolean {
  const fs = defaultGuardEnv().fs;
  if (realTarget(a, fs) === realTarget(b, fs)) return true;
  try {
    const sa = nodeFs.statSync(a);
    const sb = nodeFs.statSync(b);
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function hasSection(state: FileState): boolean {
  return state === "current" || state === "known-old" || state === "custom" || state === "mention";
}

function loadFile(root: string, name: string, texts: Texts): Loaded {
  const file = join(root, name);
  const read = readText(file);
  if (read.kind === "absent") return { name, file, exists: false, text: "", state: "missing" };
  if (read.kind === "bad") return { name, file, exists: true, text: "", state: "unreadable" };
  const c = classify(read.text, texts);
  return { name, file, exists: true, text: read.text, state: c.state, ...(c.next === undefined ? {} : { next: c.next }) };
}

function loadProject(root: string, texts: Texts): Project {
  const agents = loadFile(root, "AGENTS.md", texts);
  // CLAUDE.md that is AGENTS.md (a link either way round) is one file: it is only ever handled as AGENTS.md and
  // never given an @AGENTS.md import, which would make AGENTS.md import itself.
  const linked = sameFile(join(root, "CLAUDE.md"), join(root, "AGENTS.md"));
  const claude: Loaded = linked
    ? { name: "CLAUDE.md", file: join(root, "CLAUDE.md"), exists: true, text: "", state: "linked" }
    : loadFile(root, "CLAUDE.md", texts);
  // A section in either file covers the project (install.sh's cross-file guard).
  if (agents.state === "missing" && (hasSection(claude.state) || claude.state === "unreadable")) agents.state = "covered";
  return { root, agents, claude, texts };
}

type Family = { exists: boolean; covered: boolean };

/**
 * The CLAUDE.md-family files at the project root (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md): whether any exists,
 * and whether one already makes Claude Code read the section (it mentions JubarteAI, imports AGENTS.md, or is AGENTS.md).
 */
function claudeFamily(root: string): Family {
  let exists = false;
  let covered = false;
  const agents = join(root, "AGENTS.md");
  for (const name of CLAUDE_FAMILY) {
    const file = join(root, name);
    if (!isRegularFile(file)) continue;
    exists = true;
    const read = readText(file);
    if (read.kind === "ok" && (/jubarteai/i.test(read.text) || IMPORT_RE.test(read.text))) covered = true;
    if (sameFile(file, agents)) covered = true;
  }
  return { exists, covered };
}

function claudeFamilyLinked(root: string): boolean {
  const agents = join(root, "AGENTS.md");
  return CLAUDE_FAMILY.some((name) => {
    const file = join(root, name);
    return isSymlink(file) && sameFile(file, agents);
  });
}

function olderThan(version: string | null | undefined, floor: string): boolean {
  if (version === null || version === undefined) return false;
  const have = /^v?(\d+(?:\.\d+)*)/.exec(version.trim());
  if (have === null || have[1] === undefined) return false;
  const a = have[1].split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Why `root` is not a project (D26), or null when it is. `~` and `/` are never given an AGENTS.md or CLAUDE.md. */
export function notProjectReason(root: string): string | null {
  const physical = (p: string): string => {
    try {
      return nodeFs.realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const here = physical(root);
  if (here === physical(homeDir())) return "~ is your home folder, not a project";
  if (parse(here).root === here) return "/ is not a project folder";
  return null;
}

function validSlug(candidate: string | null): string | null {
  return candidate !== null && SLUG_RE.test(candidate) ? candidate : null;
}

/** The slug install.sh used: the last part of `origin`'s URL without `.git`, else the folder's name. Null when neither is a usable name. */
function deriveSlug(root: string): string | null {
  const res = runCommandSync("git", ["-c", "core.fsmonitor=false", "-C", root, "remote", "get-url", "origin"], { timeoutMs: GIT_TIMEOUT_MS });
  if (res.code === 0) {
    const last = res.stdout.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
    const fromRemote = validSlug(last.replace(/\.git$/, ""));
    if (fromRemote !== null) return fromRemote;
  }
  return validSlug(basename(resolve(root)));
}

function textsFor(root: string, slug: string | undefined): Texts {
  return sectionTexts(slug !== undefined ? validSlug(slug) : deriveSlug(root));
}

/** The state of the project's section as `doctor` and `update --check` show it. */
function publicState(p: Project): SectionState {
  const effective = p.agents.state === "covered" ? p.claude.state : p.agents.state;
  switch (effective) {
    case "current":
      return "current";
    case "known-old":
      return "known-old";
    case "custom":
    case "mention":
    case "unreadable":
      return "edited";
    default:
      return "missing";
  }
}

/** Zed reads the first of its own rules files before AGENTS.md: the first one that is not AGENTS.md itself. */
function zedShadow(root: string): string | null {
  const agents = join(root, "AGENTS.md");
  for (const name of ZED_RULES_BEFORE_AGENTS_MD) {
    const file = join(root, name);
    if (!isRegularFile(file)) continue;
    // A link to AGENTS.md reads the same text, so it shadows nothing.
    if (sameFile(file, agents)) continue;
    return name;
  }
  return null;
}

function codexShadow(root: string): boolean {
  return isRegularFile(join(root, "AGENTS.override.md"));
}

function claudeImport(p: Project, family: Family): "present" | "missing" | "n/a" {
  if (p.claude.state === "linked") return "present";
  if (!family.exists) return "n/a";
  if (family.covered) return "present";
  return p.agents.state === "unreadable" ? "n/a" : "missing";
}

/**
 * What the project's AGENTS.md and CLAUDE.md say, writing nothing. `reports` are the advisories (D13, D25): an edited
 * section, a file that only mentions JubarteAI, a file that shadows AGENTS.md, an old Claude Code. Empty for `~` and `/`.
 */
export function inspectInstructions(
  root: string,
  opts: InspectOptions = {},
): { agentsMd: SectionState; claudeMdImport: "present" | "missing" | "n/a"; reports: string[] } {
  const reason = notProjectReason(root);
  if (reason !== null) return { agentsMd: "missing", claudeMdImport: "n/a", reports: [] };
  const p = loadProject(root, textsFor(root, opts.slug));
  const family = claudeFamily(root);
  const reports: string[] = [];

  for (const f of [p.agents, p.claude]) {
    if (f.state === "custom") reports.push(`${f.name}: customised JubarteAI section — compare with the current one at ${CURRENT_SECTION_URL} by hand`);
    if (f.state === "mention")
      reports.push(`${f.name}: mentions JubarteAI without the standard section — left as it is; the current section is at ${CURRENT_SECTION_URL}`);
    if (f.state === "unreadable") reports.push(`${f.name}: couldn't read it — left as it is`);
  }

  const section = hasSection(p.agents.state) || p.agents.state === "missing" || hasSection(p.claude.state);
  if (olderThan(opts.claudeCodeVersion, NATIVE_AGENTS_MD_CLAUDE_CODE) && section && p.claude.state !== "linked" && !claudeFamilyLinked(root)) {
    reports.push(
      `CLAUDE.md: Claude Code ${String(opts.claudeCodeVersion).trim()} (before ${NATIVE_AGENTS_MD_CLAUDE_CODE}) reads AGENTS.md only through an @AGENTS.md import in CLAUDE.md — keep that line, or update Claude Code`,
    );
  }
  let shadowed = false;
  if (section && opts.harnesses?.zed !== false) {
    const earlier = zedShadow(root);
    if (earlier !== null) {
      shadowed = true;
      reports.push(`AGENTS.md: Zed reads ${earlier} instead of AGENTS.md — copy the JubarteAI section into it by hand for Zed's agent`);
    }
  }
  if (section && opts.harnesses?.codex !== false && codexShadow(root)) {
    shadowed = true;
    reports.push("AGENTS.md: Codex reads AGENTS.override.md instead of AGENTS.md here — copy the JubarteAI section into it by hand");
  }

  let agentsMd = publicState(p);
  // A shadowed section that still needs a refresh keeps saying so: the refresh is a change this CLI makes.
  if (shadowed && (agentsMd === "current" || agentsMd === "edited")) agentsMd = "shadowed";
  return { agentsMd, claudeMdImport: claudeImport(p, family), reports };
}

// --- writing ---------------------------------------------------------------------------------------------------

const REFUSED: Record<RefusalReason, string> = {
  symlink: "is a link, or sits in one, so",
  "reparse-point": "is a link, or sits in one, so",
  hardlink: "has other hard links, so",
  "foreign-owner": "is owned by another user, so",
  "outside-home": "is a link that leads outside your home folder, so",
  "unsafe-parent": "sits in a folder that others can write to, so",
};

function fileMode(file: string): number {
  try {
    return nodeFs.statSync(file).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

/**
 * Writes through writeFileAtomic: a symlinked file (CLAUDE.md -> AGENTS.md) is written through to what it names, but only
 * while that stays inside the project: a repo's own link to ~/.zshrc must never be followed.
 */
function writeText(root: string, file: string, content: string): void {
  writeFileAtomic(file, content, { mode: fileMode(file), withinRoot: root });
}

async function trackedByGit(file: string): Promise<boolean> {
  const real = realTarget(file, defaultGuardEnv().fs);
  const res = await runCommand("git", ["-c", "core.fsmonitor=false", "-C", dirname(real), "ls-files", "--error-unmatch", "--", real], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return res.code === 0;
}

type Outcome = { status: StepResult["status"]; detail?: string };

/** Runs one write and turns every way it can end into a fixed, secret-free result. */
async function attempt(root: string, file: string, name: string, content: string, verb: string): Promise<Outcome> {
  try {
    writeText(root, file, content);
  } catch (error) {
    // A refusal is the safe outcome, so it is a skip, not a failure (update-sh D13).
    if (error instanceof SafeEditError) return { status: "skipped", detail: `${name} ${REFUSED[error.reason]} it was left unchanged` };
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const safe = typeof code === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(code) ? code : "error";
    return { status: "failed", detail: `could not write ${name} (${safe})` };
  }
  const tracked = await trackedByGit(file);
  return { status: "configured", detail: tracked ? `${verb}; ${name} is tracked by git, review the change before you commit it` : verb };
}

function result(id: string, label: string, outcome: Outcome): StepResult {
  return outcome.detail === undefined ? { id, label, status: outcome.status } : { id, label, status: outcome.status, detail: outcome.detail };
}

const AGENTS_STEP = { id: "agents-md", label: "AGENTS.md section" };
const CLAUDE_SECTION_STEP = { id: "claude-md-section", label: "CLAUDE.md section" };
const CLAUDE_IMPORT_STEP = { id: "claude-md-import", label: "CLAUDE.md import" };

async function applyAgentsSection(root: string, slug: string | undefined): Promise<StepResult> {
  const { id, label } = AGENTS_STEP;
  const p = loadProject(root, textsFor(root, slug));
  const a = p.agents;
  switch (a.state) {
    case "missing":
      return result(id, label, a.exists
        ? await attempt(root, a.file, a.name, `${a.text}\n\n${p.texts.section}\n`, "appended")
        : await attempt(root, a.file, a.name, `${p.texts.section}\n`, "created"));
    case "known-old":
      return result(id, label, await attempt(root, a.file, a.name, a.next ?? a.text, "refreshed"));
    case "current":
      return { id, label, status: "already configured" };
    case "covered":
      return { id, label, status: "already configured", detail: "the section is in CLAUDE.md" };
    case "custom":
    case "mention":
      return { id, label, status: "skipped", detail: "customised, left as it is" };
    default:
      return { id, label, status: "skipped", detail: "could not read AGENTS.md, left as it is" };
  }
}

async function applyClaudeSection(root: string, slug: string | undefined): Promise<StepResult> {
  const { id, label } = CLAUDE_SECTION_STEP;
  const c = loadProject(root, textsFor(root, slug)).claude;
  if (c.state !== "known-old") return { id, label, status: "already configured" };
  return result(id, label, await attempt(root, c.file, c.name, c.next ?? c.text, "refreshed"));
}

type ImportAction = "append" | "create" | "covered" | "none";

/**
 * Whether root CLAUDE.md needs an @AGENTS.md line, and what to do about it. `fresh` says this run is the one that adds
 * the section to AGENTS.md (decided when the plan is made: by the time the import step runs, the section is there).
 */
function importAction(p: Project, family: Family, opts: InstructionOptions, fresh: boolean): ImportAction {
  const agentsHas = hasSection(p.agents.state) || p.agents.state === "missing";
  if (!agentsHas || p.claude.state === "linked") return "none";
  if (family.exists) {
    if (family.covered) return "covered";
    return p.claude.exists ? "append" : "create";
  }
  // No CLAUDE.md-family file: install creates one next to a section it just wrote, so every Claude Code reads it;
  // otherwise only a Claude Code that needs the import gets one.
  if ((opts.mode === "init" && fresh) || olderThan(opts.claudeCodeVersion, NATIVE_AGENTS_MD_CLAUDE_CODE)) return "create";
  return "none";
}

async function applyClaudeImport(root: string, opts: InstructionOptions, fresh: boolean): Promise<StepResult> {
  const { id, label } = CLAUDE_IMPORT_STEP;
  const p = loadProject(root, textsFor(root, opts.slug));
  // The section step ran first: a section that is still missing means it was refused, and an import to nothing helps no one.
  if (p.agents.state === "missing") return { id, label, status: "skipped", detail: "AGENTS.md has no JubarteAI section" };
  switch (importAction(p, claudeFamily(root), opts, fresh)) {
    case "append": {
      if (p.claude.state === "unreadable") return { id, label, status: "skipped", detail: "could not read CLAUDE.md, left as it is" };
      return result(id, label, await attempt(root, p.claude.file, p.claude.name, `${p.claude.text}\n@AGENTS.md\n`, "appended"));
    }
    case "create":
      return result(id, label, await attempt(root, p.claude.file, p.claude.name, "@AGENTS.md\n", "created"));
    default:
      return { id, label, status: "already configured" };
  }
}

/**
 * The non-sensitive steps that bring AGENTS.md and CLAUDE.md up to date: the section (append or refresh), a CLAUDE.md
 * that holds an old section, and the @AGENTS.md import. `init` lists the steps even when they have nothing to do, so a
 * re-run reports `already configured`; `update` lists only the ones with work. Empty for `~` and `/` (D26).
 */
export function planInstructionSteps(root: string, opts: InstructionOptions): PlanStep[] {
  if (notProjectReason(root) !== null) return [];
  const slug = opts.slug !== undefined ? validSlug(opts.slug) : deriveSlug(root);
  // Pass the resolved slug on, so the steps agree with this plan and run git once, not per step.
  const bound: InstructionOptions = slug === null ? { ...opts } : { ...opts, slug };
  const p = loadProject(root, sectionTexts(slug));
  const family = claudeFamily(root);
  const init = opts.mode === "init";
  const steps: PlanStep[] = [];

  const agentsFile = join(root, "AGENTS.md");
  const agentsWork = p.agents.state === "missing" || p.agents.state === "known-old";
  if (init || agentsWork) {
    steps.push({ ...AGENTS_STEP, group: repoGroup(root), files: [agentsFile], sensitive: false, apply: () => applyAgentsSection(root, bound.slug) });
  }
  if (p.claude.state === "known-old") {
    steps.push({ ...CLAUDE_SECTION_STEP, group: repoGroup(root), files: [p.claude.file], sensitive: false, apply: () => applyClaudeSection(root, bound.slug) });
  }
  const fresh = p.agents.state === "missing";
  const action = importAction(p, family, opts, fresh);
  if (action === "append" || action === "create" || (init && action === "covered")) {
    steps.push({ ...CLAUDE_IMPORT_STEP, group: repoGroup(root), files: [join(root, "CLAUDE.md")], sensitive: false, apply: () => applyClaudeImport(root, bound, fresh) });
  }
  return steps;
}
