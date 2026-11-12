import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { CommandContext } from "../cli/commands.js";
import { CliError } from "../errors.js";
import { credentialsPath } from "../paths.js";
import { readCredentials } from "./credentials.js";
import { loginFlow, loginWithToken } from "./login-flow.js";
import type { WhoamiResponse } from "./whoami.js";

// The identity a login saves comes only from the seat the key was minted for (spec §7.2): when the token response
// leaves email/slug/name null, whoami fills them only if it answers for that same seat, and a pasted key whose owner
// whoami can't name is not saved. whoami is replaced here so it can answer for another seat, which the fake server
// (one identity per key) can't do; the token exchange still runs against the fake server.

const whoamiMock = vi.hoisted(() => ({ answers: [] as Array<WhoamiResponse | Error>, calls: [] as Array<{ origin: string; token: string }> }));

vi.mock("./whoami.js", () => ({
  whoami: vi.fn(async (origin: string, token: string) => {
    whoamiMock.calls.push({ origin, token });
    const next = whoamiMock.answers.shift();
    if (next === undefined) throw new Error("no whoami answer queued");
    if (next instanceof Error) throw next;
    return next;
  }),
}));

const MINTED = "jba_MINTEDBYTHEEXCHANGE000001";
const PASTED = "jba_PASTEDDASHBOARDKEY000001";
const SEAT = "seat-token";

let sandbox: string;
let fake: FakeAuthServer;
let saved: Record<string, string | undefined>;
const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"] as const;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-login-identity-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.APPDATA = join(sandbox, "AppData");
  delete process.env.XDG_CONFIG_HOME;
  fake = await startFakeAuthServer();
  whoamiMock.answers = [];
  whoamiMock.calls = [];
});

afterEach(async () => {
  await fake.close();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function context(): { ctx: CommandContext; err: () => string } {
  let text = "";
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { ctx: { stdout: new PassThrough(), stderr, stdin: new PassThrough(), cwd: sandbox, globals: { pretty: false, yes: false } }, err: () => text };
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

function who(seatId: string, overrides: Partial<WhoamiResponse> = {}): WhoamiResponse {
  return {
    seat_id: seatId,
    user: { id: "user-1", email: "ada@example.com" },
    company: { id: "company-1", slug: "acme", name: "Acme Inc" },
    key: { id: "key-1", prefix: "jba_PASTEDDA", name: "Laptop key", minted_by: "dashboard" },
    ...overrides,
  };
}

/** The token response the server sends when its own identity lookups failed: email, slug and name null. */
function nullIdentityToken(): void {
  fake.tokenOverride = {
    status: 200,
    body: {
      token: MINTED,
      key: { id: "key-1", prefix: "jba_MINTEDBY", name: "CLI · host · 2026-11-11" },
      seat_id: SEAT,
      user: { id: "user-1", email: null },
      company: { id: "company-1", slug: null, name: null },
      replaced: false,
    },
  };
}

/** Logs in through the browser path: the fake browser approves at once, the token answer is the override. */
function login(ctx: CommandContext) {
  return loginFlow(ctx, { origin: fake.origin, noBrowser: false, paste: false }, {
    openBrowser: async (url) => {
      void fake.approve(url);
      return true;
    },
    whoamiRetryDelayMs: 0,
  });
}

describe("loginFlow: whoami fills a null identity only for the seat the key was minted for", () => {
  it("control: whoami for the same seat fills email, slug and name, asked with the new key", async () => {
    nullIdentityToken();
    whoamiMock.answers = [who(SEAT)];
    const { ctx, err } = context();
    const { seat } = await login(ctx);
    expect(seat).toMatchObject({ token: MINTED, user: { email: "ada@example.com" }, company: { slug: "acme", name: "Acme Inc" } });
    expect(whoamiMock.calls).toEqual([{ origin: fake.origin, token: MINTED }]);
    expect(readCredentials().seats[SEAT]?.user.email).toBe("ada@example.com");
    expect(err()).toContain("Signed in as ada@example.com — Acme Inc");
  });

  it("a whoami answer for another seat is not used: both tries are spent, nothing is saved, exit 1", async () => {
    nullIdentityToken();
    whoamiMock.answers = [
      who("seat-other", { user: { id: "user-9", email: "eve@example.com" }, company: { id: "company-9", slug: "evil", name: "Evil" } }),
      who("seat-other", { user: { id: "user-9", email: "eve@example.com" }, company: { id: "company-9", slug: "evil", name: "Evil" } }),
    ];
    const { ctx, err } = context();
    const error = await thrown(login(ctx));
    expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 1, code: "identity_unconfirmed" });
    expect(whoamiMock.calls).toHaveLength(2);
    expect(() => readFileSync(credentialsPath())).toThrow();
    expect(err()).not.toContain("eve@example.com");
  });

  it("the second try still fills when only the first answered for another seat", async () => {
    nullIdentityToken();
    whoamiMock.answers = [who("seat-other", { user: { id: "user-9", email: "eve@example.com" } }), who(SEAT)];
    const { ctx } = context();
    const { seat } = await login(ctx);
    expect(seat.user.email).toBe("ada@example.com");
    expect(whoamiMock.calls).toHaveLength(2);
  });

  it("a whoami answer with a null email leaves the login unconfirmed rather than saving a blank identity", async () => {
    nullIdentityToken();
    whoamiMock.answers = [who(SEAT, { user: { id: "user-1", email: null } }), who(SEAT, { user: { id: "user-1", email: null } })];
    const { ctx } = context();
    const error = await thrown(login(ctx));
    expect(error.code).toBe("identity_unconfirmed");
    expect(() => readFileSync(credentialsPath())).toThrow();
  });
});

describe("loginWithToken: a pasted key whose owner whoami can't name", () => {
  it("is refused (exit 1, identity_unconfirmed), saving nothing and printing no key", async () => {
    whoamiMock.answers = [who(SEAT, { user: { id: "user-1", email: null } })];
    const { ctx, err } = context();
    const error = await thrown(loginWithToken(ctx, { origin: fake.origin, token: PASTED }));
    expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 1, code: "identity_unconfirmed" });
    expect(() => readFileSync(credentialsPath())).toThrow();
    expect(error.message + err()).not.toContain(PASTED);
  });

  it("control: the same answer with an email is saved as a dashboard key under whoami's seat", async () => {
    whoamiMock.answers = [who(SEAT)];
    const { ctx } = context();
    const { seatId, seat } = await loginWithToken(ctx, { origin: fake.origin, token: PASTED });
    expect(seatId).toBe(SEAT);
    expect(seat).toMatchObject({ minted_by: "dashboard", token: PASTED, user: { email: "ada@example.com" } });
  });
});
