import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { deadOrigin, expectNoSecrets, FAKE_KEY, rpcResult, sendJson, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer } from "../../test/helpers/fake-mcp-server.js";
import { callTool, MCP_MAX_RESPONSE_BYTES } from "./client.js";

const servers: FakeServer[] = [];
async function start(options: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> {
  const server = await startFakeServer(options);
  servers.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const seatFor = (origin: string) => ({ origin, token: FAKE_KEY });

describe("callTool request", () => {
  it("POSTs a JSON-RPC tools/call to <origin>/api/mcp with the key and the Accept header", async () => {
    const server = await start();
    await callTool(seatFor(server.origin), "list_agents", { agent_id: "x" });
    const [request] = server.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/mcp");
    expect(request?.headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(request?.headers["accept"]).toBe("application/json, text/event-stream");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_agents", arguments: { agent_id: "x" } } });
  });

  it("sends only to the seat's origin, ignoring JUBARTEAI_URL", async () => {
    const real = await start();
    const other = await start();
    process.env["JUBARTEAI_URL"] = other.origin;
    try {
      await callTool(seatFor(real.origin), "list_agents", {});
    } finally {
      delete process.env["JUBARTEAI_URL"];
    }
    expect(real.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
  });

  it("refuses an origin that is not https or loopback http, sending nothing", async () => {
    const outcome = await callTool(seatFor("http://evil.example"), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 5, envelope: { code: "invalid_origin" } });
    expect(outcome.envelope.error).toContain("Run: jubarteai login");
  });
});

describe("callTool envelope", () => {
  it("returns the envelope with messages first and exit 0", async () => {
    const server = await start({ tool: () => ({ result: { ok: true }, messages: [{ id: "m1" }] }) });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome.exitCode).toBe(0);
    expect(Object.keys(outcome.envelope)).toEqual(["messages", "result"]);
    expect(outcome.envelope.messages).toEqual([{ id: "m1" }]);
  });

  it("adds an empty messages array when the server's error envelope has none, and exits 1", async () => {
    const server = await start({ tool: () => ({ error: "agent_id not found or not owned by this seat" }) });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toEqual({ envelope: { messages: [], error: "agent_id not found or not owned by this seat" }, exitCode: 1 });
  });

  it("keeps the messages of an error envelope", async () => {
    const server = await start({ tool: () => ({ messages: [{ id: "m" }], error: "rate limited" }) });
    const outcome = await callTool(seatFor(server.origin), "search_knowledge", {});
    expect(outcome.exitCode).toBe(1);
    expect(outcome.envelope.messages).toEqual([{ id: "m" }]);
  });

  it("turns the SDK's plain-text validation error (isError) into exit 1", async () => {
    const server = await start({
      mcp: (req, res) => {
        sendJson(res, 200, { jsonrpc: "2.0", id: (req.body as { id: unknown }).id, result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Input validation error: title required" }] } });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "create_knowledge", {});
    expect(outcome).toMatchObject({ exitCode: 1, envelope: { messages: [], code: "tool_error" } });
    expect(outcome.envelope.error).toContain("Input validation error");
  });

  it("turns a JSON-RPC error (an unknown tool) into exit 1", async () => {
    const server = await start({
      mcp: (req, res) => {
        sendJson(res, 200, { jsonrpc: "2.0", id: (req.body as { id: unknown }).id, error: { code: -32602, message: "Tool nope not found" } });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "nope", {});
    expect(outcome).toEqual({ envelope: { messages: [], error: "Tool nope not found", code: "rpc_error" }, exitCode: 1 });
  });

  it("reads a text/event-stream response", async () => {
    const server = await start({
      mcp: (req, res) => {
        const message = rpcResult((req.body as { id: unknown }).id, { messages: [], result: { via: "sse" } });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toEqual({ envelope: { messages: [], result: { via: "sse" } }, exitCode: 0 });
  });

  it.each([
    ["an HTML page", "<html>oops</html>", "text/html"],
    ["an empty body", "", "application/json"],
    ["a JSON array", "[1,2]", "application/json"],
    ["a result with no text block", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), "application/json"],
    ["a text block that is not an envelope", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "just words" }] } }), "application/json"],
  ])("answers exit 4 bad_response for %s", async (_name, body, type) => {
    const server = await start({
      mcp: (_req, res) => {
        res.writeHead(200, { "Content-Type": type });
        res.end(body);
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { messages: [], code: "bad_response" } });
  });

  it("refuses a response larger than the cap", async () => {
    const server = await start({
      mcp: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("x".repeat(MCP_MAX_RESPONSE_BYTES + 1024));
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { code: "bad_response" } });
  });

  it("redacts a key or code in server text it passes through", async () => {
    const server = await start({ tool: () => ({ messages: [], error: "bad key jba_SOMETHINGSECRETSOMETHING here" }) });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome.envelope.error).toBe("bad key [redacted] here");
  });
});

describe("callTool failures", () => {
  it.each([
    [401, "invalid_api_key", "invalid_api_key"],
    [401, "revoked_api_key", "revoked_api_key"],
    [402, "billing_inactive", "billing_inactive"],
    [403, "seat_canceled", "seat_canceled"],
  ])("HTTP %i %s is exit 3 with the server's code and a fixed message", async (status, serverCode, expectedCode) => {
    const server = await start({
      mcp: (_req, res) => {
        sendJson(res, status, { error: serverCode, error_description: "Hello jba_LEAKYLEAKYLEAKYLEAKY", message: "server words" });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome.exitCode).toBe(3);
    expect(outcome.envelope).toMatchObject({ messages: [], code: expectedCode });
    expect(outcome.envelope.error).not.toContain("server words");
    expect(outcome.envelope.error).not.toContain("jba_");
    expect(Object.keys(outcome.envelope)).toEqual(["messages", "error", "code"]);
  });

  it("falls back to a code derived from the status for an unreadable 401/402/403 body", async () => {
    for (const [status, code] of [[401, "unauthorized"], [402, "billing_inactive"], [403, "forbidden"]] as const) {
      const server = await start({
        mcp: (_req, res) => {
          res.writeHead(status, { "Content-Type": "text/html" });
          res.end("<html>blocked</html>");
          return true;
        },
      });
      const outcome = await callTool(seatFor(server.origin), "list_agents", {});
      expect(outcome).toMatchObject({ exitCode: 3, envelope: { code } });
    }
  });

  it("does not echo a hostile error code back as prose", async () => {
    const server = await start({
      mcp: (_req, res) => {
        sendJson(res, 401, { error: "constructor" });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome.exitCode).toBe(3);
    // An inherited property name is not a known code: the status's own fixed message is used.
    expect(outcome.envelope.error).toBe("The server did not accept this key. Run: jubarteai login");
  });

  it.each([500, 502, 503, 504])("HTTP %i is exit 4 server_error", async (status) => {
    const server = await start({
      mcp: (_req, res) => {
        sendJson(res, status, { error: "boom", message: "jba_NOPE" });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { messages: [], code: "server_error" } });
  });

  it("answers exit 4 for any other unexpected status", async () => {
    const server = await start({
      mcp: (_req, res) => {
        sendJson(res, 429, { error: "slow down" });
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { code: "http_error" } });
  });

  it("times out with exit 4", async () => {
    const server = await start({ mcp: () => true }); // never answers
    const outcome = await callTool(seatFor(server.origin), "list_agents", {}, { timeoutMs: 100 });
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { code: "timeout" } });
  });

  it("stops when the caller aborts", async () => {
    const server = await start({ mcp: () => true });
    const controller = new AbortController();
    const pending = callTool(seatFor(server.origin), "list_agents", {}, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ exitCode: 4, envelope: { code: "aborted" } });
  });

  it("answers exit 4 network_error when nothing listens (ECONNREFUSED)", async () => {
    const outcome = await callTool(seatFor(await deadOrigin()), "list_agents", {});
    expect(outcome).toMatchObject({ exitCode: 4, envelope: { messages: [], code: "network_error" } });
  });

  it("never follows a redirect: the key does not reach the other host", async () => {
    const target = await start();
    const redirecting = await start({
      mcp: (_req, res) => {
        res.writeHead(307, { Location: `${target.origin}/api/mcp` });
        res.end();
        return true;
      },
    });
    const outcome = await callTool(seatFor(redirecting.origin), "list_agents", {});
    expect(outcome.exitCode).toBe(4);
    expect(target.requests).toHaveLength(0);
  });

  it("never puts the key in an outcome, whatever the failure", async () => {
    const outcomes = [
      await callTool(seatFor(await deadOrigin()), "x", {}),
      await callTool(seatFor("http://evil.example"), "x", {}),
      await callTool({ origin: (await start()).origin, token: "jba_bad header\nvalue" }, "x", {}),
    ];
    for (const outcome of outcomes) expectNoSecrets(JSON.stringify(outcome), ["bad header"]);
  });

  it("survives a connection that closes mid-response", async () => {
    const server = await start({
      mcp: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
        res.write("{");
        (res as http.ServerResponse).socket?.destroy();
        return true;
      },
    });
    const outcome = await callTool(seatFor(server.origin), "list_agents", {});
    expect(outcome.exitCode).toBe(4);
  });
});
