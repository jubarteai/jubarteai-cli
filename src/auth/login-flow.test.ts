import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { CommandContext } from "../cli/commands.js";
import { LOGIN_TIMEOUT_MS } from "../constants.js";
import { CliError, UsageError } from "../errors.js";
import { setTtyOpenerForTests } from "../prompt.js";
import type { TtyHandle } from "../prompt.js";
import { credentialsPath } from "../paths.js";
import { readCredentials, saveSeat } from "./credentials.js";
import { keyDigest } from "./key-digest.js";
import type { StoredSeat } from "./credentials.js";
import { loginFlow, loginWithToken } from "./login-flow.js";

const posix = process.platform !== "win32";
const DASHBOARD_KEY = "jba_DASHBOARDKEYDASHBOARDKEY01";
const OLD_CLI_KEY = "jba_OLDCLIKEYOLDCLIKEYOLDCLI01";

let sandbox: string;
let fake: FakeAuthServer;
let saved: Record<string, string | undefined>;

const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"] as const;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-login-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  delete process.env.XDG_CONFIG_HOME;
  fake = await startFakeAuthServer();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setTtyOpenerForTests(null);
  await fake.close();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function sink(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => text };
}

type TtyStdin = PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

function context(stdin: NodeJS.ReadableStream = new PassThrough()): { ctx: CommandContext; err: () => string; out: () => string } {
  const out = sink();
  const err = sink();
  return {
    ctx: { stdout: out.stream, stderr: err.stream, stdin, cwd: sandbox, globals: { pretty: false, yes: false } },
    err: err.text,
    out: out.text,
  };
}

function fakeTty() {
  const input = new PassThrough() as TtyStdin;
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
    return input;
  };
  let shown = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      shown += chunk.toString("utf8");
      callback();
    },
  });
  const handle: TtyHandle = { input, output, close() {} };
  setTtyOpenerForTests(() => handle);
  return { input, shown: () => shown, rawCalls };
}

/** A browser stand-in: the user approves right away, and the CLI's listener gets the callback. */
function approvingBrowser(opts: { state?: string; deny?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    open: async (url: string): Promise<boolean> => {
      calls.push(url);
      void fake.approve(url, opts);
      return true;
    },
  };
}

function seatOf(token: string, overrides: Partial<StoredSeat> = {}): StoredSeat {
  return {
    origin: fake.origin,
    token,
    minted_by: "cli",
    key: { id: "key-old", prefix: token.slice(0, 12), name: "CLI · oldhost · 2026-11-01" },
    user: fake.identity.user,
    company: fake.identity.company,
    saved_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

async function thrown(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

const flowOpts = (overrides: Partial<{ workspace: string; noBrowser: boolean; paste: boolean }> = {}) => ({
  origin: fake.origin,
  noBrowser: false,
  paste: false,
  ...overrides,
});

describe("loginFlow: browser callback", () => {
  it("opens the authorize URL, takes the callback, exchanges with the PKCE verifier and saves the default seat", async () => {
    const browser = approvingBrowser();
    const { ctx, err } = context();
    const result = await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });

    const url = new URL(browser.calls[0] as string);
    expect(url.origin).toBe(fake.origin);
    expect(url.pathname).toBe("/cli/authorize");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Number(url.searchParams.get("port"))).toBeGreaterThan(1023);
    expect(url.searchParams.get("host")).toMatch(/^[A-Za-z0-9._-]{1,63}$/);
    expect(url.searchParams.get("cli")).toMatch(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
    expect(url.searchParams.has("workspace")).toBe(false);
    expect(url.searchParams.has("mode")).toBe(false);

    expect(fake.exchanges[0]?.replaces).toBeNull();
    // The fake server answers invalid_grant unless sha256(verifier) equals the challenge in the URL, so
    // a successful login proves the verifier the CLI sent matches the challenge it advertised.
    expect(fake.requests.filter((request) => request.path === "/api/cli/token")).toHaveLength(1);

    expect(result.seatId).toBe(fake.identity.seat_id);
    expect(result.seat).toMatchObject({ origin: fake.origin, minted_by: "cli", user: { email: "ada@example.com" }, company: { slug: "acme" } });
    const stored = readCredentials();
    expect(stored.default_seat).toBe(fake.identity.seat_id);
    expect(stored.seats[fake.identity.seat_id]?.token).toBe(result.seat.token);
    if (posix) expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(err()).toContain("Signed in as ada@example.com — Acme Inc");
  });

  it("never prints the key, the code or the verifier", async () => {
    const browser = approvingBrowser();
    const { ctx, err, out } = context();
    const { seat } = await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    const code = fake.exchanges[0]?.code as string;
    const verifier = fake.exchanges[0]?.code_verifier as string;
    for (const text of [err(), out()]) {
      expect(text).not.toContain(seat.token);
      expect(text).not.toContain(code);
      expect(text).not.toContain(verifier);
    }
    expect(out()).toBe("");
  });

  it("sends --workspace as a preselect on the authorize URL", async () => {
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts({ workspace: "acme" }), { openBrowser: browser.open });
    expect(new URL(browser.calls[0] as string).searchParams.get("workspace")).toBe("acme");
  });

  it("--no-browser prints the URL on stderr and does not open anything", async () => {
    const opener = vi.fn(async () => true);
    const { ctx, err } = context();
    const pending = loginFlow(ctx, flowOpts({ noBrowser: true }), { openBrowser: opener });
    const url = await vi.waitFor(() => {
      const match = /(http:\/\/\S+\/cli\/authorize\S+)/.exec(err());
      if (match === null) throw new Error("URL not printed yet");
      return match[1] as string;
    });
    void fake.approve(url);
    await pending;
    expect(opener).not.toHaveBeenCalled();
    expect(err()).toContain("Open this URL in your browser");
  });

  it("prints the URL when the browser can't be opened", async () => {
    const opener = vi.fn(async (url: string) => {
      void fake.approve(url);
      return false;
    });
    const { ctx, err } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: opener });
    expect(err()).toContain("Couldn't open a browser");
    expect(err()).toContain("/cli/authorize?");
  });

  it("answers a callback with the wrong state with 400 and keeps waiting for the right one", async () => {
    let wrongStatus = 0;
    const opener = async (url: string): Promise<boolean> => {
      void (async () => {
        wrongStatus = (await fake.approve(url, { state: "Z".repeat(22) })).status;
        await fake.approve(url);
      })();
      return true;
    };
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: opener });
    expect(wrongStatus).toBe(400);
    expect(fake.exchanges).toHaveLength(1);
  });

  it("access_denied ends with 'Login denied.' and exit 1, minting nothing", async () => {
    const browser = approvingBrowser({ deny: true });
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: browser.open }));
    expect(error.message).toBe("Login denied.");
    expect(error.exitCode).toBe(1);
    expect(fake.exchanges).toHaveLength(0);
    expect(() => readFileSync(credentialsPath())).toThrow();
  });

  it("times out after five minutes with exit 1 and the paste hint (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opener = async (): Promise<boolean> => {
      vi.advanceTimersByTime(LOGIN_TIMEOUT_MS);
      return true;
    };
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: opener }));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("jubarteai login --paste");
    expect(fake.exchanges).toHaveLength(0);
  });

  it("closes the listener once the code arrives", async () => {
    let port = 0;
    const opener = async (url: string): Promise<boolean> => {
      port = Number(new URL(url).searchParams.get("port"));
      void fake.approve(url);
      return true;
    };
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: opener });
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it("fails before opening anything when the credential file is unreadable", async () => {
    mkdirSync(join(sandbox, ".config", "jubarteai"), { recursive: true });
    writeFileSync(credentialsPath(), "{ not json");
    const opener = vi.fn(async () => true);
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: opener }));
    expect(error.code).toBe("credentials_malformed");
    expect(opener).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("loginFlow: exchange failures", () => {
  it.each([
    [400, { error: "invalid_grant" }, 1],
    [402, { error: "billing_inactive" }, 3],
    [403, { error: "seat_inactive" }, 3],
    [500, { error: "server_error" }, 4],
  ])("status %i exits %i and saves nothing", async (status, body, exitCode) => {
    fake.tokenOverride = { status, body };
    const browser = approvingBrowser();
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: browser.open }));
    expect(error.exitCode).toBe(exitCode);
    expect(() => readFileSync(credentialsPath())).toThrow();
  });
});

describe("loginFlow: replaces", () => {
  it("sends a stored CLI key for the workspace and the server revokes it", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const browser = approvingBrowser();
    const { ctx, err } = context();
    const { seat } = await loginFlow(ctx, flowOpts({ workspace: "acme" }), { openBrowser: browser.open });
    expect(fake.exchanges[0]?.replaces).toBe(OLD_CLI_KEY);
    expect(fake.isRevoked(OLD_CLI_KEY)).toBe(true);
    expect(readCredentials().seats[fake.identity.seat_id]?.token).toBe(seat.token);
    expect(err()).toContain("previous CLI key");
  });

  it("without --workspace it offers the default seat's CLI key", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(fake.exchanges[0]?.replaces).toBe(OLD_CLI_KEY);
  });

  it("warns when the seat's older CLI key was not the one sent and so is still active", async () => {
    // The default seat (another workspace) is offered for revocation; the seat actually approved keeps its key.
    saveSeat("other-seat", seatOf(OLD_CLI_KEY, { company: { id: "c2", slug: "other", name: "Other" } }), { makeDefault: false });
    saveSeat(fake.identity.seat_id, seatOf("jba_STILLACTIVEKEYSTILLACTIVE01"), { makeDefault: true });
    saveSeat("other-seat", seatOf(OLD_CLI_KEY, { company: { id: "c2", slug: "other", name: "Other" }, saved_at: "2026-11-09T00:00:00Z" }), { makeDefault: true });
    const browser = approvingBrowser();
    const { ctx, err } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(fake.exchanges[0]?.replaces).toBe(OLD_CLI_KEY);
    expect(err()).toContain("Your previous CLI key for Acme Inc is still active; revoke it in Dashboard → API keys.");
    expect(err()).not.toContain("STILLACTIVEKEY");
  });

  it("does not warn when the key that was sent was revoked", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const browser = approvingBrowser();
    const { ctx, err } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(err()).not.toContain("still active");
  });

  it("returns the digest of the key the server revoked (never the key), and null when nothing was revoked", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const { ctx } = context();
    const first = await loginFlow(ctx, flowOpts(), { openBrowser: approvingBrowser().open });
    expect(first.replacedDigest?.equals(keyDigest(OLD_CLI_KEY))).toBe(true);
    expect(JSON.stringify(first)).not.toContain(OLD_CLI_KEY);
    // A login with no stored CLI key replaces nothing.
    rmSync(credentialsPath());
    const second = await loginFlow(context().ctx, flowOpts(), { openBrowser: approvingBrowser().open });
    expect(second.replacedDigest).toBeNull();
  });

  it("never sends a dashboard key", async () => {
    fake.addKey(DASHBOARD_KEY, "dashboard");
    saveSeat(fake.identity.seat_id, seatOf(DASHBOARD_KEY, { minted_by: "dashboard" }), { makeDefault: true });
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts({ workspace: "acme" }), { openBrowser: browser.open });
    expect(fake.exchanges[0]?.replaces).toBeNull();
    expect(fake.isRevoked(DASHBOARD_KEY)).toBe(false);
  });

  it("does not send a CLI key stored for another workspace or another origin", async () => {
    saveSeat("other-seat", seatOf(OLD_CLI_KEY, { company: { id: "c2", slug: "other", name: "Other" } }), { makeDefault: true });
    saveSeat(
      "foreign-origin-seat",
      seatOf("jba_FOREIGNORIGINKEYFOREIGN01", { origin: "https://staging.example.com", company: { id: "c3", slug: "acme", name: "Acme" } }),
      { makeDefault: false },
    );
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts({ workspace: "acme" }), { openBrowser: browser.open });
    expect(fake.exchanges[0]?.replaces).toBeNull();
  });
});

describe("loginFlow: identity the server left null", () => {
  it("fills email, slug and name from whoami with the new key, then saves", async () => {
    fake.nullIdentity = true;
    const browser = approvingBrowser();
    const { ctx, err } = context();
    const { seat } = await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    const whoamiCall = fake.requests.find((request) => request.path === "/api/cli/whoami");
    expect(whoamiCall?.authorization).toBe(`Bearer ${seat.token}`);
    expect(readCredentials().seats[fake.identity.seat_id]).toMatchObject({ user: { email: "ada@example.com" }, company: { slug: "acme", name: "Acme Inc" } });
    expect(err()).toContain("Signed in as ada@example.com — Acme Inc");
  });

  it("tries whoami twice", async () => {
    fake.nullIdentity = true;
    fake.whoamiFailures = 1;
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open, whoamiRetryDelayMs: 0 });
    expect(fake.requests.filter((request) => request.path === "/api/cli/whoami")).toHaveLength(2);
    expect(readCredentials().default_seat).toBe(fake.identity.seat_id);
  });

  it("when both whoami tries fail it saves nothing and exits 1 with the fixed message", async () => {
    fake.nullIdentity = true;
    fake.whoamiFailures = 2;
    const browser = approvingBrowser();
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: browser.open, whoamiRetryDelayMs: 0 }));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("Signed in, but JubarteAI couldn't confirm your account details. Run jubarteai login again.");
    expect(error.message).toContain("Dashboard → API keys");
    expect(() => readFileSync(credentialsPath())).toThrow();
    expect(fake.requests.filter((request) => request.path === "/api/cli/whoami")).toHaveLength(2);
  });

  it("does not touch an existing seat when the identity can't be confirmed", async () => {
    saveSeat("keep-me", seatOf(OLD_CLI_KEY, { company: { id: "c9", slug: "keep", name: "Keep" } }), { makeDefault: true });
    fake.nullIdentity = true;
    fake.whoamiFailures = 2;
    const browser = approvingBrowser();
    const { ctx } = context();
    await thrown(loginFlow(ctx, flowOpts(), { openBrowser: browser.open, whoamiRetryDelayMs: 0 }));
    expect(Object.keys(readCredentials().seats)).toEqual(["keep-me"]);
  });

  it("when whoami fails too, fills the identity from the stored seat with the same seat id and saves the new key", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    fake.nullIdentity = true;
    fake.whoamiFailures = 2;
    const browser = approvingBrowser();
    const { ctx, err } = context();
    const { seat } = await loginFlow(ctx, flowOpts(), { openBrowser: browser.open, whoamiRetryDelayMs: 0 });
    // The old key was revoked by the exchange, so the new one has to be saved or the user is locked out.
    expect(fake.isRevoked(OLD_CLI_KEY)).toBe(true);
    const stored = readCredentials().seats[fake.identity.seat_id];
    expect(stored?.token).toBe(seat.token);
    expect(stored).toMatchObject({ user: { email: "ada@example.com" }, company: { slug: "acme", name: "Acme Inc" } });
    expect(err()).toContain("Signed in as ada@example.com — Acme Inc");
  });

  it("does not borrow from a stored seat of another user or workspace", async () => {
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY, { user: { id: "someone-else", email: "eve@example.com" } }), { makeDefault: true });
    fake.nullIdentity = true;
    fake.whoamiFailures = 2;
    const browser = approvingBrowser();
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts(), { openBrowser: browser.open, whoamiRetryDelayMs: 0 }));
    expect(error.code).toBe("identity_unconfirmed");
    expect(readCredentials().seats[fake.identity.seat_id]?.token).toBe(OLD_CLI_KEY);
  });

  it("skips whoami when the response already has the identity", async () => {
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(fake.requests.some((request) => request.path === "/api/cli/whoami")).toBe(false);
  });
});

describe("loginFlow: paste mode", () => {
  it("asks for mode=paste (no port), reads the code hidden and exchanges it", async () => {
    const tty = fakeTty();
    const urls: string[] = [];
    const opener = async (url: string): Promise<boolean> => {
      urls.push(url);
      const code = fake.mintCode(new URL(url).searchParams.get("challenge") as string);
      tty.input.write(`${code}\r`);
      return true;
    };
    const { ctx } = context();
    const { seat } = await loginFlow(ctx, flowOpts({ paste: true }), { openBrowser: opener });
    const url = new URL(urls[0] as string);
    expect(url.searchParams.get("mode")).toBe("paste");
    expect(url.searchParams.has("port")).toBe(false);
    expect(tty.rawCalls).toContain(true);
    expect(tty.shown()).not.toContain(fake.exchanges[0]?.code as string);
    expect(seat.minted_by).toBe("cli");
  });

  it("re-asks after a code of the wrong shape, then accepts a good one", async () => {
    const tty = fakeTty();
    const { ctx, err } = context();
    const opener = async (url: string): Promise<boolean> => {
      tty.input.write("hello-not-a-code\r");
      tty.input.write(`${fake.mintCode(new URL(url).searchParams.get("challenge") as string)}\r`);
      return true;
    };
    await loginFlow(ctx, flowOpts({ paste: true }), { openBrowser: opener });
    expect(err()).toContain("doesn't look like a sign-in code");
    expect(err()).not.toContain("hello-not-a-code");
    expect(fake.exchanges).toHaveLength(1);
  });

  it("gives up after three bad codes without calling the server", async () => {
    const tty = fakeTty();
    const { ctx } = context();
    const opener = async (): Promise<boolean> => {
      for (let i = 0; i < 3; i++) tty.input.write("nope\r");
      return true;
    };
    const error = await thrown(loginFlow(ctx, flowOpts({ paste: true }), { openBrowser: opener }));
    expect(error).toBeInstanceOf(UsageError);
    expect(fake.exchanges).toHaveLength(0);
  });

  it("is a usage error when there is no terminal to paste into", async () => {
    setTtyOpenerForTests(() => null);
    const { ctx } = context();
    const error = await thrown(loginFlow(ctx, flowOpts({ paste: true, noBrowser: true })));
    expect(error.exitCode).toBe(2);
    expect(fake.exchanges).toHaveLength(0);
  });
});

describe("loginFlow: typing the code while the listener waits", () => {
  it("a code typed at the hidden prompt wins when the browser never calls back", async () => {
    const tty = fakeTty();
    const stdin = new PassThrough() as TtyStdin;
    stdin.isTTY = true;
    const { ctx } = context(stdin);
    let port = 0;
    const opener = async (url: string): Promise<boolean> => {
      port = Number(new URL(url).searchParams.get("port"));
      tty.input.write(`${fake.mintCode(new URL(url).searchParams.get("challenge") as string)}\r`);
      return true;
    };
    const { seat } = await loginFlow(ctx, flowOpts(), { openBrowser: opener });
    expect(seat.minted_by).toBe("cli");
    expect(fake.exchanges).toHaveLength(1);
    expect(tty.input.listenerCount("data")).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it("the browser callback wins over a pending prompt and detaches the prompt from the terminal stream", async () => {
    const tty = fakeTty();
    const stdin = new PassThrough() as TtyStdin;
    stdin.isTTY = true;
    const { ctx } = context(stdin);
    // The prompt reads from the opener's stream (not ctx.stdin); while it waits it holds a listener there.
    const browser = {
      open: async (url: string): Promise<boolean> => {
        void (async () => {
          await vi.waitFor(() => expect(tty.input.listenerCount("data")).toBe(1));
          await fake.approve(url);
        })();
        return true;
      },
    };
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(tty.input.listenerCount("data")).toBe(0);
    expect(tty.input.listenerCount("end")).toBe(0);
    expect(tty.rawCalls.at(-1)).toBe(false);
    expect(fake.exchanges).toHaveLength(1);
  });

  it("offers no prompt when stdin is not a terminal", async () => {
    const tty = fakeTty();
    const browser = approvingBrowser();
    const { ctx } = context();
    await loginFlow(ctx, flowOpts(), { openBrowser: browser.open });
    expect(tty.shown()).toBe("");
    expect(tty.input.listenerCount("data")).toBe(0);
  });
});

describe("loginWithToken", () => {
  it("files a dashboard key under the seat whoami reports and makes it the default", async () => {
    fake.addKey(DASHBOARD_KEY, "dashboard");
    const { ctx, err } = context();
    const { seatId, seat } = await loginWithToken(ctx, { origin: fake.origin, token: DASHBOARD_KEY });
    expect(seatId).toBe(fake.identity.seat_id);
    expect(seat).toMatchObject({ minted_by: "dashboard", token: DASHBOARD_KEY, origin: fake.origin, key: { name: "Laptop key" } });
    expect(readCredentials().default_seat).toBe(seatId);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${DASHBOARD_KEY}`);
    expect(err()).toBe("Signed in as ada@example.com — Acme Inc\n");
    expect(err()).not.toContain(DASHBOARD_KEY);
  });

  it("rejects a value that is not a key without contacting the server", async () => {
    const { ctx } = context();
    const error = await thrown(loginWithToken(ctx, { origin: fake.origin, token: "hello" }));
    expect(error.exitCode).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it("exits 3 for a key the server does not accept, saving nothing", async () => {
    const { ctx } = context();
    const error = await thrown(loginWithToken(ctx, { origin: fake.origin, token: DASHBOARD_KEY }));
    expect(error.exitCode).toBe(3);
    expect(error.message).not.toContain(DASHBOARD_KEY);
    expect(() => readFileSync(credentialsPath())).toThrow();
  });

  it("says so when the pasted key replaces a stored CLI key for the same workspace (the old key stays live)", async () => {
    fake.addKey(OLD_CLI_KEY, "cli");
    fake.addKey(DASHBOARD_KEY, "dashboard");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const { ctx, err } = context();
    await loginWithToken(ctx, { origin: fake.origin, token: DASHBOARD_KEY });
    expect(err()).toContain("Your previous CLI key for Acme Inc is still active; revoke it in Dashboard → API keys.");
    expect(err()).not.toContain(OLD_CLI_KEY);
    expect(fake.isRevoked(OLD_CLI_KEY)).toBe(false);
  });

  it("is silent about a replaced dashboard key, and about re-pasting the same CLI key", async () => {
    fake.addKey(DASHBOARD_KEY, "dashboard");
    saveSeat(fake.identity.seat_id, seatOf("jba_ANOTHERDASHBOARDKEYANOTHER1", { minted_by: "dashboard" }), { makeDefault: true });
    const first = context();
    await loginWithToken(first.ctx, { origin: fake.origin, token: DASHBOARD_KEY });
    expect(first.err()).not.toContain("still active");
    fake.addKey(OLD_CLI_KEY, "cli");
    saveSeat(fake.identity.seat_id, seatOf(OLD_CLI_KEY), { makeDefault: true });
    const second = context();
    await loginWithToken(second.ctx, { origin: fake.origin, token: OLD_CLI_KEY });
    expect(second.err()).not.toContain("still active");
  });

  it("stores the origin it was verified against", async () => {
    fake.addKey(DASHBOARD_KEY);
    const { ctx } = context();
    const { seat } = await loginWithToken(ctx, { origin: fake.origin, token: DASHBOARD_KEY });
    expect(seat.origin).toBe(fake.origin);
  });
});
