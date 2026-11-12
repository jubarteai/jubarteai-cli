import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { CliError } from "../errors.js";
import { whoami } from "./whoami.js";

const KEY = "jba_FAKEKEYFAKEKEYFAKEKEY01";

async function serveStatus(status: number): Promise<{ origin: string; stop: () => Promise<void> }> {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_api_key", message: "SERVER-TEXT" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
let fake: FakeAuthServer;

beforeEach(async () => {
  fake = await startFakeAuthServer();
});
afterEach(async () => {
  await fake.close();
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

describe("whoami", () => {
  it("sends the key as a bearer token and returns the seat, user, workspace and key record", async () => {
    fake.addKey(KEY, "dashboard");
    const who = await whoami(fake.origin, KEY);
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/cli/whoami", authorization: `Bearer ${KEY}` });
    expect(who).toMatchObject({
      seat_id: fake.identity.seat_id,
      user: { email: "ada@example.com" },
      company: { slug: "acme" },
      key: { minted_by: "dashboard", name: "Laptop key" },
    });
  });

  it("maps 401 to exit 3 without echoing the key", async () => {
    const error = await thrown(whoami(fake.origin, KEY));
    expect(error.exitCode).toBe(3);
    expect(error.message).not.toContain(KEY);
  });

  it("maps billing, seat and server failures", async () => {
    const cases: Array<[number, number, string]> = [
      [401, 3, "invalid_api_key"],
      [402, 3, "billing_inactive"],
      [403, 3, "seat_canceled"],
      [500, 4, "server_error"],
      [503, 4, "server_error"],
      [418, 1, "unexpected_response"],
    ];
    for (const [status, exitCode, code] of cases) {
      const { origin, stop } = await serveStatus(status);
      const error = await thrown(whoami(origin, KEY));
      await stop();
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: exitCode, code });
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("SERVER-TEXT");
    }
  });

  it("treats a malformed 200 as an unexpected response (exit 1)", async () => {
    const http = await import("node:http");
    const odd = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ seat_id: "s", user: {}, company: {}, key: {} }));
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    const { port } = odd.address() as import("node:net").AddressInfo;
    const error = await thrown(whoami(`http://127.0.0.1:${port}`, KEY));
    odd.close();
    odd.closeAllConnections();
    expect(error.exitCode).toBe(1);
  });

  it("accepts a null email (the caller decides what that means)", async () => {
    const http = await import("node:http");
    const nullMail = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          seat_id: "s1",
          user: { id: "u1", email: null },
          company: { id: "c1", slug: "acme", name: "Acme" },
          key: { id: "k1", prefix: "jba_ABCDEFGH", name: "n", minted_by: "cli" },
        }),
      );
    });
    await new Promise<void>((resolve) => nullMail.listen(0, "127.0.0.1", resolve));
    const { port } = nullMail.address() as import("node:net").AddressInfo;
    const who = await whoami(`http://127.0.0.1:${port}`, KEY);
    nullMail.close();
    nullMail.closeAllConnections();
    expect(who.user.email).toBeNull();
  });

  it("honours a short timeout", async () => {
    const http = await import("node:http");
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as import("node:net").AddressInfo;
    const error = await thrown(whoami(`http://127.0.0.1:${port}`, KEY, { timeoutMs: 100 }));
    silent.close();
    silent.closeAllConnections();
    expect(error.exitCode).toBe(4);
  });
});
