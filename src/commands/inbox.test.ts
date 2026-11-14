import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import type http from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import { writeSession } from "../session/cache.js";
import {
  AGENT_A,
  createSandbox,
  expectNoSecrets,
  FAKE_WATCH_TOKEN,
  jsonLines,
  makeCtx,
  runCli,
  SEAT_ID,
  sendJson,
  startFakeServer,
  waitFor,
} from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer, RecordedRequest, Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { acquireWatchLock, DEFAULT_LOCK_DEPS } from "../inbox/lock.js";
import { DEFAULT_WATCH_DEPS, inboxCommand, runInbox } from "./inbox.js";
import type { WatchDeps } from "./inbox.js";

let sandbox: Sandbox;
const servers: FakeServer[] = [];
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  sandbox.cleanup();
});

const FAST: WatchDeps = {
  ...DEFAULT_WATCH_DEPS,
  // Never the ambient environment: a runner that sets JUBARTEAI_UNATTENDED, a
  // CLAUDE_CODE_ENTRYPOINT other than `cli` or a CLAUDE_PID would otherwise
  // trip the --session unattended guard or pick the parent to watch.
  env: {},
  retryAfterServerMs: 5,
  retryAfterNetworkMs: 5,
  minPollMs: 1,
  jitter: 0,
};

type WatchHandler = (req: { headers: http.IncomingHttpHeaders }, res: http.ServerResponse, index: number) => void;
type Setup = { server: FakeServer; checkInboxArgs: () => Record<string, unknown>[] };

/** A server whose check_inbox hands out a watch pointing at its own inbox-watch endpoint. */
async function startWatchServer(
  watch: WatchHandler,
  opts: { expiresInMs?: number; messages?: unknown[]; watchField?: (origin: string) => unknown; extend?: (req: RecordedRequest, res: http.ServerResponse, index: number) => void } = {},
): Promise<Setup> {
  let origin = "";
  const server = await startFakeServer({
    tool: () => ({
      messages: opts.messages ?? [],
      result: {
        count: (opts.messages ?? []).length,
        watch:
          opts.watchField === undefined
            ? {
                command: `(curl -s -H 'Authorization: Bearer ${FAKE_WATCH_TOKEN}' ${origin}/api/mcp/inbox-watch)`,
                expires_at: new Date(Date.now() + (opts.expiresInMs ?? 60_000)).toISOString(),
                url: `${origin}/api/mcp/inbox-watch`,
                token: FAKE_WATCH_TOKEN,
              }
            : opts.watchField(origin),
      },
    }),
    watch,
    ...(opts.extend === undefined ? {} : { extend: opts.extend }),
  });
  origin = server.origin;
  servers.push(server);
  sandbox.signIn(server.origin);
  return { server, checkInboxArgs: () => server.toolCalls().map((c) => c.arguments) };
}

async function runWatch(argv: string[], deps: WatchDeps = FAST): Promise<{ code: number; out: string; err: string }> {
  const { ctx, out, err } = makeCtx(sandbox.repo, { agent: AGENT_A });
  const code = await runInbox(ctx, parseArgs(argv, inboxCommand.flags), deps);
  return { code, out: out(), err: err() };
}

const pending = (n: number): WatchHandler => (_req, res) => sendJson(res, 200, { pending: n });

describe("inbox (plain)", () => {
  it("is check_inbox with the agent and, when asked, wait_seconds", async () => {
    const server = await startFakeServer({ tool: () => ({ messages: [{ id: "m" }], result: { count: 1 } }) });
    servers.push(server);
    sandbox.signIn(server.origin);
    const result = await runCli([inboxCommand], ["inbox", "--agent", AGENT_A], sandbox.repo);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ messages: [{ id: "m" }], result: { count: 1 } });
    await runCli([inboxCommand], ["inbox", "--wait", "3", "--agent", AGENT_A], sandbox.repo);
    await runCli([inboxCommand], ["inbox", "--wait", "99", "--agent", AGENT_A], sandbox.repo);
    expect(server.toolCalls().map((c) => c.arguments)).toEqual([
      { agent_id: AGENT_A },
      { agent_id: AGENT_A, wait_seconds: 3 },
      { agent_id: AGENT_A, wait_seconds: 40 },
    ]);
  });

  it("uses the session's agent, and exits 2 without one", async () => {
    const server = await startFakeServer();
    servers.push(server);
    sandbox.signIn(server.origin);
    expect((await runCli([inboxCommand], ["inbox"], sandbox.repo)).code).toBe(2);
    process.env["CLAUDE_CODE_SESSION_ID"] = "s";
    writeSession("claude-code", "s", { harness: "claude-code", agent_id: AGENT_A, seat_id: SEAT_ID, origin: server.origin }, { overwrite: true });
    expect((await runCli([inboxCommand], ["inbox"], sandbox.repo)).code).toBe(0);
    expect(server.toolCalls()[0]?.arguments).toEqual({ agent_id: AGENT_A });
  });

  it("rejects options that don't combine or are out of range, sending nothing", async () => {
    const server = await startFakeServer();
    servers.push(server);
    sandbox.signIn(server.origin);
    const bad = [
      ["inbox", "--watch", "--wait", "5"],
      ["inbox", "--minutes", "5"],
      ["inbox", "--watch", "--minutes", "0"],
      ["inbox", "--watch", "--minutes", "121"],
      ["inbox", "--watch", "--minutes", "1.5"],
      ["inbox", "--wait", "-1"],
      ["inbox", "--wait", "2.5"],
      ["inbox", "extra"],
    ];
    for (const argv of bad) expect((await runCli([inboxCommand], [...argv, "--agent", AGENT_A], sandbox.repo)).code, argv.join(" ")).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe("inbox --watch", () => {
  it("asks check_inbox for a watch (30 minutes by default, --minutes otherwise)", async () => {
    const { checkInboxArgs } = await startWatchServer(pending(1));
    await runWatch(["--watch"]);
    await runWatch(["--watch", "--minutes", "7"]);
    expect(checkInboxArgs()).toEqual([
      { agent_id: AGENT_A, watch_minutes: 30 },
      { agent_id: AGENT_A, watch_minutes: 7 },
    ]);
  });

  it("exits 0 printing an empty envelope, then {pending:n}, and sends the token only as a bearer", async () => {
    const { server } = await startWatchServer(pending(2));
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(0);
    const lines = jsonLines(result.out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ messages: [], result: { count: 0, watch: { expires_at: expect.any(String) } } });
    expect(Object.keys(lines[0] as object)).toEqual(["messages", "result"]);
    expect(lines[1]).toEqual({ pending: 2 });
    const get = server.requests.find((r) => r.method === "GET");
    expect(get?.url).toBe("/api/mcp/inbox-watch");
    expect(get?.headers["authorization"]).toBe(`Bearer ${FAKE_WATCH_TOKEN}`);
    expectNoSecrets(result.out + result.err);
    expect(Object.keys((lines[0] as { result: { watch: object } }).result.watch)).toEqual(["expires_at"]);
  });

  it("messages already drained by the first call end the watch at once: line 1, {pending:n}, exit 0, no GET", async () => {
    const messages = [
      { id: "m1", content: "<untrusted_content>direct</untrusted_content>" },
      { id: "m2", content: "<untrusted_content>normal broadcast</untrusted_content>", is_broadcast: true, priority: "normal" },
    ];
    const { server } = await startWatchServer(() => undefined, { messages }); // a watch endpoint that never answers
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(0);
    const lines = jsonLines(result.out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ messages, result: { count: 2 } });
    expect(lines[1]).toEqual({ pending: 2 });
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    expectNoSecrets(result.out + result.err);
  });

  it("keeps polling while nothing is pending, then wakes", async () => {
    const { server } = await startWatchServer((_req, res, i) => sendJson(res, 200, { pending: i < 2 ? 0 : 1 }));
    const result = await runWatch(["--watch"]);
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(3);
  });

  it("stops with invalid_or_expired_watch on 401 and agent_disconnected on 410, exit 0", async () => {
    await startWatchServer((_req, res) => sendJson(res, 401, { error: "invalid_or_expired_watch" }));
    const first = await runWatch(["--watch"]);
    expect(first.code).toBe(0);
    expect(jsonLines(first.out)[1]).toEqual({ stopped: "invalid_or_expired_watch" });

    await startWatchServer((_req, res) => sendJson(res, 410, { error: "agent_disconnected" }));
    const second = await runWatch(["--watch"]);
    expect(second.code).toBe(0);
    expect(jsonLines(second.out)[1]).toEqual({ stopped: "agent_disconnected" });
  });

  it.each<[string, WatchHandler]>([
    ["a 500", (_req, res, i) => (i === 0 ? sendJson(res, 500, { error: "inbox_watch_failed" }) : sendJson(res, 200, { pending: 1 }))],
    ["a 502 platform page", (_req, res, i) => (i === 0 ? (res.writeHead(502, { "Content-Type": "text/html" }), res.end("<html>bad gateway</html>")) : sendJson(res, 200, { pending: 1 }))],
    ["an empty body", (_req, res, i) => (i === 0 ? (res.writeHead(200), res.end("")) : sendJson(res, 200, { pending: 1 }))],
    ["a non-JSON 200", (_req, res, i) => (i === 0 ? (res.writeHead(200), res.end("ok")) : sendJson(res, 200, { pending: 1 }))],
    ["a 401 that isn't the server's own refusal", (_req, res, i) => (i === 0 ? sendJson(res, 401, { error: "firewall" }) : sendJson(res, 200, { pending: 1 }))],
    ["a dropped connection", (_req, res, i) => (i === 0 ? res.socket?.destroy() : sendJson(res, 200, { pending: 1 }))],
  ])("retries after %s instead of waking or stopping", async (_name, handler) => {
    const { server } = await startWatchServer(handler);
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("waits the server-error delay (10 s) and the network-error delay (5 s) by default", () => {
    expect(DEFAULT_WATCH_DEPS.retryAfterServerMs).toBe(10_000);
    expect(DEFAULT_WATCH_DEPS.retryAfterNetworkMs).toBe(5_000);
  });

  it("uses the injected delays: the retry after a 5xx waits retryAfterServerMs, after a network error retryAfterNetworkMs", async () => {
    const slept: number[] = [];
    const deps: WatchDeps = { ...FAST, retryAfterServerMs: 1234, retryAfterNetworkMs: 567, minPollMs: 0, sleep: async (ms) => void slept.push(ms) };
    await startWatchServer((_req, res, i) => {
      if (i === 0) sendJson(res, 503, {});
      else if (i === 1) res.socket?.destroy();
      else sendJson(res, 200, { pending: 1 });
    });
    const result = await runWatch(["--watch"], deps);
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
    expect(slept).toEqual([1234, 567]);
  });

  it("ends with {stopped:'expired'} at the watch's expires_at", async () => {
    const { server } = await startWatchServer(pending(0), { expiresInMs: 120 });
    const result = await runWatch(["--watch"], { ...FAST, minPollMs: 20 });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ stopped: "expired" });
    expect(server.requests.filter((r) => r.method === "GET").length).toBeGreaterThan(0);
  });

  it("ends at the expiry even while a poll is hanging", async () => {
    await startWatchServer(() => undefined, { expiresInMs: 150 }); // never answers
    const result = await runWatch(["--watch"]);
    expect(jsonLines(result.out)[1]).toEqual({ stopped: "expired" });
  });

  it("stops cleanly on SIGINT: {stopped:'interrupted'}, exit 130, handlers removed", async () => {
    const { server } = await startWatchServer(() => undefined);
    const signals = new EventEmitter();
    const deps = { ...FAST, signals: signals as unknown as WatchDeps["signals"] };
    const running = runWatch(["--watch"], deps);
    await waitFor(() => server.requests.some((r) => r.method === "GET"));
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGINT");
    const result = await running;
    expect(result.code).toBe(130);
    expect(jsonLines(result.out).at(-1)).toEqual({ stopped: "interrupted" });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expectNoSecrets(result.out + result.err);
  });

  it("stops cleanly on a real SIGTERM event with the default wiring: exit 143", async () => {
    const { server } = await startWatchServer(() => undefined);
    // The credential write in signIn() holds SIGTERM until the next turn; let that pass first.
    await waitFor(() => process.listenerCount("SIGTERM") === 0);
    const before = process.listenerCount("SIGTERM");
    const running = runWatch(["--watch"], { ...DEFAULT_WATCH_DEPS, jitter: 0 });
    await waitFor(() => server.requests.some((r) => r.method === "GET"));
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    const result = await running;
    expect(result.code).toBe(143);
    expect(jsonLines(result.out).at(-1)).toEqual({ stopped: "interrupted" });
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("stops cleanly on a signal that arrives during the initial check_inbox", async () => {
    const server = await startFakeServer({ mcp: () => true }); // never answers
    servers.push(server);
    sandbox.signIn(server.origin);
    const signals = new EventEmitter();
    const running = runWatch(["--watch"], { ...FAST, signals: signals as unknown as WatchDeps["signals"] });
    await waitFor(() => server.requests.length > 0);
    signals.emit("SIGINT");
    const result = await running;
    expect(result.code).toBe(130);
    expect(jsonLines(result.out)).toEqual([{ stopped: "interrupted" }]);
  });

  it("older server (no url or token): the messages are kept, exit 1, code watch_unavailable", async () => {
    const message = { id: "m1" };
    const { server } = await startWatchServer(pending(1), {
      messages: [message],
      watchField: () => ({ command: `(curl -H 'Authorization: Bearer ${FAKE_WATCH_TOKEN}' x)`, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(1);
    expect(jsonLines(result.out)).toEqual([{ messages: [message], error: "inbox watch unavailable on this server", code: "watch_unavailable" }]);
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    expectNoSecrets(result.out + result.err);
  });

  it("no watch at all (watch_error): the same unavailable line", async () => {
    const server = await startFakeServer({ tool: () => ({ messages: [], result: { count: 0, watch_error: "inbox watch unavailable: x" } }) });
    servers.push(server);
    sandbox.signIn(server.origin);
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(1);
    expect(jsonLines(result.out)).toEqual([{ messages: [], error: "inbox watch unavailable on this server", code: "watch_unavailable" }]);
  });

  it.each<[string, (origin: string, other: string) => string]>([
    ["another host", (_origin, other) => `${other}/api/mcp/inbox-watch`],
    ["another scheme", (origin) => origin.replace("http:", "https:") + "/api/mcp/inbox-watch"],
    ["another path", (origin) => `${origin}/api/mcp`],
    ["a path with a suffix", (origin) => `${origin}/api/mcp/inbox-watch/x`],
    ["a query", (origin) => `${origin}/api/mcp/inbox-watch?next=1`],
    ["credentials", (origin) => origin.replace("http://", "http://user:pw@") + "/api/mcp/inbox-watch"],
    ["not a URL", () => "not a url"],
  ])("refuses a watch URL with %s and never sends the token there", async (_name, makeUrl) => {
    const other = await startFakeServer({ watch: pending(1) });
    servers.push(other);
    const message = { id: "m1" };
    const { server } = await startWatchServer(pending(1), {
      messages: [message],
      watchField: (origin) => ({ command: "c", expires_at: new Date(Date.now() + 60_000).toISOString(), url: makeUrl(origin, other.origin), token: FAKE_WATCH_TOKEN }),
    });
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(1);
    expect(jsonLines(result.out)).toEqual([{ messages: [message], error: expect.any(String), code: "watch_invalid" }]);
    expect(other.requests).toHaveLength(0);
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    expectNoSecrets(result.out + result.err);
  });

  it("refuses a malformed token or expiry", async () => {
    for (const bad of [{ token: "jba_NOTAWATCHTOKENATALL" }, { token: 5 }, { expires_at: "soon" }, { expires_at: 5 }]) {
      const { server } = await startWatchServer(pending(1), {
        watchField: (origin) => ({ command: "c", expires_at: new Date(Date.now() + 60_000).toISOString(), url: `${origin}/api/mcp/inbox-watch`, token: FAKE_WATCH_TOKEN, ...bad }),
      });
      const result = await runWatch(["--watch"]);
      expect(result.code, JSON.stringify(bad)).toBe(1);
      expect(jsonLines(result.out)).toMatchObject([{ code: "watch_invalid" }]);
      expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    }
  });

  it("passes a check_inbox auth failure through (exit 3) and polls nothing", async () => {
    const server = await startFakeServer({
      mcp: (_req, res) => {
        sendJson(res, 401, { error: "invalid_api_key" });
        return true;
      },
    });
    servers.push(server);
    sandbox.signIn(server.origin);
    const result = await runWatch(["--watch"]);
    expect(result.code).toBe(3);
    expect(jsonLines(result.out)).toEqual([{ messages: [], error: expect.any(String), code: "invalid_api_key" }]);
  });

  it("never prints the watch token on any path, even where a peer's message quotes it", async () => {
    const outputs: string[] = [];
    for (const handler of [pending(1), ((_req, res) => sendJson(res, 410, { error: "agent_disconnected" })) as WatchHandler]) {
      await startWatchServer(handler, { messages: [{ id: "m", content: `echo ${FAKE_WATCH_TOKEN}` }] });
      const result = await runWatch(["--watch"]);
      expect(result.out).toContain("echo [redacted]");
      outputs.push(result.out, result.err);
    }
    expectNoSecrets(outputs.join(""));
  });
});

describe("inbox --watch --session", () => {
  const futureIso = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it("needs --watch, and sends nothing without it", async () => {
    const server = await startFakeServer();
    servers.push(server);
    sandbox.signIn(server.origin);
    expect((await runCli([inboxCommand], ["inbox", "--session", "--agent", AGENT_A], sandbox.repo)).code).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["the SDK entrypoint", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
    ["an unattended run", { CLAUDE_CODE_SESSION_ATTENDED: "0" }],
    ["the explicit opt-out on an interactive-looking session", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", JUBARTEAI_UNATTENDED: "1" }],
  ])("refuses %s with {stopped:unattended}, exit 0 and not one request", async (_label, env) => {
    const { server } = await startWatchServer(pending(1));
    const result = await runWatch(["--watch", "--session"], { ...FAST, env: env as NodeJS.ProcessEnv });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)).toEqual([{ stopped: "unattended" }]);
    expect(server.requests).toHaveLength(0);
  });

  it("does not apply the unattended guard to a plain --watch", async () => {
    await startWatchServer(pending(1));
    const result = await runWatch(["--watch"], { ...FAST, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
  });

  it.each([["--watch"], ["--watch --session"]])("%s: a second watcher for the same agent answers {stopped:already_watching} before check_inbox", async (flags) => {
    const { server, checkInboxArgs } = await startWatchServer(pending(1));
    const holder = await acquireWatchLock(AGENT_A, "session", DEFAULT_LOCK_DEPS);
    expect(holder.kind).toBe("acquired");
    try {
      const result = await runWatch(flags.split(" "));
      expect(result.code).toBe(0);
      expect(jsonLines(result.out)).toEqual([{ stopped: "already_watching" }]);
      expect(checkInboxArgs()).toEqual([]);
      expect(server.requests).toHaveLength(0);
    } finally {
      if (holder.kind === "acquired") holder.lock.release();
    }
    // Once the holder is gone the same agent can watch again.
    const next = await runWatch(["--watch"]);
    expect(jsonLines(next.out)[1]).toEqual({ pending: 1 });
  });

  it("a different agent isn't blocked by the first one's lock", async () => {
    await startWatchServer(pending(1));
    const holder = await acquireWatchLock(AGENT_A, "watch", DEFAULT_LOCK_DEPS);
    try {
      const { ctx, out } = makeCtx(sandbox.repo, { agent: "bbbbbbbb-0000-4000-8000-00000000000b" });
      const code = await runInbox(ctx, parseArgs(["--watch"], inboxCommand.flags), FAST);
      expect(code).toBe(0);
      expect(jsonLines(out())[1]).toEqual({ pending: 1 });
    } finally {
      if (holder.kind === "acquired") holder.lock.release();
    }
  });

  it("releases the lock on every way out", async () => {
    const handlers: Array<[string, WatchHandler]> = [
      ["a wake-up", pending(1)],
      ["a 410", (_req, res) => sendJson(res, 410, { error: "agent_disconnected" })],
      ["a 401", (_req, res) => sendJson(res, 401, { error: "invalid_or_expired_watch" })],
    ];
    for (const [label, handler] of handlers) {
      await startWatchServer(handler);
      await runWatch(["--watch", "--session"]);
      const probe = await acquireWatchLock(AGENT_A, "watch", DEFAULT_LOCK_DEPS);
      expect(probe.kind, label).toBe("acquired");
      if (probe.kind === "acquired") probe.lock.release();
    }
    // An older server's refusal (no url/token) also leaves nothing behind.
    await startWatchServer(pending(1), { watchField: () => ({ command: "c", expires_at: futureIso(60_000) }) });
    await runWatch(["--watch", "--session"]);
    const probe = await acquireWatchLock(AGENT_A, "watch", DEFAULT_LOCK_DEPS);
    expect(probe.kind).toBe("acquired");
    if (probe.kind === "acquired") probe.lock.release();
  });

  it("renews through the extend endpoint, keeps watching past the original expiry and wakes on a message", async () => {
    const extendBodies: unknown[] = [];
    const extendAuth: Array<string | undefined> = [];
    const { server } = await startWatchServer(
      (_req, res, i) => sendJson(res, 200, { pending: i >= 6 ? 1 : 0 }),
      {
        expiresInMs: 150,
        extend: (req, res) => {
          extendBodies.push(req.body);
          extendAuth.push(req.headers["authorization"]);
          sendJson(res, 200, { expires_at: futureIso(150) });
        },
      },
    );
    const started = Date.now();
    const result = await runWatch(["--watch", "--session"], { ...FAST, minPollMs: 60 });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(extendBodies.length).toBeGreaterThanOrEqual(1);
    expect(extendBodies.every((b) => JSON.stringify(b) === JSON.stringify({ minutes: 30 }))).toBe(true);
    expect(extendAuth.every((a) => a === `Bearer ${FAKE_WATCH_TOKEN}`)).toBe(true);
    expect(server.requests.some((r) => r.method === "POST" && r.url === "/api/mcp/inbox-watch/extend")).toBe(true);
    // One check_inbox for the whole session: renewing never goes through the MCP route again.
    expect(server.toolCalls()).toHaveLength(1);
    expectNoSecrets(result.out + result.err);
  });

  it("with a server that has no extend endpoint (404) it ends {stopped:expired} at the original expiry", async () => {
    const { server } = await startWatchServer(pending(0), { expiresInMs: 200 });
    const result = await runWatch(["--watch", "--session"], { ...FAST, minPollMs: 30 });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ stopped: "expired" });
    expect(server.requests.filter((r) => r.url === "/api/mcp/inbox-watch/extend")).toHaveLength(1);
  });

  it.each([
    [401, { error: "invalid_or_expired_watch" }, "invalid_or_expired_watch"],
    [410, { error: "agent_disconnected" }, "agent_disconnected"],
  ])("a %s from the renewal stops the watch with %s", async (status, body, reason) => {
    await startWatchServer(pending(0), { expiresInMs: 150, extend: (_req, res) => sendJson(res, status, body) });
    const result = await runWatch(["--watch", "--session"], { ...FAST, minPollMs: 30 });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ stopped: reason });
  });

  it("a network error on the renewal is retried and the watch still ends expired if it never succeeds", async () => {
    const { server } = await startWatchServer(pending(0), { expiresInMs: 250, extend: (_req, res) => void res.socket?.destroy() });
    const result = await runWatch(["--watch", "--session"], { ...FAST, minPollMs: 30 });
    expect(jsonLines(result.out)[1]).toEqual({ stopped: "expired" });
    expect(server.requests.filter((r) => r.url === "/api/mcp/inbox-watch/extend").length).toBeGreaterThan(1);
  });

  it("stops {stopped:parent_gone}, exit 0, when the session that started it is gone", async () => {
    let tick: (() => void) | null = null;
    let gone = false;
    const { server } = await startWatchServer(() => undefined); // a poll that never answers
    const deps: WatchDeps = {
      ...FAST,
      parent: {
        isAlive: () => !gone,
        ppid: () => 100,
        setInterval: (fn) => {
          tick = fn;
          return {};
        },
        clearInterval: () => undefined,
        checkEveryMs: 15_000,
      },
      env: { CLAUDE_PID: "4242" },
    };
    const running = runWatch(["--watch", "--session"], deps);
    await waitFor(() => server.requests.some((r) => r.method === "GET"));
    gone = true;
    (tick as unknown as () => void)();
    const result = await running;
    expect(result.code).toBe(0);
    expect(jsonLines(result.out).at(-1)).toEqual({ stopped: "parent_gone" });
    // The lock is released: the next watcher gets in.
    const probe = await acquireWatchLock(AGENT_A, "watch", DEFAULT_LOCK_DEPS);
    expect(probe.kind).toBe("acquired");
    if (probe.kind === "acquired") probe.lock.release();
  });

  /** Parent-watch deps whose session is already gone: a parent watch, once started, aborts on its first check. */
  const goneParent = (): WatchDeps["parent"] => ({
    isAlive: () => false,
    ppid: () => 100,
    setInterval: (fn) => {
      queueMicrotask(fn);
      return {};
    },
    clearInterval: () => undefined,
    checkEveryMs: 15_000,
  });

  it("only a --session watch watches its parent: a plain --watch carries on when CLAUDE_PID is gone", async () => {
    const deps: WatchDeps = { ...FAST, env: { CLAUDE_PID: "4242" }, parent: goneParent() };
    await startWatchServer((_req, res, i) => sendJson(res, 200, { pending: i >= 2 ? 1 : 0 }));
    const plain = await runWatch(["--watch"], deps);
    expect(plain.code).toBe(0);
    expect(jsonLines(plain.out)[1]).toEqual({ pending: 1 });

    // The same deps do stop a session watch.
    await startWatchServer(pending(1));
    const session = await runWatch(["--watch", "--session"], deps);
    expect(session.code).toBe(0);
    expect(jsonLines(session.out)).toEqual([{ stopped: "parent_gone" }]);
  });

  it("messages drained by the arming call end a --session watch at once: line 1, {pending:n}, no poll and no renewal", async () => {
    const messages = [{ id: "m1", content: "<untrusted_content>are you touching messages.ts?</untrusted_content>" }];
    const { server } = await startWatchServer(() => undefined, {
      messages,
      expiresInMs: 150,
      extend: (_req, res) => sendJson(res, 200, { expires_at: futureIso(150) }),
    });
    const result = await runWatch(["--watch", "--session"]);
    expect(result.code).toBe(0);
    const lines = jsonLines(result.out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ messages, result: { count: 1 } });
    expect(lines[1]).toEqual({ pending: 1 });
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    expect(server.requests.filter((r) => r.url === "/api/mcp/inbox-watch/extend")).toHaveLength(0);
    expectNoSecrets(result.out + result.err);
  });

  it("a signal wins over a parent that is gone too: {stopped:interrupted}, exit 130", async () => {
    let tick: (() => void) | null = null;
    const { server } = await startWatchServer(() => undefined);
    const signals = new EventEmitter();
    const deps: WatchDeps = {
      ...FAST,
      signals: signals as unknown as WatchDeps["signals"],
      env: { CLAUDE_PID: "4242" },
      parent: {
        isAlive: () => false,
        ppid: () => 100,
        setInterval: (fn) => {
          tick = fn;
          return {};
        },
        clearInterval: () => undefined,
        checkEveryMs: 15_000,
      },
    };
    const running = runWatch(["--watch", "--session"], deps);
    await waitFor(() => server.requests.some((r) => r.method === "GET"));
    signals.emit("SIGINT");
    (tick as unknown as () => void)();
    const result = await running;
    expect(result.code).toBe(130);
    expect(jsonLines(result.out).at(-1)).toEqual({ stopped: "interrupted" });
  });

  it.skipIf(process.platform === "win32")("watches without a lock, rather than refusing, when the lock folder can't be used safely", async () => {
    // A lock folder open to other users is "unavailable": the lock only saves waste, so the watch goes on unlocked.
    const unsafe = join(dirname(sandbox.repo), "open-locks");
    mkdirSync(unsafe);
    chmodSync(unsafe, 0o777);
    expect((await acquireWatchLock(AGENT_A, "watch", { ...DEFAULT_LOCK_DEPS, dir: () => unsafe })).kind).toBe("unavailable");
    await startWatchServer(pending(1));
    const result = await runWatch(["--watch", "--session"], { ...FAST, lock: { ...DEFAULT_LOCK_DEPS, dir: () => unsafe } });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ pending: 1 });
    expect(readdirSync(unsafe)).toEqual([]);
  });

  it("stops {stopped:session_limit} once the session limit has passed", async () => {
    await startWatchServer(pending(0), { expiresInMs: 60_000, extend: (_req, res) => sendJson(res, 200, { expires_at: futureIso(60_000) }) });
    const result = await runWatch(["--watch", "--session"], { ...FAST, minPollMs: 40, sessionMaxMs: 250 });
    expect(result.code).toBe(0);
    expect(jsonLines(result.out)[1]).toEqual({ stopped: "session_limit" });
  });

  it("SIGINT is still an interruption: exit 130", async () => {
    const { server } = await startWatchServer(() => undefined);
    const signals = new EventEmitter();
    const running = runWatch(["--watch", "--session"], { ...FAST, signals: signals as unknown as WatchDeps["signals"] });
    await waitFor(() => server.requests.some((r) => r.method === "GET"));
    signals.emit("SIGINT");
    const result = await running;
    expect(result.code).toBe(130);
    expect(jsonLines(result.out).at(-1)).toEqual({ stopped: "interrupted" });
  });
});
