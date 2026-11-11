import { join, resolve as resolvePath } from "node:path";

import { refuseInAgentSession } from "../agent-session.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { readCredentials } from "../auth/credentials.js";
import type { Credentials, StoredSeat } from "../auth/credentials.js";
import { loginFlow, loginWithToken } from "../auth/login-flow.js";
import { isResolveError, resolveSeat } from "../auth/resolve-seat.js";
import { API_KEY_RE } from "../auth/token-exchange.js";
import { findBinding, writeBinding } from "../binding/binding.js";
import type { Binding } from "../binding/binding.js";
import { CLI_NAME, MCP_PATH } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { CODEX_CODES } from "../harness/codex.js";
import { CODEX_MCP_TABLE, bearerIs, codexUpdateStep, codexUserFile, readCodexEntry, seatForBearer, workspaceLabel } from "../harness/codex-entry.js";
import { defaultDetectEnv, detectHarnesses } from "../harness/detect.js";
import { codexHome, findMcpEntries, isUnderHome, shownPath } from "../harness/mcp-cleanup.js";
import { ADAPTERS } from "../harness/registry.js";
import type { CleanupScope, HarnessAdapter, InitCtx, ManualInstructions } from "../harness/types.js";
import { planInstructionSteps, notProjectReason } from "../install/agents-md.js";
import {
  INIT_COPY,
  accountChoiceLabel,
  bindingStepLabel,
  rebindStepLabel,
  codexForeignLines,
  codexOtherWorkspaceLines,
  codexUnreadableLines,
  flagSkipDetail,
  noLoginForWorkspace,
  repoUsesWorkspace,
  useAccountQuestion,
  usingAccount,
} from "../install/init-copy.js";
import { cliCommandInfo } from "../install/cli-command.js";
import { runCommandSync } from "../install/run.js";
import { planSkillSteps } from "../install/skill.js";
import { safeForDisplay } from "../output.js";
import { envOrigin, takeEnvToken } from "../process-env.js";
import { choose, confirm, isInteractive } from "../prompt.js";
import { TomlConflictError, editTomlFile, getTomlTable, setTomlKey } from "../safe-edit/toml-edit.js";
import { applyPlan, summarize } from "../safe-edit/plan.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";

// `jubarteai init` (spec section 6.1): sign in (or reuse a saved login), bind this repo to the workspace, install the
// skill, write the AGENTS.md section, then the sensitive writes (permission, hooks, Codex, MCP cleanup) each behind
// its own prompt. All of it is one plan handed to applyPlan, the only place harness and security files change (I6).

const GIT_TIMEOUT_MS = 10_000;
const DISPLAY_MAX = 200;
const MANUAL_LINE_MAX = 400;
const BINDING_STEP_ID = "binding";
const CODEX_ID = "codex";
const CODEX_OPT_IN_STEP_ID = "codex:network-optin";
const CODEX_REGISTER_STEP_ID = "codex:mcp-register";
const CODEX_CONFIG_MODE = 0o600;

type LoginDeps = NonNullable<Parameters<typeof loginFlow>[2]>;

/** Test seams: the browser opener and timing of the sign-in flow. */
export type InitDeps = { login?: LoginDeps };

export type SeatEntry = { seatId: string; seat: StoredSeat };

// ---- where we run ---------------------------------------------------------------------------------------------

/**
 * The project folder for `cwd`: the git top level, else `cwd` itself; null (with the reason) for `~` and `/`, which
 * never get a binding, a project skill or an AGENTS.md (update-sh D26).
 */
export function projectRootOf(cwd: string): { root: string | null; reason: string | null } {
  const top = runCommandSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const line = top.code === 0 ? (top.stdout.split(/\r?\n/)[0] ?? "").trim() : "";
  const candidate = line === "" ? resolvePath(cwd) : resolvePath(line);
  const reason = notProjectReason(candidate);
  return reason === null ? { root: candidate, reason: null } : { root: null, reason };
}

/** The binding written in `root` itself (not one found above it); null when there is none or it can't be read. */
export function bindingAt(root: string): Binding | null {
  try {
    const found = findBinding(root);
    return found !== null && resolvePath(found.root) === resolvePath(root) ? found : null;
  } catch {
    return null;
  }
}

// ---- accounts -------------------------------------------------------------------------------------------------

function workspaceName(seat: StoredSeat): string {
  return safeForDisplay(seat.company.name !== "" ? seat.company.name : seat.company.slug, DISPLAY_MAX);
}

/** "<email> — <workspace>" for a stored seat, safe to print. */
export function seatLabel(seat: StoredSeat): string {
  return accountChoiceLabel(safeForDisplay(seat.user.email, DISPLAY_MAX), workspaceName(seat));
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Stored seats, the default first, then the most recently saved. */
export function seatEntries(credentials: Credentials): SeatEntry[] {
  return Object.entries(credentials.seats)
    .map(([seatId, seat]) => ({ seatId, seat }))
    .sort((a, b) => {
      if (a.seatId === credentials.default_seat) return -1;
      if (b.seatId === credentials.default_seat) return 1;
      return Date.parse(b.seat.saved_at) - Date.parse(a.seat.saved_at);
    });
}

/**
 * The stored seat for `--workspace <slug>`: null when none is saved for that slug (the caller signs in), the seat
 * resolveSeat picks when there is one or two users to tell apart, or an exit-5 error when it can't tell.
 */
export function seatForWorkspace(slug: string, cwd: string): SeatEntry | null {
  const wanted = slug.trim();
  const credentials = readCredentials();
  if (!Object.values(credentials.seats).some((seat) => seat.company.slug === wanted)) return null;
  const resolved = resolveSeat({ workspace: wanted, cwd });
  if (isResolveError(resolved)) throw new CliError(resolved.error, ExitCode.NO_SEAT, "no_seat");
  if (resolved.seatId === null || resolved.seat === null) throw new CliError(noLoginForWorkspace(safeForDisplay(wanted)), ExitCode.NO_SEAT, "no_seat");
  return { seatId: resolved.seatId, seat: resolved.seat };
}

/** The seat a binding names: same workspace, and the same address when the binding records one. */
export function seatForBinding(entries: SeatEntry[], binding: Binding, credentials: Credentials): SeatEntry | null {
  const inWorkspace = entries.filter((entry) => entry.seat.company.id === binding.workspace.id);
  if (binding.email !== null) {
    const email = binding.email;
    return inWorkspace.find((entry) => sameEmail(entry.seat.user.email, email)) ?? null;
  }
  const defaultSeat = credentials.default_seat === null ? undefined : credentials.seats[credentials.default_seat];
  return inWorkspace.find((entry) => defaultSeat !== undefined && entry.seat.user.id === defaultSeat.user.id) ?? inWorkspace[0] ?? null;
}

type Proposal = { kind: "seat"; entry: SeatEntry } | { kind: "bound-elsewhere"; slug: string } | { kind: "none" };

/** The login init offers first: the one the repo is bound to, else the default. A repo bound to a workspace nobody here has logged into gets a sign-in to it. */
function proposalFor(credentials: Credentials, root: string | null): Proposal {
  const entries = seatEntries(credentials);
  const binding = root === null ? null : bindingAt(root);
  if (binding !== null) {
    const bound = seatForBinding(entries, binding, credentials);
    return bound === null ? { kind: "bound-elsewhere", slug: binding.workspace.slug } : { kind: "seat", entry: bound };
  }
  const first = entries[0];
  return first === undefined ? { kind: "none" } : { kind: "seat", entry: first };
}

type AccountOptions = { workspace: string | undefined; noBrowser: boolean; paste: boolean };

/** Browser (or paste) login at the environment's origin, with `workspace` preselected on the authorize page. */
async function signIn(ctx: CommandContext, workspace: string | undefined, opts: AccountOptions, deps: InitDeps): Promise<StoredSeat> {
  const result = await loginFlow(
    ctx,
    { origin: envOrigin(), ...(workspace === undefined ? {} : { workspace }), noBrowser: opts.noBrowser, paste: opts.paste },
    deps.login,
  );
  return result.seat;
}

/** Step 2: the account this run configures, by the environment key, a saved login, or a new sign-in. */
async function chooseAccount(ctx: CommandContext, root: string | null, opts: AccountOptions, tty: boolean, deps: InitDeps): Promise<StoredSeat> {
  const envToken = takeEnvToken();
  if (envToken !== null) {
    // Saving a key from the environment switches the account every hook and command uses: never on an agent's word (R-M1).
    refuseInAgentSession("init with JUBARTEAI_TOKEN");
    if (opts.workspace !== undefined) throw new UsageError(INIT_COPY.workspaceFlagWithKey);
    if (opts.paste || opts.noBrowser) throw new UsageError(INIT_COPY.loginFlagsWithKey);
    return (await loginWithToken(ctx, { origin: envOrigin(), token: envToken })).seat;
  }
  if (opts.paste && !tty) throw new UsageError(INIT_COPY.pasteNeedsTerminal);

  if (opts.workspace !== undefined) {
    const picked = seatForWorkspace(opts.workspace, ctx.cwd);
    return picked !== null ? useStored(ctx, picked.seat) : signIn(ctx, opts.workspace, opts, deps);
  }

  const credentials = readCredentials();
  const proposal = proposalFor(credentials, root);
  if (proposal.kind === "none") return signIn(ctx, undefined, opts, deps);
  if (proposal.kind === "bound-elsewhere") {
    ctx.stderr.write(`${repoUsesWorkspace(safeForDisplay(proposal.slug, DISPLAY_MAX))}\n`);
    return signIn(ctx, proposal.slug, opts, deps);
  }

  const { seat } = proposal.entry;
  if (!tty || ctx.globals.yes) return useStored(ctx, seat);
  if (await confirm(useAccountQuestion(safeForDisplay(seat.user.email, DISPLAY_MAX), workspaceName(seat)), { defaultYes: true })) return useStored(ctx, seat);

  const entries = seatEntries(credentials);
  const choices: Array<{ label: string; value: SeatEntry | null }> = [
    ...entries.map((entry) => ({ label: seatLabel(entry.seat), value: entry })),
    { label: INIT_COPY.signInOther, value: null },
  ];
  const chosen = await choose<SeatEntry | null>(INIT_COPY.chooseAccount, choices, { defaultIndex: 0 });
  return chosen === null ? signIn(ctx, undefined, opts, deps) : useStored(ctx, chosen.seat);
}

function useStored(ctx: CommandContext, seat: StoredSeat): StoredSeat {
  ctx.stderr.write(`${usingAccount(safeForDisplay(seat.user.email, DISPLAY_MAX), workspaceName(seat))}\n`);
  return seat;
}

// ---- the plan -------------------------------------------------------------------------------------------------

type PlanEntry = { kind: "step"; step: PlanStep } | { kind: "result"; result: StepResult };

function isManual(value: PlanStep | ManualInstructions): value is ManualInstructions {
  return "kind" in value && value.kind === "manual";
}

type Gates = { keepMcp: boolean; noHooks: boolean; noPermissions: boolean };

class PlanBuilder {
  readonly entries: PlanEntry[] = [];
  readonly manuals: ManualInstructions[] = [];
  private readonly seen = new Set<string>();

  /** A step, once per id (the VS Code and Copilot CLI adapters both return `copilot:hooks`). */
  step(step: PlanStep, off?: string): void {
    if (this.seen.has(step.id)) return;
    this.seen.add(step.id);
    if (off !== undefined) {
      this.entries.push({ kind: "result", result: { id: step.id, label: step.label, status: "skipped", detail: flagSkipDetail(off) } });
      return;
    }
    this.entries.push({ kind: "step", step });
  }

  manual(item: ManualInstructions): void {
    const key = `${item.harness}\u0000${item.title}\u0000${item.lines.join("\n")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.manuals.push(item);
  }

  failed(id: string, label: string): void {
    this.entries.push({ kind: "result", result: { id, label, status: "failed", detail: INIT_COPY.inspectFailed } });
  }

  /** An adapter call that may throw (an unreadable config): its failure becomes one failed row, the rest of the plan stands. */
  async guarded<T>(id: string, label: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch {
      this.failed(id, label);
      return null;
    }
  }
}

function bindingStep(
  root: string,
  seat: StoredSeat,
  form: { share: boolean | undefined; ask: boolean },
  notes: string[],
): PlanStep {
  const slug = safeForDisplay(seat.company.slug, DISPLAY_MAX);
  const existing = bindingAt(root);
  // Moving a bound repo to another workspace decides where every hook and command from it writes, the same change
  // `link` refuses from an agent's shell: it asks first, and an agent's --yes doesn't apply it (I6, review R-S9).
  // A first binding, or re-binding to the same workspace, stays a plain step.
  const moves = existing !== null && existing.workspace.id !== seat.company.id;
  const label = moves ? rebindStepLabel(safeForDisplay(existing.workspace.slug, DISPLAY_MAX), slug) : bindingStepLabel(slug);
  return {
    id: BINDING_STEP_ID,
    label,
    files: [join(root, ".jubarteai"), join(root, ".gitignore")],
    sensitive: moves,
    ...(moves ? { preview: `${join(root, ".jubarteai", "config.json")}
  workspace: ${safeForDisplay(existing.workspace.slug, DISPLAY_MAX)} → ${slug}`, flag: "--yes" } : {}),
    async apply(): Promise<StepResult> {
      let shared: boolean;
      if (form.share !== undefined) shared = form.share;
      else if (existing !== null) shared = existing.shared;
      else if (form.ask) shared = await confirm(INIT_COPY.shareBindingQuestion, { defaultYes: false });
      else shared = false;
      try {
        const written = writeBinding(root, { workspace: { id: seat.company.id, slug: seat.company.slug }, email: seat.user.email, shared });
        if (written.reason === "tracked") notes.push(INIT_COPY.bindingKeptSharedTracked);
        else if (written.reason === "existing-shared") notes.push(INIT_COPY.bindingKeptSharedExisting);
        else if (written.changed) notes.push(written.form === "shared" ? INIT_COPY.bindingShared : INIT_COPY.bindingPrivate);
        return { id: BINDING_STEP_ID, label, status: written.changed ? "configured" : "already configured" };
      } catch (error) {
        // A CliError carries fixed copy; anything else is for the plan runner's generic detail.
        if (error instanceof CliError) return { id: BINDING_STEP_ID, label, status: "failed", detail: error.message };
        throw error;
      }
    },
  };
}

/**
 * Codex's fallback (spec D5, install.sh's register_codex): with no network opt-in available the Codex shell can't
 * reach the CLI, so Codex keeps talking to the MCP server. The key goes only into Codex's user-level config, mode 0600,
 * never into a project file (I1), and an existing entry is never overwritten (codexUpdateStep refreshes its key).
 * It is offered whenever Codex has no user-level entry and skips itself when the network opt-in is in effect by the time it runs.
 */
function codexRegisterStep(ctx: InitCtx, seat: StoredSeat, optInInEffect: () => Promise<boolean>): PlanStep {
  const file = join(codexHome(ctx.home, ctx.env), "config.toml");
  const shown = shownPath(file, ctx.home);
  const url = `${seat.origin}${MCP_PATH}`;
  const token = seat.token;
  const withinHome = isUnderHome(file, ctx.home);
  const label = INIT_COPY.codexRegisterLabel;
  const id = CODEX_REGISTER_STEP_ID;
  return {
    id,
    label,
    files: [file],
    sensitive: true,
    preview: `${shown}:\n[${CODEX_MCP_TABLE}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { "Authorization" = "Bearer <your key>" }`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      // The opt-in step ran before this one: when it took effect, Codex's shell reaches the CLI and needs no key of its own.
      if (await optInInEffect()) return { id, label, status: "skipped", detail: INIT_COPY.codexRegisterNotNeeded };
      if (!API_KEY_RE.test(token)) return { id, label, status: "failed", detail: INIT_COPY.codexKeyShape };
      let exists = false;
      try {
        const result = editTomlFile(
          file,
          (text) => {
            if (getTomlTable(text, CODEX_MCP_TABLE) !== null) {
              exists = true;
              return { text, changed: false };
            }
            const withUrl = setTomlKey(text, CODEX_MCP_TABLE, "url", url);
            const eol = withUrl.text.includes("\r\n") ? "\r\n" : "\n";
            return { text: `${withUrl.text}http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${token}`)} }${eol}`, changed: true };
          },
          { createIfMissing: true, mode: CODEX_CONFIG_MODE, withinHome },
        );
        if (exists) return { id, label, status: "already configured", detail: INIT_COPY.codexEntryExists };
        if (result.status === "refused") return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
        return { id, label, status: result.status === "changed" ? "configured" : "already configured" };
      } catch (error) {
        if (error instanceof TomlConflictError) return { id, label, status: "skipped", detail: INIT_COPY.codexTableInline };
        throw error;
      }
    },
  };
}

/** The saved logins by seat id; none when the store can't be read (the Codex key is then treated as unknown). */
function storedSeats(): Record<string, StoredSeat> {
  try {
    return readCredentials().seats;
  } catch {
    return {};
  }
}

async function hasUserLevelCodexEntry(scope: CleanupScope): Promise<boolean> {
  const userFile = resolvePath(join(codexHome(scope.home, scope.env ?? process.env), "config.toml"));
  const found = await findMcpEntries("codex", scope);
  return found.some((file) => resolvePath(file) === userFile);
}

type PlanInputs = {
  root: string | null;
  seat: StoredSeat;
  gates: Gates;
  share: boolean | undefined;
  tty: boolean;
  yes: boolean;
  cwd: string;
  notes: string[];
};

/** Steps 4 to 7 of spec section 6.1, in order, as one list. */
async function buildPlan(inputs: PlanInputs): Promise<{ entries: PlanEntry[]; manuals: ManualInstructions[] }> {
  const { root, seat, gates } = inputs;
  const plan = new PlanBuilder();
  const detectEnv = defaultDetectEnv();
  // Permission rules and every printed line use the bare name agents type; only hook entries run the absolute
  // `"<node>" "<bin>"` (cliCommandInfo), so a hook works from an editor whose PATH lacks the CLI.
  const cli = cliCommandInfo();
  if (cli.npx) inputs.notes.push(INIT_COPY.npxNote);
  const ctx: InitCtx = { ...detectEnv, projectRoot: root, cliCommand: CLI_NAME, hookCommand: cli.command, yes: inputs.yes, tty: inputs.tty };
  const detected = await detectHarnesses(detectEnv);

  // 4. Binding.
  if (root !== null) plan.step(bindingStep(root, seat, { share: inputs.share, ask: inputs.tty && !inputs.yes }, inputs.notes));

  // 5. Skill, for every detected harness (deduped by skills agent id).
  const agents = [...new Set(detected.flatMap((adapter) => (adapter.skillAgent === null ? [] : [adapter.skillAgent])))];
  const skill = await plan.guarded("skill-install", "Install skill", () => planSkillSteps({ root, cwd: inputs.cwd, mode: "init", agents }));
  for (const step of skill ?? []) plan.step(step);

  // 6. AGENTS.md section and the CLAUDE.md import.
  if (root !== null) {
    const instructions = await plan.guarded("instructions", "Write the AGENTS.md section", async () => planInstructionSteps(root, { mode: "init" }));
    for (const step of instructions ?? []) plan.step(step);
  }

  // 7. Sensitive writes: the permission rule and the hooks per adapter.
  for (const adapter of detected) {
    const permission = await plan.guarded(`${adapter.id}:permission`, `${adapter.label} permission`, () => adapter.permission(ctx));
    if (permission !== null) {
      if (!isManual(permission)) plan.step(permission, gates.noPermissions ? "--no-permissions" : undefined);
      else if (!gates.noPermissions) plan.manual(permission);
    }
    const hooks = await plan.guarded(`${adapter.id}:hooks`, `${adapter.label} hooks`, () => adapter.hooks(ctx));
    if (hooks !== null) {
      if (Array.isArray(hooks)) for (const step of hooks) plan.step(step, gates.noHooks ? "--no-hooks" : undefined);
      else if (!gates.noHooks) plan.manual(hooks);
    }
  }

  // Extras of every detected adapter (Cursor's allowlist note, Codex's network opt-in), before any cleanup step: Codex's
  // cleanup re-checks the opt-in when it applies and keeps its entry otherwise (D5).
  let codexOptIn = false;
  for (const adapter of detected) {
    if (adapter.extras === undefined) continue;
    const extras = await plan.guarded(`${adapter.id}:extras`, `${adapter.label} setup`, () => (adapter.extras as NonNullable<HarnessAdapter["extras"]>)(ctx));
    for (const item of extras ?? []) {
      if (!isManual(item)) {
        if (item.id === CODEX_OPT_IN_STEP_ID) codexOptIn = true;
        plan.step(item);
      } else if (!(gates.noHooks && item.code === CODEX_CODES.trustHooks)) {
        plan.manual(item);
      }
    }
  }

  const scope: CleanupScope = { home: ctx.home, projectRoot: root, platform: ctx.platform, startDir: inputs.cwd, env: ctx.env };

  // D5: Codex without a user-level MCP entry of its own gets one registered, unless the network opt-in is in effect when the
  // step runs (it skips itself then). An entry that is there is never replaced: its key is refreshed when it is this
  // account's address with another key, and a different address is only reported.
  const codex = detected.find((adapter) => adapter.id === CODEX_ID);
  if (codex !== undefined) {
    const file = codexUserFile(ctx.home, ctx.env);
    const url = `${seat.origin}${MCP_PATH}`;
    const optInInEffect = async (): Promise<boolean> => {
      try {
        const items = (await codex.extras?.(ctx)) ?? [];
        return items.some((item) => !isManual(item) && item.id === CODEX_OPT_IN_STEP_ID && !item.sensitive);
      } catch {
        return false;
      }
    };
    const has = await plan.guarded(CODEX_REGISTER_STEP_ID, INIT_COPY.codexRegisterLabel, () => hasUserLevelCodexEntry(scope));
    if (has === false) {
      if (!(await optInInEffect())) plan.step(codexRegisterStep(ctx, seat, optInInEffect));
    } else if (has === true) {
      const entry = readCodexEntry(file);
      const shown = shownPath(file, ctx.home);
      if (entry !== null && entry.url !== null && entry.url !== url) {
        plan.manual({ kind: "manual", harness: CODEX_ID, title: INIT_COPY.codexForeignTitle, lines: codexForeignLines(shown, safeForDisplay(entry.url, DISPLAY_MAX)), reason: INIT_COPY.codexForeignReason });
      } else if (entry !== null && entry.url === url) {
        if (entry.bearer === null) {
          plan.manual({ kind: "manual", harness: CODEX_ID, title: INIT_COPY.codexUnreadableTitle, lines: codexUnreadableLines(shown), reason: INIT_COPY.codexUnreadableReason });
        } else if (!bearerIs(entry.bearer, seat.token)) {
          // Whose key is it? Another saved login at this address (a different, still valid workspace) is only reported:
          // switching it would move every Codex session on the machine. A key none of the saved logins holds (the one a
          // re-login just revoked, or an unknown one) is refreshed.
          const owner = seatForBearer(storedSeats(), seat.origin, entry.bearer);
          if (owner !== undefined) {
            plan.manual({ kind: "manual", harness: CODEX_ID, title: INIT_COPY.codexOtherWorkspaceTitle, lines: codexOtherWorkspaceLines(shown, workspaceLabel(owner.seat)), reason: INIT_COPY.codexOtherWorkspaceReason });
          } else {
            plan.step(codexUpdateStep(ctx, seat, url));
          }
        }
      }
    }
  }

  // MCP cleanup (D3), for every harness: a stale entry in a committed project file matters whether or not the editor is installed here.
  for (const adapter of ADAPTERS) {
    const cleanup = await plan.guarded(`mcp-cleanup:${adapter.id}`, `${adapter.label} MCP cleanup`, () => adapter.mcpCleanup(scope));
    for (const item of cleanup ?? []) {
      if (isManual(item)) {
        if (!gates.keepMcp) plan.manual(item);
      } else if (gates.keepMcp) {
        plan.step(item, "--keep-mcp");
      } else if (adapter.id === CODEX_ID && !codexOptIn) {
        // Codex's gate would keep it at apply time; say so instead of asking.
        plan.entries.push({ kind: "result", result: { id: item.id, label: item.label, status: "skipped", detail: INIT_COPY.codexKept } });
      } else {
        plan.step(item);
      }
    }
  }
  return { entries: plan.entries, manuals: plan.manuals };
}

function writeManuals(ctx: CommandContext, manuals: ManualInstructions[]): void {
  if (manuals.length === 0) return;
  ctx.stderr.write(`\n${INIT_COPY.manualHeading}\n`);
  for (const item of manuals) {
    ctx.stderr.write(`  ${safeForDisplay(item.title, MANUAL_LINE_MAX)}\n`);
    for (const line of item.lines) ctx.stderr.write(`    ${safeForDisplay(line, MANUAL_LINE_MAX)}\n`);
  }
}

/** The command, with the sign-in's test seams. */
export async function runInit(ctx: CommandContext, args: ParsedArgs, deps: InitDeps = {}): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError("init takes no arguments. The key comes from the JUBARTEAI_TOKEN environment variable or a browser login, never the command line.");
  const flag = (name: string): boolean => args.flags[name] === true;
  if (flag("share-binding") && flag("private-binding")) throw new UsageError(INIT_COPY.bindingConflict);
  const share = flag("share-binding") ? true : flag("private-binding") ? false : undefined;
  const gates: Gates = { keepMcp: flag("keep-mcp"), noHooks: flag("no-hooks"), noPermissions: flag("no-permissions") };
  const yes = ctx.globals.yes;

  const { root, reason } = projectRootOf(ctx.cwd);
  if (root === null && reason !== null) ctx.stderr.write(`${INIT_COPY.globalOnly}\n`);
  const tty = isInteractive();

  const seat = await chooseAccount(
    ctx,
    root,
    { workspace: ctx.globals.workspace, noBrowser: flag("no-browser"), paste: flag("paste") },
    tty,
    deps,
  );

  const notes: string[] = [];
  const { entries, manuals } = await buildPlan({ root, seat, gates, share, tty, yes, cwd: ctx.cwd, notes });
  const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
  const applied = await applyPlan(steps, { tty, yes, out: ctx.stderr });
  const byId = new Map(applied.map((result) => [result.id, result]));
  const results = entries.flatMap((entry): StepResult[] => {
    if (entry.kind === "result") return [entry.result];
    const result = byId.get(entry.step.id);
    return result === undefined ? [] : [result];
  });

  ctx.stderr.write("\n");
  for (const line of summarize(results)) ctx.stderr.write(`${line}\n`);
  for (const note of notes) ctx.stderr.write(`${note}\n`);
  if (results.some((result) => result.id.endsWith(":hooks") && result.status === "configured")) ctx.stderr.write(`${INIT_COPY.hooksRefresh}\n`);
  if (!tty && !yes && results.some((result) => result.status === "skipped" && result.flag !== undefined)) ctx.stderr.write(`${INIT_COPY.noTerminal}\n`);
  writeManuals(ctx, manuals);
  ctx.stderr.write(`\n${INIT_COPY.restart}\n`);
  return results.some((result) => result.status === "failed") ? ExitCode.SERVER_ERROR : ExitCode.OK;
}

export const initCommand: CommandDef = {
  name: "init",
  summary: "Connect this repo to JubarteAI: sign in, bind the workspace, install the skill and configure your agents",
  group: "setup",
  usage:
    "init [--workspace <slug>] [--no-browser] [--paste] [--share-binding | --private-binding] [--keep-mcp] [--no-hooks] [--no-permissions] [--yes]",
  flags: [
    { name: "no-browser", type: "boolean", description: "Print the sign-in URL instead of opening a browser" },
    { name: "paste", type: "boolean", description: "Paste the code from the browser (no local listener)" },
    { name: "share-binding", type: "boolean", description: "Commit the workspace binding for everyone who clones the repo (no question asked)" },
    { name: "private-binding", type: "boolean", description: "Keep the workspace binding private to you (no question asked)" },
    { name: "keep-mcp", type: "boolean", description: "Keep the jubarteai MCP entries in your editors' configs" },
    { name: "no-hooks", type: "boolean", description: "Don't add the session hooks" },
    { name: "no-permissions", type: "boolean", description: "Don't add the permission rule that lets agents run jubarteai" },
  ],
  run: (ctx, args) => runInit(ctx, args),
};
