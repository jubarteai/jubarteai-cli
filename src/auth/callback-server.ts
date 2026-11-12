import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { AUTH_CODE_RE } from "./token-exchange.js";

// The one-shot loopback listener of the browser login (spec sections 7.1 and 8). It binds 127.0.0.1
// on an ephemeral port only, answers `GET /callback` carrying the expected `state` and nothing else,
// and closes after the first definite answer or the timeout.

export type CallbackResult = { code: string } | { error: "access_denied" } | { error: "timeout" };

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>JubarteAI</title></head><body><p>You can close this tab.</p></body></html>";

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'none'; frame-ancestors 'none'",
  Connection: "close",
} as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string equality (both sides hashed first, so length doesn't leak either). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function reply(res: ServerResponse, status: number, body: string, then?: () => void): void {
  res.writeHead(status, { ...PAGE_HEADERS, "Content-Length": Buffer.byteLength(body) });
  res.end(body, then);
}

/** The single value of a query key; null when absent or repeated. */
function single(params: URLSearchParams, key: string): string | null {
  const all = params.getAll(key);
  return all.length === 1 ? (all[0] as string) : null;
}

export async function startCallbackServer(opts: { state: string; timeoutMs: number }): Promise<{
  port: number;
  result: Promise<CallbackResult>;
  close(): void;
}> {
  let finish: (value: CallbackResult) => void = () => undefined;
  const result = new Promise<CallbackResult>((resolve) => {
    finish = resolve;
  });

  let port = 0;
  let closed = false;
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};

  const server: Server = createServer();

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer.handle !== undefined) clearTimeout(timer.handle);
    server.close();
    // Keep-alive sockets from the browser would otherwise hold the listener open.
    server.closeAllConnections();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const hostHeader = req.headers.host;
    if (hostHeader !== `127.0.0.1:${port}`) {
      // A DNS-rebinding page reaches us under another Host name.
      reply(res, 400, "Bad request.");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      reply(res, 400, "Bad request.");
      return;
    }
    if (url.pathname !== "/callback") {
      reply(res, 404, "Not found.");
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      reply(res, 405, "Method not allowed.");
      return;
    }
    const state = single(url.searchParams, "state");
    if (state === null || !sameSecret(state, opts.state)) {
      reply(res, 400, "Bad request.");
      return;
    }
    const error = single(url.searchParams, "error");
    if (error === "access_denied") {
      reply(res, 200, PAGE, close);
      finish({ error: "access_denied" });
      return;
    }
    const code = single(url.searchParams, "code");
    if (error !== null || code === null || !AUTH_CODE_RE.test(code)) {
      reply(res, 400, "Bad request.");
      return;
    }
    // Answer first, then close: closing before the reply is flushed would cut the browser's page off.
    reply(res, 200, PAGE, close);
    finish({ code });
  };

  server.on("request", handle);
  // A socket error (a browser that hangs up mid-request) must not take the login down.
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  server.on("error", () => undefined);
  port = (server.address() as AddressInfo).port;

  timer.handle = setTimeout(() => {
    finish({ error: "timeout" });
    close();
  }, opts.timeoutMs);

  return { port, result, close };
}
