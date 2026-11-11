import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the JubarteAI auth endpoints (`POST /api/cli/token`, `GET /api/cli/whoami`) plus the
// part of /cli/authorize a browser would do after "Approve". All keys and codes here are random and fake.

export type FakeIdentity = {
  seat_id: string;
  user: { id: string; email: string };
  company: { id: string; slug: string; name: string };
};

export const DEFAULT_IDENTITY: FakeIdentity = {
  seat_id: "11111111-1111-4111-8111-111111111111",
  user: { id: "22222222-2222-4222-8222-222222222222", email: "ada@example.com" },
  company: { id: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme Inc" },
};

type KeyRecord = { identity: FakeIdentity; id: string; prefix: string; name: string; minted_by: "cli" | "dashboard"; revoked: boolean };

export type RecordedRequest = { method: string; path: string; authorization: string | null; body: unknown };

export type FakeAuthServer = {
  origin: string;
  port: number;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** What `/api/cli/token` was asked to exchange. */
  exchanges: Array<{ code: string; code_verifier: string; replaces: string | null }>;
  /** Authorize URLs the fake browser was given. */
  authorizeUrls: string[];
  /** When true the token response carries null email, slug and name (the server's lookups failed). */
  nullIdentity: boolean;
  /** The next N whoami calls answer 500. */
  whoamiFailures: number;
  /** Force the next token answer. */
  tokenOverride: { status: number; body: unknown } | null;
  identity: FakeIdentity;
  /** Registers a key as known to whoami (a dashboard key by default). */
  addKey(token: string, minted_by?: "cli" | "dashboard"): void;
  isRevoked(token: string): boolean;
  /** What the browser does on Approve: mint a code for `challenge`, then GET the CLI's callback. */
  approve(authorizeUrl: string, opts?: { state?: string; deny?: boolean }): Promise<Response>;
  /** A fresh valid code bound to `challenge`. */
  mintCode(challenge: string): string;
  close(): Promise<void>;
};

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const codes = new Map<string, { challenge: string; used: boolean }>();
  const keys = new Map<string, KeyRecord>();
  const requests: RecordedRequest[] = [];
  const exchanges: FakeAuthServer["exchanges"] = [];
  let counter = 0;

  const state: Pick<FakeAuthServer, "nullIdentity" | "whoamiFailures" | "tokenOverride" | "identity"> = {
    nullIdentity: false,
    whoamiFailures: 0,
    tokenOverride: null,
    identity: DEFAULT_IDENTITY,
  };

  const whoamiBody = (record: KeyRecord): unknown => ({
    seat_id: record.identity.seat_id,
    user: record.identity.user,
    company: record.identity.company,
    key: { id: record.id, prefix: record.prefix, name: record.name, minted_by: record.minted_by },
  });

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "invalid_request", message: "The request body must be JSON." });
      return;
    }
    const code = String(body["code"]);
    const verifier = String(body["code_verifier"]);
    const replaces = typeof body["replaces"] === "string" ? body["replaces"] : null;
    requests[requests.length - 1] = { ...(requests[requests.length - 1] as RecordedRequest), body };
    exchanges.push({ code, code_verifier: verifier, replaces });
    if (state.tokenOverride !== null) {
      const forced = state.tokenOverride;
      state.tokenOverride = null;
      send(res, forced.status, forced.body);
      return;
    }
    const entry = codes.get(code);
    if (entry === undefined || entry.used || b64url(createHash("sha256").update(verifier).digest()) !== entry.challenge) {
      if (entry !== undefined) entry.used = true;
      send(res, 400, { error: "invalid_grant", message: "fixed" });
      return;
    }
    entry.used = true;
    counter += 1;
    const plain = `jba_${b64url(randomBytes(24))}`;
    const identity = state.identity;
    const record: KeyRecord = {
      identity,
      id: `44444444-4444-4444-8444-${String(counter).padStart(12, "0")}`,
      prefix: plain.slice(0, 12),
      name: "CLI · testhost · 2026-11-11",
      minted_by: "cli",
      revoked: false,
    };
    keys.set(plain, record);
    let replaced = false;
    if (replaces !== null) {
      const old = keys.get(replaces);
      if (old !== undefined && !old.revoked && old.minted_by === "cli" && old.identity.seat_id === identity.seat_id) {
        old.revoked = true;
        replaced = true;
      }
    }
    send(res, 200, {
      token: plain,
      key: { id: record.id, prefix: record.prefix, name: record.name },
      seat_id: identity.seat_id,
      user: { id: identity.user.id, email: state.nullIdentity ? null : identity.user.email },
      company: {
        id: identity.company.id,
        slug: state.nullIdentity ? null : identity.company.slug,
        name: state.nullIdentity ? null : identity.company.name,
      },
      replaced,
    });
  }

  function whoamiRoute(req: IncomingMessage, res: ServerResponse): void {
    if (state.whoamiFailures > 0) {
      state.whoamiFailures -= 1;
      send(res, 500, { error: "server_error", message: "fixed" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const record = header.startsWith("Bearer ") ? keys.get(header.slice("Bearer ".length)) : undefined;
    if (record === undefined) {
      send(res, 401, { error: "invalid_api_key", message: "fixed" });
      return;
    }
    if (record.revoked) {
      send(res, 401, { error: "revoked_api_key", message: "fixed" });
      return;
    }
    send(res, 200, whoamiBody(record));
  }

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization ?? null, body: null });
    if (req.method === "POST" && path === "/api/cli/token") {
      void token(req, res);
    } else if (req.method === "GET" && path === "/api/cli/whoami") {
      whoamiRoute(req, res);
    } else {
      send(res, 404, { error: "not_found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authorizeUrls: string[] = [];

  const mintCode = (challenge: string): string => {
    const code = `jbc_${b64url(randomBytes(32))}`;
    codes.set(code, { challenge, used: false });
    return code;
  };

  const fake: FakeAuthServer = {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    exchanges,
    authorizeUrls,
    get nullIdentity() {
      return state.nullIdentity;
    },
    set nullIdentity(value) {
      state.nullIdentity = value;
    },
    get whoamiFailures() {
      return state.whoamiFailures;
    },
    set whoamiFailures(value) {
      state.whoamiFailures = value;
    },
    get tokenOverride() {
      return state.tokenOverride;
    },
    set tokenOverride(value) {
      state.tokenOverride = value;
    },
    get identity() {
      return state.identity;
    },
    set identity(value) {
      state.identity = value;
    },
    addKey(plain, mintedBy = "dashboard") {
      counter += 1;
      keys.set(plain, {
        identity: state.identity,
        id: `55555555-5555-4555-8555-${String(counter).padStart(12, "0")}`,
        prefix: plain.slice(0, 12),
        name: mintedBy === "cli" ? "CLI · testhost · 2026-11-10" : "Laptop key",
        minted_by: mintedBy,
        revoked: false,
      });
    },
    isRevoked: (plain) => keys.get(plain)?.revoked === true,
    mintCode,
    async approve(authorizeUrl, opts = {}) {
      authorizeUrls.push(authorizeUrl);
      const url = new URL(authorizeUrl);
      const challenge = url.searchParams.get("challenge") ?? "";
      const cliState = opts.state ?? url.searchParams.get("state") ?? "";
      const cliPort = url.searchParams.get("port");
      if (cliPort === null) throw new Error("approve() needs a loopback authorize URL");
      const target = new URL(`http://127.0.0.1:${cliPort}/callback`);
      if (opts.deny === true) target.searchParams.set("error", "access_denied");
      else target.searchParams.set("code", mintCode(challenge));
      target.searchParams.set("state", cliState);
      return fetch(target);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return fake;
}
