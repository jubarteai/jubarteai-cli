import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  cliVersion,
  DEFAULT_ORIGIN,
  INBOX_MIN_POLL_MS,
  INBOX_POLL_TIMEOUT_MS,
  INBOX_RETRY_AFTER_NETWORK_MS,
  INBOX_RETRY_AFTER_SERVER_MS,
  INBOX_WAIT_MAX_SECONDS,
  INBOX_WATCH_DEFAULT_MINUTES,
  INBOX_WATCH_MAX_MINUTES,
  INBOX_WATCH_PATH,
  LOOPBACK_HOSTS,
  MCP_MAX_RESPONSE_BYTES,
  MCP_PATH,
} from "./constants.js";

describe("constants", () => {
  it("cliVersion matches package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(cliVersion()).toBe(manifest.version);
    expect(cliVersion()).toBe(cliVersion());
  });

  it("the default origin is https and the loopback list is exactly the three hosts", () => {
    expect(DEFAULT_ORIGIN).toBe("https://jubarte.ai");
    expect([...LOOPBACK_HOSTS]).toEqual(["127.0.0.1", "localhost", "[::1]"]);
  });

  it("pins the MCP and inbox-watch values the spec fixes", () => {
    expect(MCP_PATH).toBe("/api/mcp");
    expect(INBOX_WATCH_PATH).toBe("/api/mcp/inbox-watch");
    expect(MCP_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    expect(INBOX_WAIT_MAX_SECONDS).toBe(40);
    expect([INBOX_WATCH_DEFAULT_MINUTES, INBOX_WATCH_MAX_MINUTES]).toEqual([30, 120]);
    expect([INBOX_RETRY_AFTER_SERVER_MS, INBOX_RETRY_AFTER_NETWORK_MS]).toEqual([10_000, 5_000]);
    expect(INBOX_MIN_POLL_MS).toBeLessThan(INBOX_POLL_TIMEOUT_MS);
  });
});
