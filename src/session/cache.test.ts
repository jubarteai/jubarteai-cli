import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_CACHE_MAX_AGE_MS } from "../constants.js";
import { CliError } from "../errors.js";
import { sessionsDir } from "../paths.js";
import { AGENT_A, AGENT_B, createSandbox } from "../../test/helpers/fake-mcp-server.js";
import type { Sandbox } from "../../test/helpers/fake-mcp-server.js";
import { readSession, sessionKey, writeSession } from "./cache.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const entry = (agent_id: string, extra: { name?: string; seat_id?: string | null; origin?: string } = {}) => ({
  harness: "claude-code" as const,
  agent_id,
  seat_id: extra.seat_id === undefined ? "seat-1" : extra.seat_id,
  origin: extra.origin ?? "https://jubarte.ai",
  ...(extra.name === undefined ? {} : { name: extra.name }),
});

const fileFor = (sessionId: string): string => join(sessionsDir(), `${sessionKey("claude-code", sessionId)}.json`);

describe("sessionKey", () => {
  it("is the first 32 hex characters of sha256 of harness:id", () => {
    const expected = createHash("sha256").update("claude-code:s-1").digest("hex").slice(0, 32);
    expect(sessionKey("claude-code", "s-1")).toBe(expected);
    expect(sessionKey("claude-code", "s-1")).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionKey("codex", "s-1")).not.toBe(expected);
  });
});

describe("writeSession / readSession", () => {
  it("round-trips an entry and writes it 0600 in a 0700 per-user folder", () => {
    expect(writeSession("claude-code", "s-1", entry(AGENT_A, { name: "Bold Otter" }), { overwrite: false })).toEqual({ written: true });
    const read = readSession("claude-code", "s-1");
    expect(read).toMatchObject({ version: 1, harness: "claude-code", agent_id: AGENT_A, seat_id: "seat-1", origin: "https://jubarte.ai", name: "Bold Otter" });
    expect(Number.isNaN(Date.parse(read?.created_at ?? ""))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(fileFor("s-1")).mode & 0o777).toBe(0o600);
      expect(statSync(sessionsDir()).mode & 0o777).toBe(0o700);
      expect(sessionsDir()).toContain(`jubarteai-${process.getuid?.()}`);
    }
    expect(JSON.parse(readFileSync(fileFor("s-1"), "utf8"))).not.toHaveProperty("token");
  });

  it("never replaces an existing entry when overwrite is false", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false });
    expect(writeSession("claude-code", "s-1", entry(AGENT_B), { overwrite: false })).toEqual({ written: false });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_A);
  });

  it("replaces the entry when overwrite is true, keeping created_at only for the same agent", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: true });
    const first = readSession("claude-code", "s-1");
    writeSession("claude-code", "s-1", entry(AGENT_A, { name: "n" }), { overwrite: true });
    expect(readSession("claude-code", "s-1")?.created_at).toBe(first?.created_at);
    writeSession("claude-code", "s-1", entry(AGENT_B), { overwrite: true });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_B);
  });

  it("keeps sessions apart", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false });
    writeSession("claude-code", "s-2", entry(AGENT_B), { overwrite: false });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_A);
    expect(readSession("claude-code", "s-2")?.agent_id).toBe(AGENT_B);
    expect(readSession("claude-code", "s-3")).toBeNull();
  });

  it("replaces a corrupt leftover under overwrite false, but not a valid entry", () => {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(fileFor("s-1"), "{ not json", { mode: 0o600 });
    expect(readSession("claude-code", "s-1")).toBeNull();
    expect(writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false })).toEqual({ written: true });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_A);
  });

  it("leaves no staging file behind", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false });
    writeSession("claude-code", "s-1", entry(AGENT_B), { overwrite: false });
    expect(readdirSync(sessionsDir())).toEqual([`${sessionKey("claude-code", "s-1")}.json`]);
  });

  it("deletes files older than a week when it writes", () => {
    writeSession("claude-code", "old", entry(AGENT_A), { overwrite: false });
    writeSession("claude-code", "recent", entry(AGENT_A), { overwrite: false });
    const stale = new Date(Date.now() - SESSION_CACHE_MAX_AGE_MS - 60_000);
    utimesSync(fileFor("old"), stale, stale);
    writeSession("claude-code", "new", entry(AGENT_B), { overwrite: false });
    expect(readSession("claude-code", "old")).toBeNull();
    expect(readSession("claude-code", "recent")?.agent_id).toBe(AGENT_A);
    expect(readSession("claude-code", "new")?.agent_id).toBe(AGENT_B);
  });

  it("lets a stale entry for the same session be replaced without overwrite", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false });
    const stale = new Date(Date.now() - SESSION_CACHE_MAX_AGE_MS - 60_000);
    utimesSync(fileFor("s-1"), stale, stale);
    // pruned first, so a week-old agent doesn't block the session's new one
    expect(writeSession("claude-code", "s-1", entry(AGENT_B), { overwrite: false })).toEqual({ written: true });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_B);
  });

  it("throws a CliError, and writes nothing, when the folder is not usable", () => {
    // A file where the sessions folder's parent must be.
    const parent = join(sessionsDir(), "..");
    mkdirSync(join(parent, ".."), { recursive: true });
    writeFileSync(parent, "in the way");
    expect(() => writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false })).toThrow(CliError);
  });

  it("rejects a malformed agent id or a harness mismatch as a programming error", () => {
    expect(() => writeSession("claude-code", "s", entry("not-a-uuid"), { overwrite: true })).toThrow(TypeError);
    expect(() => writeSession("codex", "s", entry(AGENT_A), { overwrite: true })).toThrow(TypeError);
  });
});

describe("writeSession with a seat", () => {
  const seat = { origin: "https://jubarte.ai", seatId: "seat-1", token: "jba_FAKEFAKEFAKEFAKEFAKEFAKE0001" };

  it("replaces a valid entry written for another seat or origin, but never one for this seat", () => {
    writeSession("claude-code", "s-1", entry(AGENT_A, { seat_id: "seat-other" }), { overwrite: false });
    expect(writeSession("claude-code", "s-1", entry(AGENT_B), { overwrite: false, seat })).toEqual({ written: true });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_B);
    expect(writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false, seat })).toEqual({ written: false });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_B);
    expect(writeSession("claude-code", "s-1", entry(AGENT_A), { overwrite: false, seat: { ...seat, origin: "http://127.0.0.1:3000" } })).toEqual({ written: true });
  });

  it("round-trips key_fp and rejects a malformed one", () => {
    writeSession("claude-code", "s-1", { ...entry(AGENT_A, { seat_id: null }), key_fp: "0123abcd" }, { overwrite: true });
    expect(readSession("claude-code", "s-1")?.key_fp).toBe("0123abcd");
    writeFileSync(fileFor("s-1"), JSON.stringify({ ...readSession("claude-code", "s-1"), key_fp: "ZZ" }), { mode: 0o600 });
    expect(readSession("claude-code", "s-1")).toBeNull();
  });
});

describe("readSession", () => {
  it("treats an entry written for another harness, a bad version or a bad field as a miss", () => {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    const good = { version: 1, harness: "claude-code", agent_id: AGENT_A, seat_id: null, origin: "https://jubarte.ai", created_at: "t", updated_at: "t" };
    const bad: Array<Record<string, unknown>> = [
      { ...good, harness: "codex" },
      { ...good, version: 2 },
      { ...good, agent_id: "nope" },
      { ...good, origin: "http://evil.example" },
      { ...good, seat_id: 5 },
      { ...good, name: "" },
    ];
    for (const value of bad) {
      writeFileSync(fileFor("s-1"), JSON.stringify(value), { mode: 0o600 });
      expect(readSession("claude-code", "s-1")).toBeNull();
    }
    writeFileSync(fileFor("s-1"), JSON.stringify(good), { mode: 0o600 });
    expect(readSession("claude-code", "s-1")?.agent_id).toBe(AGENT_A);
  });

  it.skipIf(process.platform === "win32")("does not follow a symbolic link", () => {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    const elsewhere = join(sandbox.dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, harness: "claude-code", agent_id: AGENT_A, seat_id: null, origin: "https://jubarte.ai", created_at: "t", updated_at: "t" }));
    symlinkSync(elsewhere, fileFor("s-1"));
    expect(readSession("claude-code", "s-1")).toBeNull();
  });

  it("ignores an oversized file", () => {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(fileFor("s-1"), " ".repeat(20_000), { mode: 0o600 });
    expect(readSession("claude-code", "s-1")).toBeNull();
  });
});
