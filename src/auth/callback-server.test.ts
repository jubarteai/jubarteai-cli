import { request } from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startCallbackServer } from "./callback-server.js";

const STATE = "AAAAAAAAAAAAAAAAAAAAAA";
const CODE = `jbc_${"a".repeat(43)}`;

const open: Array<{ close(): void }> = [];

async function start(timeoutMs = 60_000) {
  const server = await startCallbackServer({ state: STATE, timeoutMs });
  open.push(server);
  return server;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of open.splice(0)) server.close();
});

const url = (port: number, query: string, path = "/callback"): string => `http://127.0.0.1:${port}${path}${query}`;

/** A raw request, so the Host header can be chosen. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("startCallbackServer: binding", () => {
  it("listens on 127.0.0.1 with an ephemeral port, never another interface", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const server = await start();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.slice(0, 2)).toEqual([0, "127.0.0.1"]);
    expect(server.port).toBeGreaterThan(1023);
    const external = Object.values(networkInterfaces())
      .flat()
      .find((info) => info !== undefined && info.family === "IPv4" && !info.internal);
    if (external !== undefined) {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: external.address, port: server.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      expect(reachable).toBe(false);
    }
  });
});

describe("startCallbackServer: answers", () => {
  it("accepts the right state and a well-formed code, replies a static page, then closes", async () => {
    const server = await start();
    const res = await fetch(url(server.port, `?code=${CODE}&state=${STATE}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You can close this tab.");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(server.result).resolves.toEqual({ code: CODE });
    await vi.waitFor(async () => expect(await isListening(server.port)).toBe(false));
  });

  it("serves a page with no external resources and nothing from the query", async () => {
    const server = await start();
    const res = await fetch(url(server.port, `?code=${CODE}&state=${STATE}`));
    const body = await res.text();
    expect(body).not.toMatch(/<script|<link|<img|<iframe|src=|href=|https?:\/\//i);
    expect(body).not.toContain(CODE);
  });

  it("answers 400 to a wrong state and keeps listening for the right one", async () => {
    const server = await start();
    const wrong = await fetch(url(server.port, `?code=${CODE}&state=${"B".repeat(22)}`));
    expect(wrong.status).toBe(400);
    expect(await isListening(server.port)).toBe(true);
    const right = await fetch(url(server.port, `?code=${CODE}&state=${STATE}`));
    expect(right.status).toBe(200);
    await expect(server.result).resolves.toEqual({ code: CODE });
  });

  it("answers 400 to a missing, empty, or repeated state", async () => {
    const server = await start();
    for (const query of [`?code=${CODE}`, `?code=${CODE}&state=`, `?code=${CODE}&state=${STATE}&state=${STATE}`, `?code=${CODE}&state=${STATE}x`]) {
      expect((await fetch(url(server.port, query))).status).toBe(400);
    }
    expect(await isListening(server.port)).toBe(true);
  });

  it("keeps listening when the state is right but the code is malformed or missing", async () => {
    const server = await start();
    for (const query of [`?state=${STATE}`, `?code=nope&state=${STATE}`, `?code=${CODE}x&state=${STATE}`, `?code=${CODE}&code=${CODE}&state=${STATE}`]) {
      expect((await fetch(url(server.port, query))).status).toBe(400);
    }
    expect(await isListening(server.port)).toBe(true);
  });

  it("reports access_denied only with the right state", async () => {
    const server = await start();
    const forged = await fetch(url(server.port, `?error=access_denied&state=${"C".repeat(22)}`));
    expect(forged.status).toBe(400);
    const real = await fetch(url(server.port, `?error=access_denied&state=${STATE}`));
    expect(real.status).toBe(200);
    await expect(server.result).resolves.toEqual({ error: "access_denied" });
  });

  it("ignores any other error value", async () => {
    const server = await start();
    expect((await fetch(url(server.port, `?error=server_error&state=${STATE}`))).status).toBe(400);
    expect(await isListening(server.port)).toBe(true);
  });

  it("answers 404 for any other path and 405 for a non-GET method", async () => {
    const server = await start();
    for (const path of ["/", "/callback/", "/Callback", "/x/callback", "/favicon.ico"]) {
      expect((await fetch(url(server.port, `?code=${CODE}&state=${STATE}`, path))).status).toBe(404);
    }
    const post = await fetch(url(server.port, `?code=${CODE}&state=${STATE}`), { method: "POST" });
    expect(post.status).toBe(405);
    expect(await isListening(server.port)).toBe(true);
  });

  it("refuses a request that names another Host (DNS rebinding)", async () => {
    const server = await start();
    const query = `/callback?code=${CODE}&state=${STATE}`;
    expect(await rawGet(server.port, query, { Host: "evil.example" })).toBe(400);
    expect(await rawGet(server.port, query, { Host: `localhost:${server.port}` })).toBe(400);
    expect(await isListening(server.port)).toBe(true);
    expect(await rawGet(server.port, query, { Host: `127.0.0.1:${server.port}` })).toBe(200);
  });
});

describe("startCallbackServer: lifetime", () => {
  it("resolves with a timeout and closes when the time is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await start(5 * 60 * 1000);
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(await isListening(server.port)).toBe(true);
    vi.advanceTimersByTime(1);
    await expect(server.result).resolves.toEqual({ error: "timeout" });
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await isListening(server.port)).toBe(false));
  });

  it("close() is idempotent and stops the listener", async () => {
    const server = await start();
    server.close();
    server.close();
    await vi.waitFor(async () => expect(await isListening(server.port)).toBe(false));
  });

  it("rejects when the listener cannot start", async () => {
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server) {
      queueMicrotask(() => this.emit("error", new Error("EACCES")));
      return this;
    });
    await expect(startCallbackServer({ state: STATE, timeoutMs: 1000 })).rejects.toThrow();
  });
});
