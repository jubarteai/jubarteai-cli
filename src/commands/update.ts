// `jubarteai update` (spec section 5.5): keeps an existing JubarteAI setup current. It is update.sh's behaviour
// (docs/plans/update-sh-grill.md D1–D32) in TypeScript, plus two things update.sh could not do:
//
//   1. Self-update first (skip with --no-self-update): when the npm registry's `latest` is newer than this CLI,
//      offer `npm install -g jubarteai@<v>` (Yes / No / Show the exact command) and hand over to the new binary with
//      `jubarteai update --no-self-update <same flags>`. An offline lookup is one advisory line.
//   2. MCP: where update.sh only reported install.sh's leftover MCP entries, update offers their removal (D3), as
//      sensitive steps (`--keep-mcp` keeps them). Codex keeps its entry unless its network opt-in is already in
//      place (D5); a machine with no jubarteai login keeps every entry, since its agents still depend on them.
//
//   3. Hooks: the hook entries `init` wrote that are already ours get the running install's command (the absolute Node and
//      bin paths, which a Node upgrade invalidates) in place, as sensitive steps with a preview. Update adds no entry; an
//      adapter with only some events registered, or one that prints instructions, gets the `init` hint (hook-refresh.ts).
//
// The rest is update.sh's: the skill through each channel it was installed with (plugin, npx copies, hand copies;
// D8–D11, D18–D22), the AGENTS.md / CLAUDE.md section refresh of a known-old section (D13, D24, D25), global scope
// only when run from ~ or / (D26), nothing installed → point at init (D30), exit 0 / 1 / 2 (D29).
//
// No key, ever (D2, D3, D21): this command never calls readCredentials, resolveSeat, takeEnvToken or whoami, and
// never `claude mcp get/list`. It only checks whether the credentials file exists (to decide whether removing the
// MCP entries would leave the agents with nothing), never what it holds. Children get childEnv() (run.ts).
import { existsSync } from "node:fs";

import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { CLI_NAME, cliVersion } from "../constants.js";
import { UsageError } from "../errors.js";
import { CODEX_CODES } from "../harness/codex.js";
import { defaultDetectEnv, detectHarnesses } from "../harness/detect.js";
import type { CleanupScope, HarnessAdapter, InitCtx, ManualInstructions } from "../harness/types.js";
import { inspectInstructions, notProjectReason, planInstructionSteps } from "../install/agents-md.js";
import { cliCommandInfo, type CliCommandInfo } from "../install/cli-command.js";
import { HOOK_REFRESH_COPY, planHookRefresh, type HookRefreshPlan } from "../install/hook-refresh.js";
import { runCommand, which } from "../install/run.js";
import {
  fetchLatestVersion,
  globalInstallOf,
  installCliVersion,
  isNewer,
  reexecCli,
  type CliInstall,
  type CliInstallOutcome,
  type ReexecOutcome,
} from "../install/self-update.js";
import { planSkillSteps, type LatestSkill } from "../install/skill.js";
import {
  UPDATE_COPY,
  byHandLines,
  checkClosingLines,
  cliInstallFailedLines,
  cliVersionRow,
  closingNotes,
  countResults,
  infoRow,
  nothingInstalledLines,
  todoRow,
  updateExitCode,
  type ReportRow,
} from "../install/update-report.js";
import { credentialsPath, homeDir } from "../paths.js";
import { agentSessionVar } from "../agent-session.js";
import { isInteractive } from "../prompt.js";
import { DECLINED, applyPlan, type ApplyOptions, type PlanStep, type StepResult } from "../safe-edit/plan.js";
import { choice } from "../ui/choice.js";
import { createUi, type Ui } from "../ui/index.js";
import type { Timeline } from "../ui/timeline.js";

const GIT_TIMEOUT_MS = 10_000;
const CLAUDE_VERSION_TIMEOUT_MS = 10_000;
const VERSION_RE = /([0-9]+\.[0-9]+\.[0-9]+)/;

/**
 * The skill module's steps are of two kinds that share one type: changes (re-add a copy, update the plugin) and
 * findings that change nothing (already current, a duplicate load, other projects' installs, tips), marked
 * `kind: "info"`. A finding's apply() only returns its fixed result, so update runs it to print what it found, in --check too.
 */
function isFinding(step: PlanStep): boolean {
  return step.kind === "info";
}

/** Codex's network opt-in step (codex.ts); non-sensitive means it is already in place. */
const CODEX_OPT_IN_ID = "codex:network-optin";
/** Instructions about hooks `init` writes; update only refreshes the program of hooks already trusted, hook-refresh.ts says when it matters. */
const NOT_FOR_UPDATE: readonly string[] = [CODEX_CODES.trustHooks];

const CODEX_KEPT_MANUAL: Omit<ManualInstructions, "harness"> = {
  kind: "manual",
  title: "Codex keeps its jubarteai MCP entry",
  lines: [
    "Codex's sandboxed shell needs network access to run jubarteai, so its MCP entry stays until Codex's network opt-in is in place.",
    "Run jubarteai init in this project to add it; jubarteai update then offers the cleanup.",
  ],
  reason: "network opt-in not in place (D5)",
  code: CODEX_CODES.keptProject,
};

/** What `update` reads from the machine; production uses the real ones, tests inject. */
export type UpdateDeps = {
  /** The registry's latest CLI version, or null when it couldn't be looked up. */
  fetchLatest(): Promise<string | null>;
  currentVersion(): string;
  /** Where the running CLI is installed in npm's global layout; null outside it (npx cache, a checkout). */
  locateInstall(): CliInstall | null;
  /** `npm install -g jubarteai@<version>` into `prefix` (the running install's). */
  installCli(version: string, prefix: string): Promise<CliInstallOutcome>;
  /** Run `node <entry> <args>` (the bin script npm just replaced; it inherits the terminal) and give back its exit code. */
  reexec(entry: string, args: string[]): Promise<ReexecOutcome>;
  /** What a hook's command line starts with for the running install (cliCommandInfo; tests inject). */
  cliCommand(): CliCommandInfo;
  isTty(): boolean;
  /** The self-update question (Yes / No / Show the exact command); tests inject. */
  choice: typeof choice;
  /** Test seam: answers the plan's one question without a terminal. */
  approve?: ApplyOptions["approve"];
  detect(): Promise<HarnessAdapter[]>;
  /** The newest skill, when already known (tests); undefined: looked up on GitHub by the skill module. */
  latestSkill?: LatestSkill | null;
  /** The Node the skills CLI will run on (default: this process). */
  nodeVersion?: string;
};

const defaultDeps: UpdateDeps = {
  fetchLatest: () => fetchLatestVersion(),
  currentVersion: cliVersion,
  locateInstall: () => globalInstallOf(process.argv[1]),
  installCli: installCliVersion,
  reexec: reexecCli,
  cliCommand: () => cliCommandInfo(),
  isTty: isInteractive,
  choice,
  detect: () => detectHarnesses(),
};

type Options = {
  check: boolean;
  selfUpdate: boolean;
  keepMcp: boolean;
  yes: boolean;
  /** Output choices the re-run must keep: the new CLI starts from a fresh command line, not from ours. */
  plain: boolean;
  verbose: boolean;
  showChanges: boolean;
};

/** The rows `update` finds, as timeline lines; counts the warnings for the closing tally. */
class Printer {
  warnings = 0;
  okRows = 0;
  constructor(
    readonly ui: Ui,
    readonly timeline: Timeline,
  ) {}
  /** Fixed sentences between rows. */
  line(text: string): void {
    this.timeline.note([text]);
  }
  row(r: ReportRow): void {
    if (r.level === "warn") this.warnings += 1;
    if (r.level === "ok") this.okRows += 1;
    // What this machine and project are shown as header rows; findings and changes are rows.
    if ((r.level === "ok" || r.level === "info") && (r.name === "CLI" || r.name === "Project" || r.name === "Claude Code" || r.name === "Status")) {
      this.timeline.header(r.name, r.text);
      return;
    }
    this.timeline.row(r.level, r.name, r.text);
  }
}

/** The arguments the newly installed CLI is run with: never --check (a check never installs), never a key. */
export function reexecArgs(opts: Pick<Options, "yes" | "keepMcp"> & Partial<Pick<Options, "plain" | "verbose" | "showChanges">>): string[] {
  return [
    "update",
    "--no-self-update",
    ...(opts.yes ? ["--yes"] : []),
    ...(opts.keepMcp ? ["--keep-mcp"] : []),
    ...(opts.plain === true ? ["--plain"] : []),
    ...(opts.verbose === true ? ["--verbose"] : []),
    ...(opts.showChanges === true ? ["--show-changes"] : []),
  ];
}

type SelfUpdate = { done: false; pending: number; failed: number } | { done: true; code: number };

/** Step 1: the CLI itself. `done` means the new binary ran the rest (or couldn't be started) and its code is final. */
async function selfUpdate(p: Printer, opts: Options, deps: UpdateDeps, tty: boolean): Promise<SelfUpdate> {
  const current = deps.currentVersion();
  if (!opts.selfUpdate) {
    p.row(cliVersionRow({ kind: "skipped", current }));
    return { done: false, pending: 0, failed: 0 };
  }
  const latest = await deps.fetchLatest();
  if (latest === null) {
    p.row(cliVersionRow({ kind: "unknown", current }));
    return { done: false, pending: 0, failed: 0 };
  }
  if (!isNewer(latest, current)) {
    p.row(cliVersionRow({ kind: "current", current, latest }));
    return { done: false, pending: 0, failed: 0 };
  }
  // Only a copy in npm's global layout is updated by `npm install -g`; any other is reported, not touched.
  const install = deps.locateInstall();
  if (install === null) {
    p.row({ level: "warn", name: "CLI", text: `a newer CLI is available: ${current} -> ${latest}; ${UPDATE_COPY.cliNotGlobal}` });
    return { done: false, pending: 0, failed: 0 };
  }
  p.row(cliVersionRow({ kind: "newer", current, latest }));
  if (opts.check) return { done: false, pending: 1, failed: 0 };

  // D28 (update-sh grill): with no terminal to ask and no --yes, update proceeds, the self-update included. An agent's shell
  // is asked nothing either: the install changes no harness or security file, and a prompt there could be answered by the agent.
  const command = `npm install -g jubarteai@${latest} (into ${install.prefix})`;
  const go =
    tty && !opts.yes && agentSessionVar() === null
      ? (await deps.choice(p.ui, { question: `Install jubarteai@${latest}?`, options: ["yes", "no", "show"], defaultIndex: 0, details: () => [`This will run: ${command}`] })) === "yes"
      : true;
  if (!go) {
    p.row({ level: "warn", name: "CLI", text: `${UPDATE_COPY.cliInstallDeclined} (${current}); update it later with: npm install -g jubarteai@${latest}` });
    return { done: false, pending: 0, failed: 0 };
  }
  const installed = await p.timeline.run(`Installing jubarteai@${latest}`, () => deps.installCli(latest, install.prefix));
  if (!installed.ok) {
    p.timeline.row("fail", "CLI", `failed: npm install -g jubarteai@${latest}`);
    if (installed.log !== undefined) p.timeline.note(installed.log.map((line) => `  ${line}`));
    for (const line of cliInstallFailedLines(latest, { eacces: installed.eacces, timedOut: installed.timedOut, platform: process.platform })) p.line(line);
    return { done: false, pending: 0, failed: 1 };
  }
  p.timeline.row("ok", "CLI", `installed ${latest}; continuing with it`);
  // The file npm just replaced in place, never a PATH lookup (a stale copy elsewhere on PATH would run instead).
  const handed = await deps.reexec(install.entry, reexecArgs(opts));
  if (handed.started) return { done: true, code: handed.code };
  p.row({ level: "warn", name: "CLI", text: handed.reason === "not-found" ? UPDATE_COPY.cliReexecMissing : UPDATE_COPY.cliReexecFailed });
  return { done: true, code: 1 };
}

/** The folder's git top level, or null when it is not in a repository. */
async function gitTopLevel(cwd: string): Promise<string | null> {
  const res = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const line = res.code === 0 ? res.stdout.trim() : "";
  return line === "" ? null : line;
}

/** The installed Claude Code's version (`claude --version`, the only claude call besides the plugin ones; D21). */
async function claudeCodeVersion(): Promise<string | null> {
  if (which("claude") === null) return null;
  const res = await runCommand("claude", ["--version"], { timeoutMs: CLAUDE_VERSION_TIMEOUT_MS });
  if (res.code !== 0) return null;
  return VERSION_RE.exec(res.stdout.split("\n")[0] ?? "")?.[1] ?? null;
}

function isPlanStep(item: PlanStep | ManualInstructions): item is PlanStep {
  return !("kind" in item && item.kind === "manual");
}

type McpPlan = {
  steps: PlanStep[];
  /** Report-only cleanup findings (a file that must be edited by hand) and why Codex keeps its entry. */
  cleanupManuals: ManualInstructions[];
  /** The adapters' other instructions (extras). */
  otherManuals: ManualInstructions[];
  /** Any jubarteai MCP entry was found (installed, D30), whether or not it is offered for removal. */
  found: boolean;
};

/**
 * The MCP section: each detected adapter's extras() first (D5: whether Codex's opt-in is in place), then its
 * cleanup steps, de-duplicated by id. Codex's entry is kept unless the opt-in is in place; extras' own steps are
 * never applied by update (init owns the permission and network writes).
 */
async function planMcp(adapters: HarnessAdapter[], ictx: InitCtx, scope: CleanupScope): Promise<McpPlan> {
  const steps: PlanStep[] = [];
  const cleanupManuals: ManualInstructions[] = [];
  const otherManuals: ManualInstructions[] = [];
  const seen = new Set<string>();
  let found = false;
  for (const adapter of adapters) {
    const extras = adapter.extras === undefined ? [] : await adapter.extras(ictx);
    const extraManuals = extras.filter((i): i is ManualInstructions => !isPlanStep(i)).filter((m) => m.code === undefined || !NOT_FOR_UPDATE.includes(m.code));
    const cleanup = await adapter.mcpCleanup(scope);
    if (cleanup.length > 0) found = true;

    if (adapter.id === "codex") {
      const optIn = extras.filter(isPlanStep).find((s) => s.id === CODEX_OPT_IN_ID);
      const inEffect = optIn !== undefined && !optIn.sensitive;
      if (!inEffect) {
        if (cleanup.length > 0) {
          // The opt-in's own instructions say why the entry stays (and how to fix it); else the generic explanation.
          const why = extraManuals.filter((m) => m.code === CODEX_CODES.networkManual);
          cleanupManuals.push(...(why.length > 0 ? why : [{ ...CODEX_KEPT_MANUAL, harness: adapter.id }]));
          otherManuals.push(...extraManuals.filter((m) => !why.includes(m)));
        } else {
          otherManuals.push(...extraManuals);
        }
        continue;
      }
    }
    otherManuals.push(...extraManuals);
    for (const item of cleanup) {
      if (!isPlanStep(item)) {
        cleanupManuals.push(item);
        continue;
      }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      steps.push(item);
    }
  }
  return { steps, cleanupManuals, otherManuals, found };
}

async function runUpdate(ctx: CommandContext, args: ParsedArgs, deps: UpdateDeps): Promise<number> {
  if (args.positionals.length > 0) {
    // Never echo the argument: it could be a key pasted by mistake.
    throw new UsageError("update takes no arguments, and never a key. To sign in, run: jubarteai login");
  }
  const opts: Options = {
    check: args.flags["check"] === true,
    selfUpdate: args.flags["self-update"] !== false,
    keepMcp: args.flags["keep-mcp"] === true,
    yes: ctx.globals.yes,
    plain: ctx.globals.plain === true,
    verbose: ctx.globals.verbose === true,
    showChanges: args.flags["show-changes"] === true,
  };
  const tty = deps.isTty();
  const ui = createUi(ctx.stderr, { ...(opts.plain ? { plain: true } : {}), ...(opts.verbose ? { verbose: true } : {}) });
  const timeline = ui.timeline();
  const p = new Printer(ui, timeline);
  const started = Date.now();
  ui.banner("updater");
  timeline.open(UPDATE_COPY.title);

  // --- 1. the CLI itself ---------------------------------------------------------------------------------------
  const self = await selfUpdate(p, opts, deps, tty);
  if (self.done) return self.code;
  let pending = self.pending;

  // --- 2. where we are (D26) -----------------------------------------------------------------------------------
  const top = await gitTopLevel(ctx.cwd);
  let root: string | null = top ?? ctx.cwd;
  const notProject = notProjectReason(root);
  if (notProject !== null) {
    p.row({ level: "info", name: "Project", text: `${notProject}; global installs only` });
    root = null;
  } else if (top === null) {
    p.row({ level: "warn", name: "Project", text: UPDATE_COPY.notGitRepo });
  }

  // --- 3. discovery (reads only) -------------------------------------------------------------------------------
  const adapters = await deps.detect();
  const ccVersion = await claudeCodeVersion();
  if (ccVersion !== null) p.row({ level: "ok", name: "Claude Code", text: ccVersion });
  const skillSteps = await planSkillSteps({
    root,
    cwd: ctx.cwd,
    mode: "update",
    agents: [],
    ...(deps.latestSkill !== undefined ? { latest: deps.latestSkill } : {}),
    ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
  });
  const home = homeDir();
  const ictx: InitCtx = { ...defaultDetectEnv(), projectRoot: root, cliCommand: CLI_NAME };
  const scope: CleanupScope = { home, projectRoot: root, platform: process.platform, startDir: ctx.cwd, env: process.env };
  const mcp = await planMcp(adapters, ictx, scope);
  // A throwaway npx copy would write its own cache path (or the bare name) over a good command: leave the hooks alone.
  const cli = deps.cliCommand();
  const hookRefresh: HookRefreshPlan = cli.npx
    ? { steps: [], manuals: [], incomplete: [] }
    : await planHookRefresh(adapters, { ...ictx, hookCommand: cli.command });

  const hooksFound = hookRefresh.steps.length > 0 || hookRefresh.manuals.length > 0 || hookRefresh.incomplete.length > 0;
  if (skillSteps.length === 0 && !mcp.found && !hooksFound) {
    timeline.note(nothingInstalledLines());
    timeline.close({ ok: p.okRows, skipped: 0, failed: 0, warnings: p.warnings }, Date.now() - started);
    return updateExitCode({ check: opts.check, pending, failed: 0 });
  }

  // --- 4. the plan ----------------------------------------------------------------------------------------------
  const skillChanges = skillSteps.filter((s) => !isFinding(s));
  const skillFindings = skillSteps.filter(isFinding);
  const has = (id: string): boolean => adapters.some((a) => a.id === id);
  const instructionSteps = root === null ? [] : planInstructionSteps(root, { mode: "update", claudeCodeVersion: ccVersion });
  const instructionReports =
    root === null ? [] : inspectInstructions(root, { claudeCodeVersion: ccVersion, harnesses: { zed: has("zed"), codex: has("codex") } }).reports;

  const kept: StepResult[] = [];
  let mcpSteps = mcp.steps;
  let cleanupManuals = mcp.cleanupManuals;
  if ((mcpSteps.length > 0 || cleanupManuals.length > 0) && !existsSync(credentialsPath())) {
    p.row({ level: "warn", name: "MCP", text: UPDATE_COPY.mcpNotSignedIn });
    mcpSteps = [];
    cleanupManuals = [];
  } else if (opts.keepMcp) {
    for (const s of mcpSteps) kept.push({ id: s.id, label: s.label, status: "skipped", detail: UPDATE_COPY.mcpKept });
    mcpSteps = [];
  }

  for (const finding of skillFindings) p.row(infoRow(await finding.apply()));
  for (const report of instructionReports) p.row({ level: "warn", name: "Instructions", text: report });
  for (const adapter of hookRefresh.incomplete) p.row({ level: "info", name: "Hooks", text: `${adapter.label}: ${HOOK_REFRESH_COPY.incomplete}` });

  const changes = [...skillChanges, ...instructionSteps, ...hookRefresh.steps, ...mcpSteps];
  // Two adapters can report the same file or the same instruction (VS Code and Copilot CLI share configs): print it once.
  const manuals = [...cleanupManuals, ...mcp.otherManuals, ...hookRefresh.manuals].filter(
    (m, i, all) => all.findIndex((o) => o.title === m.title && o.lines.join("\n") === m.lines.join("\n")) === i,
  );

  // --- 5. --check: report only ---------------------------------------------------------------------------------
  if (opts.check) {
    for (const s of changes) p.row(todoRow(s.label));
    for (const r of kept) p.row({ level: "info", name: r.label, text: UPDATE_COPY.mcpKept });
    timeline.note(byHandLines(manuals));
    pending += changes.length;
    timeline.note(checkClosingLines(pending, p.warnings));
    timeline.close({ ok: p.okRows, skipped: 0, failed: 0, warnings: p.warnings }, Date.now() - started);
    return updateExitCode({ check: true, pending, failed: 0 });
  }

  // --- 6. apply -------------------------------------------------------------------------------------------------
  let results: StepResult[] = [];
  if (changes.length === 0) {
    p.row({ level: "ok", name: "Status", text: UPDATE_COPY.upToDate });
  } else {
    results = await applyPlan(changes, {
      tty,
      yes: opts.yes,
      ui,
      timeline,
      approval: "confirm",
      title: UPDATE_COPY.applyQuestion,
      showChanges: opts.showChanges,
      ...(deps.approve === undefined ? {} : { approve: deps.approve }),
    });
    if (results.length > 0 && results.every((r) => r.status === "skipped" && r.detail === DECLINED)) return updateExitCode({ check: false, pending: 0, failed: self.failed });
  }
  const keptResults = kept;
  for (const r of keptResults) timeline.result(r, "");
  results = [...results, ...keptResults];
  timeline.note(byHandLines(manuals));

  const counts = countResults(results, p.warnings, self.failed);
  timeline.note(closingNotes(counts, { changed: results.some((r) => r.status === "configured") }));
  timeline.close(counts, Date.now() - started);
  return updateExitCode({ check: false, pending: 0, failed: counts.failed });
}

/** The update command with its machine-facing parts injected (tests); `updateCommand` is the production one. */
export function createUpdateCommand(overrides: Partial<UpdateDeps> = {}): CommandDef {
  const deps: UpdateDeps = { ...defaultDeps, ...overrides };
  return {
    name: "update",
    summary: "Update the CLI, the skill, the AGENTS.md section and the hook commands, and remove leftover MCP entries (never reads a key)",
    group: "setup",
    usage: "update [--check] [--yes] [--no-self-update] [--keep-mcp] [--show-changes]",
    flags: [
      { name: "check", type: "boolean", description: "Report what would change and change nothing (exit 2 when something would)" },
      {
        name: "self-update",
        type: "boolean",
        description: "Check npm for a newer CLI first (default; --no-self-update skips it)",
        negation: "Skip the npm check for a newer CLI",
      },
      { name: "keep-mcp", type: "boolean", description: "Keep the jubarteai MCP entries in your editors' configs" },
      { name: "show-changes", type: "boolean", description: "Print the exact entries to be written before asking" },
    ],
    run: (ctx, args) => runUpdate(ctx, args, deps),
  };
}

export const updateCommand: CommandDef = createUpdateCommand();
