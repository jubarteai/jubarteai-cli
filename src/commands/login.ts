import { refuseInAgentSession } from "../agent-session.js";
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { loginFlow, loginWithToken } from "../auth/login-flow.js";
import type { StoredSeat } from "../auth/credentials.js";
import { digestsEqual, keyDigest } from "../auth/key-digest.js";
import { MCP_PATH } from "../constants.js";
import { UsageError } from "../errors.js";
import { codexUpdateStep, codexUserFile, readCodexEntry } from "../harness/codex-entry.js";
import { CODEX_REVOKED_HINT } from "../install/init-copy.js";
import { homeDir } from "../paths.js";
import { promptHidden, isInteractive } from "../prompt.js";
import { envOrigin } from "../process-env.js";
import { applyPlan } from "../safe-edit/plan.js";
import { createUi } from "../ui/index.js";

// `jubarteai login` (spec section 5.5). The key of `--with-token` is read from stdin or a hidden
// prompt, never from argv.

/** A key is well under 200 characters; anything bigger before the first newline is not one. */
const KEY_INPUT_MAX_BYTES = 4096;

/** How long to wait for a key on a piped stdin that never sends one. */
const KEY_INPUT_TIMEOUT_MS = 30_000;

/**
 * The first line of a piped stdin: stops at the first newline (or the end of input), at most 4 KB, and
 * gives up after 30 s so a pipe that never closes can't hang the command. Fixed messages only.
 */
function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.pause();
      settle();
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      const newline = buffer.indexOf(0x0a);
      const used = newline === -1 ? buffer.length : newline;
      total += used;
      if (total > KEY_INPUT_MAX_BYTES) {
        finish(() => reject(new UsageError("Standard input is too large to be a key.")));
        return;
      }
      chunks.push(buffer.subarray(0, used));
      if (newline !== -1) finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    };
    const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (): void => finish(() => reject(new UsageError("Couldn't read standard input.")));
    const timer = setTimeout(
      () => finish(() => reject(new UsageError("Timed out waiting for a key on standard input."))),
      KEY_INPUT_TIMEOUT_MS,
    );
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

/** The key for `--with-token`: stdin when it is piped, a hidden prompt when it is a terminal. */
async function readKey(ctx: CommandContext): Promise<string> {
  const stdin = ctx.stdin as NodeJS.ReadableStream & { isTTY?: boolean };
  const entered = stdin.isTTY === true ? await promptHidden("Paste your JubarteAI key (input hidden):") : (await readFirstLine(stdin)).trim();
  if (entered === null || entered === "") {
    throw new UsageError("No key received. Pipe it in on standard input, or run in a terminal to be asked for it.");
  }
  return entered;
}

/**
 * The login just revoked the key it replaced. When Codex's user-level MCP entry (init's D5 fallback) holds that very
 * key, every Codex call would now fail with a revoked key, so offer the same update init does (its own prompt, default
 * yes; `--yes` applies it outside an agent's shell). Whenever the entry is left as it is (no terminal and no --yes,
 * declined, skipped, failed) a fixed hint says how to fix it. Keys are compared by digest and never printed.
 */
async function refreshCodexAfterLogin(ctx: CommandContext, seat: StoredSeat, replacedDigest: Buffer | null): Promise<void> {
  if (replacedDigest === null) return;
  const home = homeDir();
  const entry = readCodexEntry(codexUserFile(home, process.env));
  const url = `${seat.origin}${MCP_PATH}`;
  if (entry === null || entry.url !== url || entry.bearer === null || !digestsEqual(keyDigest(entry.bearer), replacedDigest)) return;
  const tty = isInteractive();
  const yes = ctx.globals.yes;
  if (!tty && !yes) {
    ctx.stderr.write(`${CODEX_REVOKED_HINT}\n`);
    return;
  }
  const ui = createUi(ctx.stderr, { ...(ctx.globals.plain === true ? { plain: true } : {}), ...(ctx.globals.verbose === true ? { verbose: true } : {}) });
  const results = await applyPlan([codexUpdateStep({ home, env: process.env }, seat, url)], {
    tty,
    yes,
    ui,
    timeline: ui.timeline(),
    approval: "confirm",
    title: "Update the key in Codex's MCP config?",
  });
  if (!results.every((result) => result.status === "configured" || result.status === "already configured")) ctx.stderr.write(`${CODEX_REVOKED_HINT}\n`);
}

async function run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) {
    throw new UsageError("login takes no arguments. Never put a key on the command line: use --with-token and send it on standard input.");
  }
  const withToken = args.flags["with-token"] === true;
  const paste = args.flags["paste"] === true;
  const noBrowser = args.flags["no-browser"] === true;
  const { workspace } = ctx.globals;

  if (withToken) {
    if (paste || noBrowser) throw new UsageError("--with-token can't be combined with --paste or --no-browser.");
    if (workspace !== undefined) throw new UsageError("--with-token can't be combined with --workspace: the key decides the workspace.");
    // A key piped in by an agent would switch the account every hook and command writes to (R-M1).
    refuseInAgentSession("login --with-token");
    const token = await readKey(ctx);
    await loginWithToken(ctx, { origin: envOrigin(), token });
    return 0;
  }

  const signedIn = await loginFlow(ctx, { origin: envOrigin(), ...(workspace === undefined ? {} : { workspace }), noBrowser, paste });
  // The browser path only: a pasted dashboard key revokes nothing.
  await refreshCodexAfterLogin(ctx, signedIn.seat, signedIn.replacedDigest);
  return 0;
}

export const loginCommand: CommandDef = {
  name: "login",
  summary: "Sign in to JubarteAI and save a key for this machine",
  group: "account",
  usage: "login [--workspace <slug>] [--paste] [--no-browser] | login --with-token < key",
  flags: [
    { name: "no-browser", type: "boolean", description: "Print the sign-in URL instead of opening a browser" },
    { name: "paste", type: "boolean", description: "Paste the code from the browser (no local listener)" },
    { name: "with-token", type: "boolean", description: "Save a dashboard key read from standard input or a hidden prompt" },
  ],
  run,
};
