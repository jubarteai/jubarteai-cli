import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { extendUrlFor, extendWatch } from "./extend.js";

const TOKEN = "jbw_" + "a".repeat(32);

type Seen = { method: string | undefined; url: string | undefined; authorization: string | undefined; body: string };

async function startServer(
  respond: (res: http.ServerResponse, seen: Seen) => void,
): Promise<{ url: URL; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, authorization: req.headers.authorization, body };
      seen.push(entry);
      respond(res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/api/mcp/inbox-watch`),
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(respond: (res: http.ServerResponse, seen: Seen) => void) {
  const server = await startServer(respond);
  servers.push(server);
  return server;
}

function reply(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

describe("extendUrlFor", () => {
  it("appends /extend to the watch path and keeps the origin", () => {
    expect(extendUrlFor(new URL("https://jubarte.ai/api/mcp/inbox-watch")).href).toBe("https://jubarte.ai/api/mcp/inbox-watch/extend");
    expect(extendUrlFor(new URL("https://jubarte.ai/api/mcp/inbox-watch/")).href).toBe("https://jubarte.ai/api/mcp/inbox-watch/extend");
  });
});

describe("extendWatch", () => {
  it("POSTs { minutes } with the bearer token to <watch url>/extend and maps 200 + expires_at to extended", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const server = await serve((res) => reply(res, 200, JSON.stringify({ expires_at: expiresAt })));
    const result = await extendWatch(server.url, TOKEN, 5, new AbortController().signal);
    expect(result).toEqual({ kind: "extended", expiresAtMs: Date.parse(expiresAt) });
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: "POST", url: "/api/mcp/inbox-watch/extend", authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(server.seen[0]!.body)).toEqual({ minutes: 5 });
  });

  it.each([
    ["an empty body", ""],
    ["an html page", "<html>Not Found</html>"],
    ["JSON", JSON.stringify({ error: "not_found" })],
  ])("maps a 404 with %s to unsupported (an older server)", async (_label, body) => {
    const server = await serve((res) => reply(res, 404, body));
    expect(await extendWatch(server.url, TOKEN, 5, new AbortController().signal)).toEqual({ kind: "unsupported" });
  });

  it("maps the exact 401 and 410 refusals to stopped", async () => {
    const unauthorized = await serve((res) => reply(res, 401, JSON.stringify({ error: "invalid_or_expired_watch" })));
    expect(await extendWatch(unauthorized.url, TOKEN, 5, new AbortController().signal)).toEqual({
      kind: "stopped",
      reason: "invalid_or_expired_watch",
    });
    const gone = await serve((res) => reply(res, 410, JSON.stringify({ error: "agent_disconnected" })));
    expect(await extendWatch(gone.url, TOKEN, 5, new AbortController().signal)).toEqual({ kind: "stopped", reason: "agent_disconnected" });
  });

  it.each([
    ["a 401 with another body", 401, JSON.stringify({ error: "nope" })],
    ["a 410 with an html body", 410, "<html>gone</html>"],
    ["a 500", 500, JSON.stringify({ error: "inbox_watch_failed" })],
    ["a 502 platform page", 502, "<html>Bad gateway</html>"],
    ["a 400", 400, JSON.stringify({ error: "invalid_request" })],
    ["a 200 without expires_at", 200, JSON.stringify({ ok: true })],
    ["a 200 with an unparsable expires_at", 200, JSON.stringify({ expires_at: "soon" })],
    ["a 200 with a numeric expires_at", 200, JSON.stringify({ expires_at: 12345 })],
    ["a 200 that is not JSON", 200, "OK"],
  ])("maps %s to server (retry, never a wake-up)", async (_label, status, body) => {
    const server = await serve((res) => reply(res, status, body));
    expect(await extendWatch(server.url, TOKEN, 5, new AbortController().signal)).toEqual({ kind: "server" });
  });

  it("maps a request that never completes to network after the timeout", async () => {
    const server = await serve(() => undefined);
    const started = Date.now();
    expect(await extendWatch(server.url, TOKEN, 5, new AbortController().signal, 150)).toEqual({ kind: "network" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("maps a refused connection and an aborted signal to network", async () => {
    const server = await serve((res) => reply(res, 200, "{}"));
    const url = server.url;
    await server.close();
    servers.length = 0;
    expect(await extendWatch(url, TOKEN, 5, new AbortController().signal)).toEqual({ kind: "network" });

    const live = await serve(() => undefined);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    expect(await extendWatch(live.url, TOKEN, 5, stop.signal)).toEqual({ kind: "network" });
  });

  it("does not follow a redirect (the token must not leave the seat's origin)", async () => {
    const target = await serve((res) => reply(res, 200, JSON.stringify({ expires_at: new Date().toISOString() })));
    const redirector = await serve((res) => {
      res.writeHead(307, { Location: `${target.url.origin}/steal` });
      res.end();
    });
    expect(await extendWatch(redirector.url, TOKEN, 5, new AbortController().signal)).toEqual({ kind: "network" });
    expect(target.seen).toHaveLength(0);
  });

  it("never puts the token in what it returns", async () => {
    for (const status of [200, 401, 404, 410, 500]) {
      const server = await serve((res) => reply(res, status, JSON.stringify({ echoed: TOKEN, expires_at: new Date().toISOString() })));
      const result = await extendWatch(server.url, TOKEN, 5, new AbortController().signal);
      expect(JSON.stringify(result)).not.toContain("jbw_");
    }
  });
});
