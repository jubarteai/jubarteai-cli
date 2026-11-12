import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedSeat } from "../auth/resolve-seat.js";
import { AGENT_A, AGENT_B, createSandbox, FAKE_KEY, SEAT_ID } from "../../test/helpers/fake-mcp-server.js";
import type { Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { NO_AGENT_MESSAGE, resolveAgent } from "./agent.js";
import { keyFingerprint, writeSession } from "./cache.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const ORIGIN = "https://jubarte.ai";
const seat = (over: Partial<ResolvedSeat> = {}): ResolvedSeat => ({
  seatId: SEAT_ID,
  origin: ORIGIN,
  token: FAKE_KEY,
  source: "default",
  seat: null,
  ...over,
});

function cache(agentId: string, over: { seat_id?: string | null; origin?: string } = {}): void {
  writeSession(
    "claude-code",
    "sess-1",
    { harness: "claude-code", agent_id: agentId, seat_id: over.seat_id === undefined ? SEAT_ID : over.seat_id, origin: over.origin ?? ORIGIN },
    { overwrite: true },
  );
}

describe("resolveAgent", () => {
  it("uses --agent", () => {
    expect(resolveAgent({ flag: AGENT_A, seat: seat() })).toEqual({ agentId: AGENT_A });
  });

  it("rejects a --agent that is not a UUID with exit 2", () => {
    const result = resolveAgent({ flag: "not-an-id\u001b[31m", seat: seat() });
    expect(result).toMatchObject({ exitCode: 2 });
    expect(JSON.stringify(result)).not.toContain("\u001b");
  });

  it("lets --agent beat the session cache", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    cache(AGENT_B);
    expect(resolveAgent({ flag: AGENT_A, seat: seat() })).toEqual({ agentId: AGENT_A });
  });

  it("uses the session's cached agent for the same seat and origin", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    cache(AGENT_B);
    expect(resolveAgent({ seat: seat() })).toEqual({ agentId: AGENT_B });
  });

  it("answers exit 2 with the connect hint when there is neither", () => {
    expect(resolveAgent({ seat: seat() })).toEqual({ error: NO_AGENT_MESSAGE, exitCode: 2 });
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1"; // a session with no cache entry
    expect(resolveAgent({ seat: seat() })).toMatchObject({ exitCode: 2 });
    expect(NO_AGENT_MESSAGE).toContain('jubarteai connect --description "');
  });

  it("ignores an entry written for another seat", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    cache(AGENT_B, { seat_id: "99999999-0000-4000-8000-000000000009" });
    expect(resolveAgent({ seat: seat() })).toMatchObject({ exitCode: 2 });
  });

  it("ignores an entry written for another origin", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    cache(AGENT_B, { origin: "http://127.0.0.1:3000" });
    expect(resolveAgent({ seat: seat() })).toMatchObject({ exitCode: 2 });
  });

  it("matches an environment key (no seat id) only with an entry that has none either", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: ORIGIN, key_fp: keyFingerprint(FAKE_KEY) }, { overwrite: true });
    expect(resolveAgent({ seat: seat({ seatId: null, source: "env" }) })).toEqual({ agentId: AGENT_B });
    expect(resolveAgent({ seat: seat() })).toMatchObject({ exitCode: 2 });
    cache(AGENT_B);
    expect(resolveAgent({ seat: seat({ seatId: null, source: "env" }) })).toMatchObject({ exitCode: 2 });
  });

  it("matches an environment key's entry only when its fingerprint is that key's", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "sess-1";
    const envSeat = seat({ seatId: null, source: "env", token: "jba_KEYAKEYAKEYAKEYAKEYAKEYAKEY01" });
    const write = (key_fp?: string) =>
      writeSession("claude-code", "sess-1", { harness: "claude-code", agent_id: AGENT_B, seat_id: null, origin: ORIGIN, ...(key_fp === undefined ? {} : { key_fp }) }, { overwrite: true });
    write(keyFingerprint(envSeat.token));
    expect(resolveAgent({ seat: envSeat })).toEqual({ agentId: AGENT_B });
    expect(resolveAgent({ seat: { ...envSeat, token: "jba_KEYBKEYBKEYBKEYBKEYBKEYBKEY02" } })).toMatchObject({ exitCode: 2 });
    write(); // no fingerprint at all: not provably this key's
    expect(resolveAgent({ seat: envSeat })).toMatchObject({ exitCode: 2 });
  });

  it("finds the entry of a Codex session through its thread variable", () => {
    process.env["CODEX_THREAD_ID"] = "thread-1";
    writeSession("codex", "thread-1", { harness: "codex", agent_id: AGENT_A, seat_id: SEAT_ID, origin: ORIGIN }, { overwrite: true });
    expect(resolveAgent({ seat: seat() })).toEqual({ agentId: AGENT_A });
  });
});
