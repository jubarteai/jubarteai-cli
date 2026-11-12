// A self-contained node:http stand-in for the JubarteAI app, for the integration tests that drive the
// built binary: POST /api/mcp (tools/call for all 16 tools), GET /api/mcp/inbox-watch, POST /api/cli/token
// (a real PKCE check against the challenge it saw), GET /api/cli/whoami, and an `authorize()` helper that
// plays the browser: it takes the URL the CLI printed and calls the CLI's loopback callback.
// Every key, code and token here is random and fake.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Identity = {
  seat_id: string;
  user: { id: string; email: string };
  company: { id: string; slug: string; name: string };
};

const DEFAULT_IDENTITY: Identity = {
  seat_id: "11111111-1111-4111-8111-111111111111",
  user: { id: "22222222-2222-4222-8222-222222222222", email: "ada@example.com" },
  company: { id: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme Inc" },
};

/** The 16 tools the app's /api/mcp serves. */
export const SERVER_TOOLS = [
  "connect",
  "disconnect",
  "list_agents",
  "echo_current_task",
  "search_knowledge",
  "get_knowledge",
  "create_knowledge",
  "update_knowledge",
  "verify_knowledge",
  "message_agents",
  "check_inbox",
  "claim",
  "release",
  "list_knowledge_gaps",
  "list_knowledge_merges",
  "resolve_knowledge_merge",
] as const;

type KeyRecord = { identity: Identity; id: string; prefix: string; name: string; minted_by: "cli" | "dashboard"; revoked: boolean };

export type Recorded = { method: string; path: string; authorization: string | null; body: unknown };
export type ToolCall = { name: string; arguments: Record<string, unknown>; authorization: string | null };
export type AgentRecord = { id: string; name: string; seat_id: string; description: string | null };

export type FakeServer = {
  origin: string;
  port: number;
  /** Every request received, in order (token exchange and MCP bodies included). */
  requests: Recorded[];
  /** What /api/cli/token was asked to exchange. */
  exchanges: Array<{ code: string; code_verifier: string; replaces: string | null }>;
  /** The authorize URLs `authorize()` was given. */
  authorizeUrls: string[];
  /** Agents handed out by `connect`, oldest first. */
  agents: AgentRecord[];
  /** How POST /api/mcp answers: normally, a 401, a 500, or a 307 to `redirectTo`. */
  mcpMode: "ok" | "unauthorized" | "server_error" | "redirect";
  /** Where the "redirect" mode sends the caller (an origin the key must never reach). */
  redirectTo: string | null;
  /** The next call of this tool answers with `error` in its envelope. */
  failTool(tool: string, message: string): void;
  identity: Identity;
  /** Registers a key as known (a dashboard key unless said otherwise). */
  addKey(token: string, mintedBy?: "cli" | "dashboard"): void;
  /** Keys the token endpoint minted, oldest first. */
  mintedKeys(): string[];
  revoke(token: string): void;
  isRevoked(token: string): boolean;
  /** Queues a peer message for an agent; the next check_inbox drains it. */
  enqueueMessage(agentId: string, content: string, opts?: { priority?: "normal" | "urgent" }): void;
  /** Every tools/call received. */
  toolCalls(): ToolCall[];
  /** What the browser does on Approve: mint a code for the URL's challenge, then GET the CLI's callback. */
  authorize(authorizeUrl: string, opts?: { deny?: boolean; state?: string }): Promise<Response>;
  /** A fresh valid code bound to `challenge` (what a user would paste in `--paste` mode). */
  mintCode(challenge: string): string;
  close(): Promise<void>;
};

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startFakeServer(): Promise<FakeServer> {
  const codes = new Map<string, { challenge: string; used: boolean }>();
  const keys = new Map<string, KeyRecord>();
  const watchTokens = new Map<string, string>();
  const inboxes = new Map<string, Array<{ id: string; content: string; priority: string }>>();
  const toolErrors = new Map<string, string>();
  const requests: Recorded[] = [];
  const exchanges: FakeServer["exchanges"] = [];
  const agents: AgentRecord[] = [];
  const authorizeUrls: string[] = [];
  const minted: string[] = [];
  let counter = 0;
  const state = { identity: DEFAULT_IDENTITY, mcpMode: "ok" as FakeServer["mcpMode"], redirectTo: null as string | null };

  const record = (req: IncomingMessage): Recorded => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const entry: Recorded = { method: req.method ?? "", path, authorization: req.headers.authorization ?? null, body: null };
    requests.push(entry);
    return entry;
  };

  const keyOf = (req: IncomingMessage): KeyRecord | undefined => {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? keys.get(header.slice("Bearer ".length)) : undefined;
  };

  async function token(req: IncomingMessage, res: ServerResponse, entry: Recorded): Promise<void> {
    const text = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "invalid_request" });
      return;
    }
    entry.body = body;
    const code = String(body["code"]);
    const verifier = String(body["code_verifier"]);
    const replaces = typeof body["replaces"] === "string" ? body["replaces"] : null;
    exchanges.push({ code, code_verifier: verifier, replaces });
    const known = codes.get(code);
    // Real PKCE: S256(verifier) must equal the challenge the authorize URL carried; a code works once.
    if (known === undefined || known.used || b64url(createHash("sha256").update(verifier).digest()) !== known.challenge) {
      if (known !== undefined) known.used = true;
      send(res, 400, { error: "invalid_grant" });
      return;
    }
    known.used = true;
    counter += 1;
    const plain = `jba_${b64url(randomBytes(24))}`;
    const identity = state.identity;
    const created: KeyRecord = {
      identity,
      id: `44444444-4444-4444-8444-${String(counter).padStart(12, "0")}`,
      prefix: plain.slice(0, 12),
      name: "CLI · testhost · 2026-11-11",
      minted_by: "cli",
      revoked: false,
    };
    keys.set(plain, created);
    minted.push(plain);
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
      key: { id: created.id, prefix: created.prefix, name: created.name },
      seat_id: identity.seat_id,
      user: identity.user,
      company: identity.company,
      replaced,
    });
  }

  function whoami(req: IncomingMessage, res: ServerResponse): void {
    const key = keyOf(req);
    if (key === undefined) return send(res, 401, { error: "invalid_api_key" });
    if (key.revoked) return send(res, 401, { error: "revoked_api_key" });
    send(res, 200, {
      seat_id: key.identity.seat_id,
      user: key.identity.user,
      company: key.identity.company,
      key: { id: key.id, prefix: key.prefix, name: key.name, minted_by: key.minted_by },
    });
  }

  function rpcResult(id: unknown, envelope: unknown): unknown {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } };
  }

  function toolResult(name: string, args: Record<string, unknown>, key: KeyRecord, origin: string): unknown {
    const agentId = typeof args["agent_id"] === "string" ? args["agent_id"] : "";
    switch (name) {
      case "connect": {
        const agent: AgentRecord = {
          id: randomUUID(),
          name: `agent-${agents.length + 1}`,
          seat_id: key.identity.seat_id,
          description: typeof args["description"] === "string" ? args["description"] : null,
        };
        agents.push(agent);
        return { agent_id: agent.id, name: agent.name };
      }
      case "disconnect":
        return { disconnected: true };
      case "list_agents":
        return { agents: agents.map((a) => ({ id: a.id, name: a.name, status: "connected", current_task: null, claims: [] })) };
      case "echo_current_task":
        return { id: randomUUID(), overlaps: [] };
      case "search_knowledge":
        return { results: [], count: 0 };
      case "get_knowledge":
        return { id: typeof args["id"] === "string" ? args["id"] : randomUUID(), title: "Fake entry", description: "body", fetch_count: 1 };
      case "create_knowledge":
        return { id: randomUUID() };
      case "update_knowledge":
        return { id: typeof args["id"] === "string" ? args["id"] : randomUUID(), updated_at: new Date(0).toISOString() };
      case "verify_knowledge":
        return { id: typeof args["id"] === "string" ? args["id"] : randomUUID(), verified_at: new Date(0).toISOString() };
      case "message_agents":
        return { delivered: 0, recipients: [], skipped: [] };
      case "claim":
        return { resource: args["resource"] ?? "", expires_at: new Date(Date.now() + 900_000).toISOString() };
      case "release":
        return { released: true };
      case "list_knowledge_gaps":
        return { gaps: [] };
      case "list_knowledge_merges":
        return { proposals: [] };
      case "resolve_knowledge_merge":
        return { id: typeof args["id"] === "string" ? args["id"] : randomUUID(), status: "rejected" };
      case "check_inbox": {
        const result: Record<string, unknown> = { count: 0 };
        const watchMinutes = args["watch_minutes"];
        if (typeof watchMinutes === "number") {
          const watchToken = `jbw_${b64url(randomBytes(24))}`;
          watchTokens.set(watchToken, agentId);
          result["watch"] = {
            command: `curl -fsS -H "Authorization: Bearer ${watchToken}" ${origin}/api/mcp/inbox-watch`,
            url: `${origin}/api/mcp/inbox-watch`,
            token: watchToken,
            expires_at: new Date(Date.now() + Math.min(watchMinutes, 120) * 60_000).toISOString(),
          };
        }
        return result;
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse, entry: Recorded, origin: string): Promise<void> {
    const text = await readBody(req);
    let rpc: unknown;
    try {
      rpc = JSON.parse(text);
    } catch {
      rpc = null;
    }
    entry.body = rpc;
    if (state.mcpMode === "server_error") return send(res, 500, { error: "boom" });
    if (state.mcpMode === "redirect") {
      res.writeHead(307, { Location: `${state.redirectTo ?? "http://127.0.0.1:1"}/api/mcp` });
      return void res.end();
    }
    const key = keyOf(req);
    if (state.mcpMode === "unauthorized" || key === undefined) return send(res, 401, { error: "invalid_api_key" });
    if (key.revoked) return send(res, 401, { error: "revoked_api_key" });
    const params = isRecord(rpc) && isRecord(rpc["params"]) ? rpc["params"] : {};
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    const id = isRecord(rpc) ? rpc["id"] : null;
    const failure = toolErrors.get(name);
    if (failure !== undefined) {
      toolErrors.delete(name);
      return send(res, 200, rpcResult(id, { messages: [], error: failure }));
    }
    const agentId = typeof args["agent_id"] === "string" ? args["agent_id"] : "";
    // Like the app: every response carries the caller's pending messages, drained.
    const queue = inboxes.get(agentId) ?? [];
    const drained = queue.splice(0, queue.length).map((m) => ({
      id: m.id,
      from_agent_id: "cccccccc-0000-4000-8000-00000000000c",
      from_name: "peer",
      content: m.content,
      priority: m.priority,
      created_at: new Date(0).toISOString(),
    }));
    const result = toolResult(name, args, key, origin);
    if (isRecord(result) && name === "check_inbox") result["count"] = drained.length;
    send(res, 200, rpcResult(id, { messages: drained, result }));
  }

  function inboxWatch(req: IncomingMessage, res: ServerResponse): void {
    const header = req.headers.authorization ?? "";
    const agentId = header.startsWith("Bearer ") ? watchTokens.get(header.slice("Bearer ".length)) : undefined;
    if (agentId === undefined) return send(res, 401, { error: "invalid_or_expired_watch" });
    const deadline = Date.now() + 5_000;
    const tick = (): void => {
      const pending = (inboxes.get(agentId) ?? []).length;
      if (pending > 0 || Date.now() >= deadline || res.destroyed) return send(res, 200, { pending });
      setTimeout(tick, 25);
    };
    tick();
  }

  const server: Server = createServer((req, res) => {
    const entry = record(req);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.method === "POST" && entry.path === "/api/cli/token") void token(req, res, entry);
    else if (req.method === "GET" && entry.path === "/api/cli/whoami") whoami(req, res);
    else if (req.method === "POST" && entry.path === "/api/mcp") void mcp(req, res, entry, origin);
    else if (req.method === "GET" && entry.path === "/api/mcp/inbox-watch") inboxWatch(req, res);
    else send(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const mintCode = (challenge: string): string => {
    const code = `jbc_${b64url(randomBytes(32))}`;
    codes.set(code, { challenge, used: false });
    return code;
  };

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    exchanges,
    authorizeUrls,
    agents,
    get mcpMode() {
      return state.mcpMode;
    },
    set mcpMode(value) {
      state.mcpMode = value;
    },
    get redirectTo() {
      return state.redirectTo;
    },
    set redirectTo(value) {
      state.redirectTo = value;
    },
    get identity() {
      return state.identity;
    },
    set identity(value) {
      state.identity = value;
    },
    failTool(tool, message) {
      toolErrors.set(tool, message);
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
    mintedKeys: () => [...minted],
    revoke(plain) {
      const found = keys.get(plain);
      if (found !== undefined) found.revoked = true;
    },
    isRevoked: (plain) => keys.get(plain)?.revoked === true,
    enqueueMessage(agentId, content, opts = {}) {
      const queue = inboxes.get(agentId) ?? [];
      queue.push({ id: randomUUID(), content, priority: opts.priority ?? "normal" });
      inboxes.set(agentId, queue);
    },
    toolCalls() {
      return requests
        .filter((r) => r.method === "POST" && r.path === "/api/mcp" && isRecord(r.body))
        .map((r) => {
          const params = isRecord((r.body as Record<string, unknown>)["params"]) ? ((r.body as Record<string, unknown>)["params"] as Record<string, unknown>) : {};
          return {
            name: typeof params["name"] === "string" ? params["name"] : "",
            arguments: isRecord(params["arguments"]) ? params["arguments"] : {},
            authorization: r.authorization,
          };
        });
    },
    mintCode,
    async authorize(authorizeUrl, opts = {}) {
      authorizeUrls.push(authorizeUrl);
      const url = new URL(authorizeUrl);
      const challenge = url.searchParams.get("challenge") ?? "";
      const cliPort = url.searchParams.get("port");
      if (cliPort === null) throw new Error("authorize() needs a loopback authorize URL (the CLI was not in paste mode)");
      const target = new URL(`http://127.0.0.1:${cliPort}/callback`);
      if (opts.deny === true) target.searchParams.set("error", "access_denied");
      else target.searchParams.set("code", mintCode(challenge));
      target.searchParams.set("state", opts.state ?? url.searchParams.get("state") ?? "");
      return fetch(target);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
