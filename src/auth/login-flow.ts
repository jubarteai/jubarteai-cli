import { hostname } from "node:os";

import type { CommandContext } from "../cli/commands.js";
import { safeForDisplay } from "../output.js";
import { createUi } from "../ui/index.js";
import { PROMPT_MAX_ATTEMPTS, LOGIN_TIMEOUT_MS, cliVersion } from "../constants.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { promptHidden } from "../prompt.js";
import { startCallbackServer } from "./callback-server.js";
import { readCredentials, saveSeat } from "./credentials.js";
import type { Credentials, StoredSeat } from "./credentials.js";
import { keyDigest, sameKey } from "./key-digest.js";
import { openBrowser } from "./open-browser.js";
import { createPkce, createState } from "./pkce.js";
import { API_KEY_RE, AUTH_CODE_RE, exchangeCode } from "./token-exchange.js";
import type { TokenResponse } from "./token-exchange.js";
import { whoami } from "./whoami.js";

// The login flows (spec sections 5.5 and 7.1): browser with a loopback callback, paste mode, and a
// pasted dashboard key. Everything printed here goes to stderr and never contains a key, a code, the
// PKCE verifier or the state (the authorize URL, which carries the state, is the one thing shown on
// purpose: it is what the user opens).

const AUTHORIZE_VERSION = "1";
const HOST_MAX = 63;
const WHOAMI_FILL_ATTEMPTS = 2;
const WHOAMI_FILL_TIMEOUT_MS = 3_000;
const WHOAMI_FILL_RETRY_MS = 250;
const PASTE_ATTEMPTS = 3;
const DISPLAY_MAX = 200;

const PASTE_HINT = "Run: jubarteai login --paste";

type LoginDeps = {
  /** Test seam: the browser opener. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Test seam: how long the loopback listener waits (default five minutes). */
  timeoutMs?: number;
  /** Test seam: the pause between the two whoami attempts. */
  whoamiRetryDelayMs?: number;
};

type TypedCode = { code: Promise<string>; cancel(): void };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The machine name as the key name carries it: `[A-Za-z0-9._-]` only, at most 63 characters. */
function safeHost(raw: string = hostname()): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, HOST_MAX);
  return cleaned === "" ? "unknown" : cleaned;
}

function authorizeUrl(origin: string, parts: { challenge: string; state: string; port: number | null; workspace?: string }): string {
  const url = new URL("/cli/authorize", origin);
  url.searchParams.set("v", AUTHORIZE_VERSION);
  url.searchParams.set("challenge", parts.challenge);
  url.searchParams.set("state", parts.state);
  if (parts.port === null) url.searchParams.set("mode", "paste");
  else url.searchParams.set("port", String(parts.port));
  url.searchParams.set("host", safeHost());
  url.searchParams.set("cli", cliVersion());
  if (parts.workspace !== undefined && parts.workspace !== "") url.searchParams.set("workspace", parts.workspace);
  return url.toString();
}

/**
 * The stored CLI-minted key to ask the server to revoke (spec section 3.1, I5): only a `minted_by: "cli"`
 * key on the login origin, never a pasted dashboard key. With `--workspace` only that workspace's seats
 * count; of several candidates the default seat wins, then the most recently saved. The server revokes
 * it only when it belongs to the seat that gets approved, so a wrong guess does nothing.
 */
function replacesKey(credentials: Credentials, origin: string, workspace: string | undefined): string | null {
  const wanted = workspace?.trim();
  const candidates = Object.entries(credentials.seats).filter(
    ([, seat]) =>
      seat.minted_by === "cli" &&
      seat.origin === origin &&
      API_KEY_RE.test(seat.token) &&
      (wanted === undefined || wanted === "" || seat.company.slug === wanted),
  );
  const chosen =
    candidates.find(([seatId]) => seatId === credentials.default_seat) ??
    candidates.sort(([, a], [, b]) => Date.parse(b.saved_at) - Date.parse(a.saved_at))[0];
  return chosen === undefined ? null : chosen[1].token;
}

async function announce(ctx: CommandContext, url: string, noBrowser: boolean, deps: LoginDeps): Promise<void> {
  if (noBrowser) {
    ctx.stderr.write(`Open this URL in your browser to sign in:\n  ${url}\n`);
    return;
  }
  const opened = await (deps.openBrowser ?? openBrowser)(url);
  if (opened) ctx.stderr.write("Opening your browser to sign in...\n");
  else ctx.stderr.write(`Couldn't open a browser. Open this URL to sign in:\n  ${url}\n`);
}

/** Lets the user type the code the browser shows while the listener waits; null without a terminal on stdin. */
function typedCodeSession(ctx: CommandContext): TypedCode | null {
  const stdin = ctx.stdin as NodeJS.ReadableStream & { isTTY?: boolean };
  if (stdin.isTTY !== true) return null;
  const controller = new AbortController();
  const { signal } = controller;
  const code = (async (): Promise<string> => {
    for (let attempt = 0; attempt < PROMPT_MAX_ATTEMPTS && !signal.aborted; attempt++) {
      const answer = await promptHidden("Or paste the code shown in your browser:", { signal });
      if (signal.aborted || answer === null) break;
      if (answer === "") continue;
      if (AUTH_CODE_RE.test(answer)) return answer;
      ctx.stderr.write("That doesn't look like a sign-in code (it starts with jbc_).\n");
    }
    // Gave up: stay silent and let the browser callback decide.
    return new Promise<string>(() => undefined);
  })();
  // Losing the race (or being aborted) must never surface as an unhandled rejection (ctrl-C rejects).
  code.catch(() => undefined);
  return {
    code,
    cancel() {
      // Aborting removes the prompt's listeners and restores the terminal.
      controller.abort();
      ctx.stderr.write("\n");
    },
  };
}

async function codeFromBrowser(ctx: CommandContext, opts: { origin: string; workspace?: string; noBrowser: boolean }, pkce: { challenge: string }, state: string, deps: LoginDeps): Promise<string> {
  let server: Awaited<ReturnType<typeof startCallbackServer>>;
  try {
    server = await startCallbackServer({ state, timeoutMs: deps.timeoutMs ?? LOGIN_TIMEOUT_MS });
  } catch {
    throw new CliError(`Couldn't open a local port for the browser to return to. ${PASTE_HINT}`, ExitCode.SERVER_ERROR, "listen_failed");
  }
  let typed: TypedCode | null = null;
  try {
    const url = authorizeUrl(opts.origin, {
      challenge: pkce.challenge,
      state,
      port: server.port,
      ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
    });
    await announce(ctx, url, opts.noBrowser, deps);
    const waitText = "Waiting for you to approve the login in the browser (Ctrl+C to cancel)";
    const ui = createUi(ctx.stderr, { ...(ctx.globals.plain === true ? { plain: true } : {}), ...(ctx.globals.verbose === true ? { verbose: true } : {}) });
    // Where the code can be typed too (a terminal on stdin) the prompt owns the line, so the wait stays text; otherwise
    // (the install one-liner pipes the script through stdin) it is a spinner on a rich terminal.
    const spin = ui.mode.animate && (ctx.stdin as { isTTY?: boolean }).isTTY !== true;
    if (!spin) ctx.stderr.write(`${waitText}...\n`);
    typed = typedCodeSession(ctx);
    const waiting: Array<Promise<{ code: string } | { error: "access_denied" } | { error: "timeout" }>> = [server.result];
    if (typed !== null) waiting.push(typed.code.then((code) => ({ code })));
    const outcome = spin ? await ui.spin(waitText, () => Promise.race(waiting)) : await Promise.race(waiting);
    if ("code" in outcome) return outcome.code;
    if (outcome.error === "access_denied") throw new CliError("Login denied.", ExitCode.SERVER_ERROR, "access_denied");
    throw new CliError(`Timed out waiting for the browser. ${PASTE_HINT}`, ExitCode.SERVER_ERROR, "login_timeout");
  } finally {
    server.close();
    typed?.cancel();
  }
}

async function codeFromPaste(ctx: CommandContext, opts: { origin: string; workspace?: string; noBrowser: boolean }, pkce: { challenge: string }, state: string, deps: LoginDeps): Promise<string> {
  const url = authorizeUrl(opts.origin, {
    challenge: pkce.challenge,
    state,
    port: null,
    ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
  });
  await announce(ctx, url, opts.noBrowser, deps);
  ctx.stderr.write("Approve the login in the browser, then paste the code it shows.\n");
  for (let attempt = 0; attempt < PASTE_ATTEMPTS; attempt++) {
    const answer = await promptHidden("Code (input hidden):");
    if (answer === null) {
      throw new UsageError("There is no terminal to paste the code into. Run jubarteai login without --paste.");
    }
    if (AUTH_CODE_RE.test(answer)) return answer;
    ctx.stderr.write("That doesn't look like a sign-in code (it starts with jbc_).\n");
  }
  throw new UsageError("No valid sign-in code was entered. Run jubarteai login again.");
}

function unconfirmed(): CliError {
  return new CliError(
    "Signed in, but JubarteAI couldn't confirm your account details. Run jubarteai login again. The key it created is listed in Dashboard → API keys.",
    ExitCode.SERVER_ERROR,
    "identity_unconfirmed",
  );
}

/**
 * The identity the server left null, filled from whoami with the new key (two short tries). If whoami
 * keeps failing, the stored seat with the same seat id (same user and workspace ids) supplies what is
 * missing. Only when neither can is the login reported as unconfirmed: a blank identity is never saved.
 */
async function identityOf(
  origin: string,
  token: TokenResponse,
  stored: StoredSeat | undefined,
  deps: LoginDeps,
): Promise<{ email: string; slug: string; name: string }> {
  let { email, slug, name } = { email: token.user.email, slug: token.company.slug, name: token.company.name };
  for (let attempt = 0; attempt < WHOAMI_FILL_ATTEMPTS && (email === null || slug === null || name === null); attempt++) {
    if (attempt > 0) await sleep(deps.whoamiRetryDelayMs ?? WHOAMI_FILL_RETRY_MS);
    try {
      const who = await whoami(origin, token.token, { timeoutMs: WHOAMI_FILL_TIMEOUT_MS });
      if (who.seat_id !== token.seat_id) continue;
      email = email ?? who.user.email;
      slug = slug ?? who.company.slug;
      name = name ?? who.company.name;
    } catch {
      // Retry once, then fall back to the stored seat.
    }
  }
  if (stored !== undefined && stored.user.id === token.user.id && stored.company.id === token.company.id) {
    email = email ?? stored.user.email;
    slug = slug ?? stored.company.slug;
    name = name ?? stored.company.name;
  }
  if (email === null || slug === null || name === null) throw unconfirmed();
  return { email, slug, name };
}

/** The notice for a CLI-minted key of this workspace that a login did not revoke (browser login and pasted key share it). */
function reportOldKeyStillActive(ctx: CommandContext, previous: StoredSeat): void {
  const label = previous.company.name !== "" ? previous.company.name : previous.company.slug;
  ctx.stderr.write(`Your previous CLI key for ${safeForDisplay(label, DISPLAY_MAX)} is still active; revoke it in Dashboard → API keys.\n`);
}

function reportSignedIn(ctx: CommandContext, seat: StoredSeat): void {
  const workspace = seat.company.name !== "" ? seat.company.name : seat.company.slug;
  ctx.stderr.write(`Signed in as ${safeForDisplay(seat.user.email, DISPLAY_MAX)} — ${safeForDisplay(workspace, DISPLAY_MAX)}\n`);
}

/**
 * Browser login (or paste mode): PKCE, the approved code, the exchange, then the seat saved as the
 * default. Reads the credential store first, so an unreadable store fails before a key is minted.
 */
export async function loginFlow(
  ctx: CommandContext,
  opts: { origin: string; workspace?: string; noBrowser: boolean; paste: boolean },
  deps: LoginDeps = {},
): Promise<{ seatId: string; seat: StoredSeat; replacedDigest: Buffer | null }> {
  const credentials = readCredentials();
  const replaces = replacesKey(credentials, opts.origin, opts.workspace);
  const pkce = createPkce();
  const state = createState();

  const code = opts.paste
    ? await codeFromPaste(ctx, opts, pkce, state, deps)
    : await codeFromBrowser(ctx, opts, pkce, state, deps);

  const token = await exchangeCode(opts.origin, { code, code_verifier: pkce.verifier, replaces });
  const previous = credentials.seats[token.seat_id];
  const identity = await identityOf(opts.origin, token, previous, deps);
  const seat: StoredSeat = {
    origin: opts.origin,
    token: token.token,
    minted_by: "cli",
    key: { id: token.key.id, prefix: token.key.prefix, name: token.key.name },
    user: { id: token.user.id, email: identity.email },
    company: { id: token.company.id, slug: identity.slug, name: identity.name },
    saved_at: new Date().toISOString(),
  };
  saveSeat(token.seat_id, seat, { makeDefault: true });
  reportSignedIn(ctx, seat);
  if (token.replaced) {
    ctx.stderr.write("Your previous CLI key for this workspace was revoked.\n");
  } else if (previous !== undefined && previous.minted_by === "cli" && previous.token !== replaces) {
    // The server only revokes the key we named; this seat's older CLI key is still live.
    reportOldKeyStillActive(ctx, previous);
  }
  // What the server revoked, as a digest only (the caller compares it with keys stored elsewhere, e.g. Codex's entry).
  return { seatId: token.seat_id, seat, replacedDigest: token.replaced && replaces !== null ? keyDigest(replaces) : null };
}

/**
 * Files a pasted dashboard key under its seat: whoami at `origin` says whose it is, and the seat is saved
 * as `minted_by: "dashboard"` (so a later login never revokes it) and made the default.
 */
export async function loginWithToken(
  ctx: CommandContext,
  opts: { origin: string; token: string },
): Promise<{ seatId: string; seat: StoredSeat }> {
  if (!API_KEY_RE.test(opts.token)) {
    throw new UsageError("That doesn't look like a JubarteAI key (it starts with jba_).");
  }
  const credentials = readCredentials();
  const who = await whoami(opts.origin, opts.token);
  if (who.user.email === null) {
    throw new CliError("JubarteAI couldn't confirm your account details. Try again in a moment.", ExitCode.SERVER_ERROR, "identity_unconfirmed");
  }
  const seat: StoredSeat = {
    origin: opts.origin,
    token: opts.token,
    minted_by: "dashboard",
    key: { id: who.key.id, prefix: who.key.prefix, name: who.key.name },
    user: { id: who.user.id, email: who.user.email },
    company: { id: who.company.id, slug: who.company.slug, name: who.company.name },
    saved_at: new Date().toISOString(),
  };
  const previous = credentials.seats[who.seat_id];
  saveSeat(who.seat_id, seat, { makeDefault: true });
  reportSignedIn(ctx, seat);
  // The pasted key replaced a CLI-minted one for this seat in the store; nothing told the server to revoke it.
  if (previous !== undefined && previous.minted_by === "cli" && !sameKey(previous.token, opts.token)) reportOldKeyStillActive(ctx, previous);
  return { seatId: who.seat_id, seat };
}
