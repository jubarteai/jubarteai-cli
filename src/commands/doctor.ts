import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { Writable } from "node:stream";

import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { readCredentialsReport } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { whoami } from "../auth/whoami.js";
import { findBinding, mainCheckoutBinding } from "../binding/binding.js";
import { CLI_NAME, cliVersion } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { codexUserFile, readCodexEntry, seatForBearer } from "../harness/codex-entry.js";
import { defaultDetectEnv, detectHarnesses } from "../harness/detect.js";
import { shownPath } from "../harness/mcp-cleanup.js";
import type { HarnessAdapter, InitCtx } from "../harness/types.js";
import { ownHookFile } from "../hooks/events.js";
import { inspectInstructions, notProjectReason } from "../install/agents-md.js";
import { resolveCliCommand } from "../install/cli-command.js";
import { runCommand } from "../install/run.js";
import { fetchLatestVersion, isNewer } from "../install/self-update.js";
import { detectSkillChannels } from "../install/skill.js";
import type { SkillChannel } from "../install/skill.js";
import { meetsNodeFloor } from "../node-floor.js";
import { safeForDisplay, writeJson } from "../output.js";
import { envOrigin, takeEnvToken } from "../process-env.js";
import { readJsonObject } from "../safe-edit/json-edit.js";
import { statusCommand } from "./status.js";

// `jubarteai doctor` (spec section 5.5): `status`, then live checks. Output is plain text for people (stdout), or
// one JSON object with --json.
//
// Levels. fail: a stored key the server refuses (invalid, revoked, seat canceled, billing inactive), Node below the
// floor, saved logins or the project's instruction file unreadable. warn: everything advisory, including anything the
// network could not answer (offline, a server error) and every harness or skill finding. ok: the check passed.
// Exit 1 when any check is fail, else 0.
//
// Secrets: a key is only ever the Authorization header of `whoami`. A check reports the server's status code word
// (a lowercase_snake string), never the key, a response body or an error message built from either.

/** One request's cap. The checks run together, so the whole run stays near this plus the local file reads. */
const NETWORK_TIMEOUT_MS = 5_000;
/** A local probe (a child process, a directory walk) that has not answered by then is reported as not finished. */
const LOCAL_DEADLINE_MS = 8_000;
const GIT_TIMEOUT_MS = 5_000;
const DETAIL_LIMIT = 300;

type Level = "ok" | "warn" | "fail";

type Check = {
  id: string;
  level: Level;
  label: string;
  detail: string;
  /** Extra structured facts for --json (adapter state, skill copies, section state). */
  data?: Record<string, unknown>;
};

const text = (value: string): string => safeForDisplay(value, DETAIL_LIMIT);

/** The promise's value, or `fallback` when it has not settled in `ms` (the timer never keeps the process alive). */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Account checks
// ---------------------------------------------------------------------------

/** A server-supplied error code is shown only when it is a plain lowercase word, so it can't carry anything else. */
function cleanCode(code: string | undefined): string | null {
  return code !== undefined && /^[a-z][a-z_]{0,39}$/.test(code) ? code : null;
}

/** What a failed `whoami` means: the status word printed, and whether it is a failure (auth) or advisory (could not tell). */
function describeWhoamiFailure(error: unknown): { word: string; level: Level } {
  if (!(error instanceof CliError)) return { word: "error", level: "warn" };
  const code = cleanCode(error.code);
  if (error.exitCode === ExitCode.AUTH) return { word: code ?? "rejected", level: "fail" };
  if (error.exitCode === ExitCode.NETWORK) return { word: code === "server_error" ? "server_error" : "unreachable", level: "warn" };
  return { word: code ?? "error", level: "warn" };
}

async function seatCheck(id: string, label: string, origin: string, token: string): Promise<Check> {
  try {
    await whoami(origin, token, { timeoutMs: NETWORK_TIMEOUT_MS });
    return { id, level: "ok", label, detail: "ok", data: { status: "ok" } };
  } catch (error) {
    const { word, level } = describeWhoamiFailure(error);
    return { id, level, label, detail: word, data: { status: word } };
  }
}

function seatLabel(seat: StoredSeat): string {
  const email = seat.user.email === "" ? "unknown user" : seat.user.email;
  return text(`${email} — ${seat.company.slug}`);
}

type Account = { credentials: Check; seats: Check[] };

async function accountChecks(): Promise<Account> {
  let seats: Array<[string, StoredSeat]> = [];
  let credentials: Check;
  try {
    const report = readCredentialsReport();
    seats = Object.entries(report.credentials.seats);
    const invalid = report.invalid_seats;
    const count = seats.length;
    if (count === 0) {
      credentials = { id: "credentials", level: "warn", label: "Saved logins", detail: "none. Run: jubarteai login", data: { count, unreadable: invalid.length } };
    } else {
      const skipped = invalid.length === 0 ? "" : `, ${invalid.length} unreadable ${invalid.length === 1 ? "entry" : "entries"} skipped`;
      credentials = {
        id: "credentials",
        level: invalid.length === 0 ? "ok" : "warn",
        label: "Saved logins",
        detail: `${count} saved${skipped}`,
        data: { count, unreadable: invalid.length },
      };
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    credentials = { id: "credentials", level: "fail", label: "Saved logins", detail: `unreadable. ${text(error.message)}`, data: { count: 0, unreadable: 0 } };
  }

  const checks: Array<Promise<Check>> = seats.map(([seatId, seat]) => seatCheck(`seat:${text(seatId)}`, `Login ${seatLabel(seat)}`, seat.origin, seat.token));
  const envToken = takeEnvToken();
  if (envToken !== null) {
    let origin: string | null = null;
    try {
      origin = envOrigin();
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
    }
    checks.push(
      origin === null
        ? Promise.resolve<Check>({ id: "env_token", level: "warn", label: "Login from JUBARTEAI_TOKEN", detail: "invalid_origin", data: { status: "invalid_origin" } })
        : seatCheck("env_token", "Login from JUBARTEAI_TOKEN", origin, envToken),
    );
  }
  return { credentials, seats: await Promise.all(checks) };
}

// ---------------------------------------------------------------------------
// Machine checks
// ---------------------------------------------------------------------------

function nodeCheck(): Check {
  const version = process.versions.node;
  const ok = meetsNodeFloor(version);
  return {
    id: "node",
    level: ok ? "ok" : "fail",
    label: "Node",
    detail: ok ? `v${version}` : `v${version} is below what jubarteai needs. Install a current Node LTS (22.23.5, 24.22.3, 26.13.1 or newer)`,
    data: { version, meets_floor: ok },
  };
}

async function versionCheck(): Promise<Check> {
  const current = cliVersion();
  const latest = await fetchLatestVersion({ timeoutMs: NETWORK_TIMEOUT_MS });
  if (latest === null) {
    return { id: "cli_version", level: "warn", label: "jubarteai version", detail: `${current}; couldn't check for a newer one`, data: { current, latest: null } };
  }
  if (isNewer(latest, current)) {
    return { id: "cli_version", level: "warn", label: "jubarteai version", detail: `${current}; ${latest} is available. Run: jubarteai update`, data: { current, latest } };
  }
  return { id: "cli_version", level: "ok", label: "jubarteai version", detail: `${current}, up to date`, data: { current, latest } };
}

// ---------------------------------------------------------------------------
// Project and harness checks
// ---------------------------------------------------------------------------

/** The folder's git top level, or null when it is not in a repository. */
async function gitTopLevel(cwd: string): Promise<string | null> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const line = result.code === 0 ? result.stdout.trim() : "";
  return line === "" ? null : line;
}

type Project = { root: string | null; note: string | null };

async function findProject(cwd: string): Promise<Project> {
  const top = await gitTopLevel(cwd);
  if (top === null) return { root: null, note: "this folder is not in a git repository" };
  const reason = notProjectReason(top);
  return reason === null ? { root: top, note: null } : { root: null, note: reason };
}

function adapterLevel(state: { permission: string; hooks: string; mcpEntries: string[]; notes: string[] }): Level {
  const settled = (value: string): boolean => value === "configured" || value === "n/a";
  return settled(state.permission) && settled(state.hooks) && state.mcpEntries.length === 0 && state.notes.length === 0 ? "ok" : "warn";
}

async function harnessCheck(adapter: HarnessAdapter, ctx: InitCtx): Promise<Check> {
  const id = `harness:${adapter.id}`;
  const label = `Harness ${adapter.label}`;
  try {
    const state = await adapter.inspect(ctx);
    const parts = [`permission ${state.permission}`, `hooks ${state.hooks}`];
    const entries = state.mcpEntries.map((file) => shownPath(file, ctx.home));
    if (entries.length > 0) parts.push(`leftover MCP entry in ${entries.join(", ")} (run: jubarteai init)`);
    for (const note of state.notes) parts.push(note);
    return {
      id,
      level: adapterLevel(state),
      label,
      detail: text(parts.join("; ")),
      data: { permission: state.permission, hooks: state.hooks, mcp_entries: entries, notes: state.notes.map(text) },
    };
  } catch {
    return { id, level: "warn", label, detail: "couldn't inspect it", data: { permission: null, hooks: null, mcp_entries: [], notes: [] } };
  }
}

// ---- the commands init registered in a harness's hook file ------------------------------------------------

/** A command of ours: `<program…> hook <event> --harness <id>`; `program` is everything before `hook`. */
const HOOK_COMMAND = /^(.*?)\s+hook\s+[a-z][a-z-]*\s+--harness\s+[a-z][a-z-]*(?:\s|$)/s;

/** The file whose `hooks` entry holds the harness's jubarteai hooks, or null for a harness the CLI registers none in. */
function hooksFile(adapter: HarnessAdapter, ctx: InitCtx): string | null {
  return ownHookFile(adapter.id, ctx.home, ctx.env);
}

/** Every string under a `command` key anywhere in the document's `hooks` value (the harnesses nest it differently). */
function commandStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) commandStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" && typeof item === "string") out.push(item);
      else commandStrings(item, out);
    }
  }
  return out;
}

/** The words of a command's program part: a quoted string is one word, anything else splits at spaces. */
function programWords(program: string): string[] {
  return Array.from(program.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? "");
}

function isAbsolutePath(word: string): boolean {
  return isAbsolute(word) || /^[A-Za-z]:[\\/]/.test(word);
}

/** What is wrong with one registered hook command: a path in it that is gone, or a bare `jubarteai` not on PATH. */
function hookProblems(command: string, which: (cmd: string) => string | null): string[] {
  const match = HOOK_COMMAND.exec(command);
  if (match === null) return [];
  const problems: string[] = [];
  const words = programWords(match[1] ?? "");
  for (const word of words) {
    if (isAbsolutePath(word) && !existsSync(word)) problems.push(`hooks point to a missing ${text(word)}; run jubarteai init to refresh them`);
  }
  const first = words[0];
  if (first !== undefined && !isAbsolutePath(first) && /^jubarteai(?:\.(?:cmd|exe))?$/i.test(basename(first)) && which(first) === null) {
    problems.push("hooks run jubarteai, which is not on your PATH; install it globally or run jubarteai init to refresh them");
  }
  return problems;
}

/** The hook commands in the harness's file as a check, or null when it has none of ours (the harness check says "missing"). */
function hookCommandCheck(adapter: HarnessAdapter, ctx: InitCtx): Check | null {
  const file = hooksFile(adapter, ctx);
  if (file === null) return null;
  const read = readJsonObject(file);
  if (read.status !== "ok") return null;
  const commands = commandStrings(read.doc["hooks"]).filter((command) => HOOK_COMMAND.test(command));
  if (commands.length === 0) return null;
  const problems = [...new Set(commands.flatMap((command) => hookProblems(command, ctx.which)))];
  return {
    id: `hook_commands:${adapter.id}`,
    level: problems.length === 0 ? "ok" : "warn",
    label: `Hook commands in ${adapter.label}`,
    detail: problems.length === 0 ? "found" : problems.join("; "),
    data: { count: commands.length, problems },
  };
}

// ---- the key in Codex's user-level MCP entry (init's D5 fallback) -------------------------------------------

/**
 * Whether the key in Codex's user-level jubarteai MCP entry is one of the saved logins for the entry's origin. Only
 * SHA-256 digests are compared; neither the key nor a digest is ever printed. Null when there is no such entry or the
 * file can't be read (the harness check already says so).
 */
function codexEntryCheck(home: string, env: NodeJS.ProcessEnv): Check | null {
  const entry = readCodexEntry(codexUserFile(home, env));
  if (entry === null) return null;
  const id = "codex_mcp_entry";
  const label = "Codex MCP entry";
  let seats: Record<string, StoredSeat> = {};
  try {
    seats = readCredentialsReport().credentials.seats;
  } catch {
    // Saved logins that can't be read are their own failed check; here nothing matches.
  }
  const match = entry.bearer === null || entry.url === null ? undefined : seatForBearer(seats, entry.url, entry.bearer);
  if (match === undefined) {
    return { id, level: "warn", label, detail: "holds a key that isn't a saved login; run jubarteai init to refresh it", data: { matched: false } };
  }
  const workspace = safeForDisplay(match.seat.company.slug, DETAIL_LIMIT);
  return { id, level: "ok", label, detail: `uses your saved login for ${workspace}`, data: { matched: true, workspace } };
}

/** Where this folder's binding comes from, and whether a worktree's own binding hides the main checkout's. */
function bindingCheck(cwd: string): Check | null {
  const id = "binding";
  const label = "Repo binding";
  try {
    const found = findBinding(cwd);
    if (found === null) return null;
    const slug = text(found.workspace.slug);
    if (found.inheritedFrom !== undefined) {
      return {
        id,
        level: "ok",
        label,
        detail: `workspace ${slug}, from the main checkout ${text(found.root)}`,
        data: { workspace: slug, inherited_from: found.inheritedFrom },
      };
    }
    const main = mainCheckoutBinding(cwd);
    if (main !== null && resolve(main.root) !== resolve(found.root)) {
      const differs = main.workspace.id !== found.workspace.id;
      return {
        id,
        level: differs ? "warn" : "ok",
        label,
        detail: `workspace ${slug}; this worktree has its own binding, and the main checkout's is ${text(main.workspace.slug)}${differs ? " (a different workspace; run jubarteai link here to share the main checkout's)" : ""}`,
        data: { workspace: slug, main_checkout_workspace: text(main.workspace.slug) },
      };
    }
    return { id, level: "ok", label, detail: `workspace ${slug}`, data: { workspace: slug } };
  } catch {
    return { id, level: "warn", label, detail: "the binding file can't be read; run: jubarteai link", data: { workspace: null } };
  }
}

type HarnessResult = { detected: HarnessAdapter[]; checks: Check[] };

async function harnessChecks(projectRoot: string | null): Promise<HarnessResult> {
  const env = defaultDetectEnv();
  const detected = await detectHarnesses(env);
  // The same context init plans with: hooks are compared against the absolute command init registers.
  const ctx: InitCtx = { ...env, projectRoot, cliCommand: CLI_NAME, hookCommand: resolveCliCommand() };
  const checks = await Promise.all(detected.map((adapter) => harnessCheck(adapter, ctx)));
  for (const adapter of detected) {
    const hooks = hookCommandCheck(adapter, ctx);
    if (hooks !== null) checks.push(hooks);
  }
  if (detected.some((adapter) => adapter.id === "codex")) {
    const entry = codexEntryCheck(ctx.home, ctx.env);
    if (entry !== null) checks.push(entry);
  }
  if (detected.length === 0) {
    checks.push({ id: "harnesses", level: "warn", label: "Harnesses", detail: "no supported editor or agent found on this machine", data: { detected: 0 } });
  }
  return { detected, checks };
}

const SKILL_KIND_NAMES: Readonly<Record<SkillChannel["kind"], string>> = {
  "plugin-user": "Claude Code plugin (user)",
  "plugin-project": "Claude Code plugin (this project)",
  "skills-project": "skill copy (this project)",
  "skills-global": "skill copy (global)",
  "hand-copy": "hand-made skill copy",
};

async function skillCheck(root: string | null, cwd: string): Promise<Check> {
  const label = "JubarteAI skill";
  const channels = await withDeadline<SkillChannel[] | null>(
    detectSkillChannels({ root, cwd }).catch(() => null),
    LOCAL_DEADLINE_MS,
    null,
  );
  if (channels === null) return { id: "skill", level: "warn", label, detail: "couldn't check in time", data: { copies: null } };
  const copies = channels.map((channel) => ({ kind: channel.kind, path: channel.path, version: channel.version }));
  if (channels.length === 0) {
    return { id: "skill", level: "warn", label, detail: "no copy found. Run: jubarteai init", data: { copies } };
  }
  const names = channels.map((channel) => `${SKILL_KIND_NAMES[channel.kind]}${channel.version === null ? "" : ` ${channel.version}`}`);
  return { id: "skill", level: "ok", label, detail: text(names.join(", ")), data: { copies } };
}

const SECTION_ADVICE: Readonly<Record<string, { level: Level; detail: string }>> = {
  current: { level: "ok", detail: "current" },
  missing: { level: "warn", detail: "missing. Run: jubarteai init" },
  "known-old": { level: "warn", detail: "an older version. Run: jubarteai update" },
  edited: { level: "warn", detail: "edited by hand; left as it is" },
  shadowed: { level: "warn", detail: "another file shadows AGENTS.md for some editors" },
};

function instructionsCheck(project: Project): Check {
  const label = "AGENTS.md section";
  if (project.root === null) {
    return { id: "instructions", level: "ok", label, detail: `skipped: ${project.note ?? "not a project folder"}`, data: { skipped: true } };
  }
  let inspected: ReturnType<typeof inspectInstructions>;
  try {
    inspected = inspectInstructions(project.root);
  } catch {
    return { id: "instructions", level: "fail", label, detail: "couldn't read the project's instruction files", data: { state: null } };
  }
  const unreadable = inspected.reports.some((line) => line.includes("couldn't read it"));
  const advice = SECTION_ADVICE[inspected.agentsMd] ?? { level: "warn" as const, detail: inspected.agentsMd };
  const level: Level = unreadable ? "fail" : advice.level;
  const notes = inspected.reports.map(text);
  const detail = [advice.detail, ...notes].join("; ");
  return {
    id: "instructions",
    level,
    label,
    detail: text(detail),
    data: { state: inspected.agentsMd, claude_md_import: inspected.claudeMdImport, reports: notes },
  };
}

// ---------------------------------------------------------------------------
// Status (reused, not copied)
// ---------------------------------------------------------------------------

/** What `status` prints, captured: its text, or (with `json`) its report parsed. status is offline and never prints a key. */
async function captureStatus(ctx: CommandContext, json: boolean): Promise<string> {
  let out = "";
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out += chunk.toString("utf8");
      done();
    },
  });
  await statusCommand.run({ ...ctx, stdout }, { flags: json ? { json: true } : {}, positionals: [] });
  return out;
}

// ---------------------------------------------------------------------------
// Rendering and the command
// ---------------------------------------------------------------------------

const MARKERS: Readonly<Record<Level, string>> = { ok: "ok  ", warn: "warn", fail: "fail" };

function renderChecks(checks: Check[]): string {
  return checks.map((check) => `${MARKERS[check.level]}  ${check.label}: ${check.detail}`).join("\n");
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("doctor takes no arguments.");
  const json = args.flags["json"] === true;

  const project = await findProject(ctx.cwd);
  const account = accountChecks();
  const version = versionCheck();
  const harness = withDeadline<HarnessResult | null>(harnessChecks(project.root).catch(() => null), LOCAL_DEADLINE_MS, null);
  const skill = skillCheck(project.root, ctx.cwd);
  const statusText = captureStatus(ctx, json);
  const binding = bindingCheck(ctx.cwd);

  const [accountResult, versionResult, harnessResult, skillResult, status] = await Promise.all([account, version, harness, skill, statusText]);
  const harnessFallback: Check = { id: "harnesses", level: "warn", label: "Harnesses", detail: "couldn't check in time", data: { detected: null } };
  const checks: Check[] = [
    nodeCheck(),
    versionResult,
    accountResult.credentials,
    ...accountResult.seats,
    ...(binding === null ? [] : [binding]),
    ...(harnessResult === null ? [harnessFallback] : harnessResult.checks),
    skillResult,
    instructionsCheck(project),
  ];
  const failed = checks.some((check) => check.level === "fail");

  if (json) {
    writeJson(ctx.stdout, { ok: !failed, checks, status: JSON.parse(status) as unknown }, { pretty: ctx.globals.pretty });
  } else {
    ctx.stdout.write(`${status}\nChecks:\n${renderChecks(checks)}\n`);
  }
  return failed ? ExitCode.SERVER_ERROR : ExitCode.OK;
}

export const doctorCommand: CommandDef = {
  name: "doctor",
  summary: "Check your logins, Node, the CLI version, harness setup, the skill and AGENTS.md",
  group: "setup",
  usage: "doctor [--json]",
  flags: [{ name: "json", type: "boolean", description: "Print the report as one JSON object" }],
  run,
};
