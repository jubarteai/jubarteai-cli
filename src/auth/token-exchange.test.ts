import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { CliError } from "../errors.js";
import { authRequest, exchangeCode } from "./token-exchange.js";
import { createPkce } from "./pkce.js";

let fake: FakeAuthServer;
const extra: Server[] = [];

beforeEach(async () => {
  fake = await startFakeAuthServer();
});

afterEach(async () => {
  await fake.close();
  for (const server of extra.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

async function thrown(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

function body(overrides: { replaces?: string | null } = {}) {
  const pkce = createPkce();
  return { pkce, code: fake.mintCode(pkce.challenge), replaces: overrides.replaces ?? null };
}

describe("exchangeCode", () => {
  it("posts the code, verifier and replaces as JSON and returns the parsed response", async () => {
    const { pkce, code } = body();
    const token = await exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null });
    expect(token.token).toMatch(/^jba_/);
    expect(token).toMatchObject({
      seat_id: fake.identity.seat_id,
      user: { email: "ada@example.com" },
      company: { slug: "acme", name: "Acme Inc" },
      replaced: false,
    });
    expect(fake.requests[0]).toMatchObject({ method: "POST", path: "/api/cli/token", authorization: null });
    expect(fake.exchanges).toEqual([{ code, code_verifier: pkce.verifier, replaces: null }]);
  });

  it("passes null identity fields through", async () => {
    fake.nullIdentity = true;
    const { pkce, code } = body();
    const token = await exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null });
    expect(token.user.email).toBeNull();
    expect(token.company).toMatchObject({ slug: null, name: null });
  });

  it("maps invalid_grant to exit 1, billing and seat refusals to exit 3, a server error to exit 4", async () => {
    const cases: Array<[number, unknown, number, string]> = [
      [400, { error: "invalid_grant" }, 1, "invalid_grant"],
      [400, { error: "invalid_request" }, 1, "invalid_request"],
      [402, { error: "billing_inactive" }, 3, "billing_inactive"],
      [403, { error: "seat_inactive" }, 3, "seat_inactive"],
      [500, { error: "server_error" }, 4, "server_error"],
      [502, "<html>bad gateway</html>", 4, "server_error"],
    ];
    for (const [status, payload, exitCode, code] of cases) {
      fake.tokenOverride = { status, body: payload };
      const { pkce, code: authCode } = body();
      const error = await thrown(exchangeCode(fake.origin, { code: authCode, code_verifier: pkce.verifier, replaces: null }));
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: exitCode, code });
    }
  });

  it("burns a code that was already used (no retry)", async () => {
    const { pkce, code } = body();
    await exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null });
    const error = await thrown(exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null }));
    expect(error.code).toBe("invalid_grant");
    expect(fake.exchanges).toHaveLength(2);
  });

  it("rejects a 200 whose shape is wrong without echoing it", async () => {
    const leaked = "jba_LEAKEDLEAKEDLEAKEDLEAKED";
    for (const payload of [{}, { token: "not-a-key" }, { token: leaked }, "text", null, { ...validBody(), replaced: "yes" }, { ...validBody(), seat_id: "" }]) {
      fake.tokenOverride = { status: 200, body: payload };
      const { pkce, code } = body();
      const error = await thrown(exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null }));
      expect(error.exitCode).toBe(1);
      expect(error.message).not.toContain(leaked);
      expect(error.message).not.toContain("not-a-key");
    }
  });

  it("never puts a server message or body into the error", async () => {
    fake.tokenOverride = { status: 400, body: { error: "invalid_grant", message: "SECRET-SERVER-TEXT jba_ABCDEFGH12345678" } };
    const { pkce, code } = body();
    const error = await thrown(exchangeCode(fake.origin, { code, code_verifier: pkce.verifier, replaces: null }));
    expect(error.message).not.toContain("SECRET-SERVER-TEXT");
    expect(error.message).not.toContain("jba_");
  });

  it("is a network error (exit 4) when nothing answers", async () => {
    const origin = fake.origin;
    await fake.close();
    const { pkce, code } = body();
    const error = await thrown(exchangeCode(origin, { code, code_verifier: pkce.verifier, replaces: null }));
    expect(error.exitCode).toBe(4);
    expect(error.message).not.toContain(code);
    fake = await startFakeAuthServer();
  });

  it("never follows a redirect, so a code can't be forwarded elsewhere", async () => {
    let landed = 0;
    const target = createServer((_req, res) => {
      landed += 1;
      res.end("{}");
    });
    extra.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/steal`;
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { Location: targetUrl });
      res.end();
    });
    extra.push(redirector);
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    const { pkce, code } = body();
    const error = await thrown(exchangeCode(origin, { code, code_verifier: pkce.verifier, replaces: null }));
    expect(error.exitCode).toBe(4);
    expect(landed).toBe(0);
  });
});

describe("authRequest", () => {
  it("refuses an origin that is not https or loopback http", async () => {
    for (const origin of ["http://example.com", "ftp://example.com", "https://user:pw@example.com", "nope"]) {
      const error = await thrown(authRequest(origin, "/x", { method: "GET", timeoutMs: 1000 }));
      expect(error.exitCode).toBe(2);
    }
  });

  it("gives json null for a body that is not JSON or is too large", async () => {
    const big = createServer((req, res) => {
      res.end(req.url === "/big" ? "x".repeat(200_000) : "not json");
    });
    extra.push(big);
    await new Promise<void>((resolve) => big.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(big.address() as AddressInfo).port}`;
    expect((await authRequest(origin, "/", { method: "GET", timeoutMs: 2000 })).json).toBeNull();
    expect((await authRequest(origin, "/big", { method: "GET", timeoutMs: 2000 })).json).toBeNull();
  });

  it("times out as exit 4 when the server never answers", async () => {
    const silent = createServer(() => undefined);
    extra.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const error = await thrown(authRequest(origin, "/", { method: "GET", timeoutMs: 100 }));
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("timeout");
  });
});

function validBody() {
  return {
    token: "jba_ABCDEFGHIJKLMNOPQRSTUV",
    key: { id: "k1", prefix: "jba_ABCDEFGH", name: "CLI" },
    seat_id: "s1",
    user: { id: "u1", email: "a@example.com" },
    company: { id: "c1", slug: "acme", name: "Acme" },
    replaced: false,
  };
}
