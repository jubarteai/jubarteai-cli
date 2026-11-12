// A node:http stand-in for the app, enough for the MCP client, tool commands and inbox watch tests:
// POST /api/mcp answers tools/call like the app's route, GET /api/mcp/inbox-watch is scripted per test.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect } from "vitest";

import { saveSeat } from "../../src/auth/credentials.js";
import type { StoredSeat } from "../../src/auth/credentials.js";
import type { CommandContext, CommandDef } from "../../src/cli/commands.js";
import { routeWith } from "../../src/cli/router.js";
import { resetEnvTokenForTests } from "../../src/process-env.js";

export const FAKE_KEY = "jba_FAKEKEYFAKEKEYFAKEKEYFAKEKEY0001";
export const FAKE_WATCH_TOKEN = "jbw_FAKEWATCHFAKEWATCHFAKEWATCH0001";
export const AGENT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const AGENT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const SEAT_ID = "22222222-0000-4000-8000-0000000000a1";

export type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** The parsed JSON body, or undefined for a request without one. */
  body: unknown;
};

export type FakeOptions = {
  /** The envelope a tools/call answers with. Default: `{ messages: [], result: { tool, args } }`. */
  tool?: (name: string, args: Record<string, unknown>) => unknown;
  /** Takes over POST /api/mcp entirely (return true when the response was written). */
  mcp?: (req: RecordedRequest, res: http.ServerResponse) => boolean;
  /** Answers GET /api/mcp/inbox-watch; `index` counts the calls (0, 1, …). */
  watch?: (req: RecordedRequest, res: http.ServerResponse, index: number) => void;
};

export type FakeServer = {
  origin: string;
  requests: RecordedRequest[];
  /** The tools/call requests only, as { name, arguments }. */
  toolCalls(): Array<{ name: string; arguments: Record<string, unknown> }>;
  close(): Promise<void>;
};

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function rpcResult(id: unknown, envelope: unknown): unknown {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakeServer(options: FakeOptions = {}): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let watchCalls = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      let body: unknown;
      if (text !== "") {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }
      }
      const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(recorded);

      if (recorded.url === "/api/mcp" && recorded.method === "POST") {
        if (options.mcp?.(recorded, res) === true) return;
        const rpc = body as { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } };
        const name = rpc.params?.name ?? "";
        const args = rpc.params?.arguments ?? {};
        const envelope = options.tool === undefined ? { messages: [], result: { tool: name, args } } : options.tool(name, args);
        sendJson(res, 200, rpcResult(rpc.id, envelope));
        return;
      }
      if (recorded.url === "/api/mcp/inbox-watch" && recorded.method === "GET" && options.watch !== undefined) {
        options.watch(recorded, res, watchCalls++);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    toolCalls: () =>
      requests
        .filter((r) => r.url === "/api/mcp" && r.method === "POST")
        .map((r) => {
          const params = (r.body as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
          return { name: params?.name ?? "", arguments: params?.arguments ?? {} };
        }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** An origin nothing listens on (a server that was started and stopped). */
export async function deadOrigin(): Promise<string> {
  const server = await startFakeServer();
  const { origin } = server;
  await server.close();
  return origin;
}

export type CapturedStream = { stream: Writable; text: () => string };

export function capture(): CapturedStream {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => text };
}

export type TestCtx = { ctx: CommandContext; out: () => string; err: () => string };

export function makeCtx(cwd: string, globals: Partial<CommandContext["globals"]> = {}): TestCtx {
  const out = capture();
  const err = capture();
  const ctx: CommandContext = {
    stdout: out.stream,
    stderr: err.stream,
    stdin: process.stdin,
    cwd,
    globals: { pretty: false, yes: false, ...globals },
  };
  return { ctx, out: out.text, err: err.text };
}

/** Runs argv through the real router with `commands`, the way main() would, and returns the exit code and both streams. */
export async function runCli(
  commands: CommandDef[],
  argv: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const out = capture();
  const err = capture();
  const code = await routeWith(commands, argv, { stdout: out.stream, stderr: err.stream, stdin: process.stdin, cwd });
  return { code, out: out.text(), err: err.text() };
}

/** Polls until `condition` holds (no fixed sleeps in a test); fails after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every line of captured stdout parsed as JSON. */
export function jsonLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** Fails when anything that looks like a key, code or watch token (or one of `secrets`) is in `text`. */
export function expectNoSecrets(text: string, secrets: string[] = []): void {
  expect(text).not.toMatch(/jb[acw]_[A-Za-z0-9_-]{8,}/);
  for (const secret of [FAKE_KEY, FAKE_WATCH_TOKEN, ...secrets]) expect(text).not.toContain(secret);
}

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "TMPDIR",
  "JUBARTEAI_TOKEN",
  "JUBARTEAI_URL",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

export type Sandbox = {
  dir: string;
  repo: string;
  /** Saves a seat (the default one) pointing at `origin` with the fake key. */
  signIn(origin: string, token?: string): void;
  cleanup(): void;
};

/** A temp HOME with no credentials, no session cache and none of the harness variables set. */
export function createSandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jba-c4-")));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env["HOME"] = dir;
  process.env["USERPROFILE"] = dir;
  process.env["XDG_CONFIG_HOME"] = join(dir, ".config");
  process.env["APPDATA"] = join(dir, "AppData");
  process.env["TMPDIR"] = join(dir, "tmp");
  for (const key of ["JUBARTEAI_TOKEN", "JUBARTEAI_URL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[key];
  resetEnvTokenForTests();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  return {
    dir,
    repo,
    signIn(origin, token = FAKE_KEY) {
      const seat: StoredSeat = {
        origin,
        token,
        minted_by: "cli",
        key: { id: null, prefix: token.slice(0, 12), name: "CLI" },
        user: { id: "11111111-0000-4000-8000-0000000000a1", email: "alice@example.com" },
        company: { id: "33333333-0000-4000-8000-0000000000c1", slug: "acme", name: "Acme" },
        saved_at: "2026-11-10T00:00:00.000Z",
      };
      saveSeat(SEAT_ID, seat, { makeDefault: true });
    },
    cleanup() {
      for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvTokenForTests();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
