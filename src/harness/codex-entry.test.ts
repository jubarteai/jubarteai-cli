import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StoredSeat } from "../auth/credentials.js";
import { INIT_COPY } from "../install/init-copy.js";
import { bearerIs, codexUpdateStep, codexUserFile, readCodexEntry, seatForBearer } from "./codex-entry.js";

const ORIGIN = "https://jubarte.example";
const URL_ = `${ORIGIN}/api/mcp`;
const OLD = "jba_OLDKEYOLDKEYOLDKEYOLDKEY01";
const NEW = "jba_NEWKEYNEWKEYNEWKEYNEWKEY02";

let home: string;
let file: string;
let savedHome: Record<string, string | undefined>;

beforeEach(() => {
  savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  home = realpathSync(mkdtempSync(join(tmpdir(), "jba-codexentry-")));
  // The write guard checks the file against the real home, so the sandbox is the home.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, ".codex"));
  file = codexUserFile(home, {});
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function seat(token: string, slug = "acme", origin = ORIGIN): StoredSeat {
  return {
    origin,
    token,
    minted_by: "cli",
    key: { id: "k", prefix: token.slice(0, 12), name: "CLI" },
    user: { id: "u", email: "ada@example.com" },
    company: { id: `c-${slug}`, slug, name: slug.toUpperCase() },
    saved_at: "2026-11-01T00:00:00.000Z",
  };
}

const FORMS: Array<[string, string]> = [
  ["an inline double-quoted header", `[mcp_servers.jubarteai]\nurl = "${URL_}"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`],
  ["an inline single-quoted header", `[mcp_servers.jubarteai]\nurl = "${URL_}"\nhttp_headers = { 'Authorization' = 'Bearer ${OLD}' }\n`],
  ["an inline lowercase header", `[mcp_servers.jubarteai]\nurl = "${URL_}"\nhttp_headers = { "authorization" = "Bearer ${OLD}" }\n`],
  ["a header table", `[mcp_servers.jubarteai]\nurl = "${URL_}"\n\n[mcp_servers.jubarteai.http_headers]\nAuthorization = "Bearer ${OLD}"\n`],
  ["a header table with a lowercase key", `[mcp_servers.jubarteai]\nurl = "${URL_}"\n\n[mcp_servers.jubarteai.http_headers]\nauthorization = "Bearer ${OLD}"\n`],
];

describe("readCodexEntry", () => {
  it.each(FORMS)("reads the url and the key from %s", (_name, text) => {
    writeFileSync(file, `model = "o4"\n\n${text}\n[other]\nx = 1\n`);
    expect(readCodexEntry(file)).toEqual({ url: URL_, bearer: OLD });
  });

  it("answers null for a missing file or no jubarteai table, and null parts for an entry with no key", () => {
    expect(readCodexEntry(file)).toBeNull();
    writeFileSync(file, `model = "o4"\n`);
    expect(readCodexEntry(file)).toBeNull();
    writeFileSync(file, `[mcp_servers.jubarteai]\nurl = "${URL_}"\nbearer_token_env_var = "JUBARTEAI_TOKEN"\n`);
    expect(readCodexEntry(file)).toEqual({ url: URL_, bearer: null });
  });
});

describe("keys by digest", () => {
  it("bearerIs compares keys without comparing text", () => {
    expect(bearerIs(OLD, OLD)).toBe(true);
    expect(bearerIs(OLD, NEW)).toBe(false);
  });

  it("seatForBearer finds the stored seat holding the key at the same origin only", () => {
    const seats = { a: seat(OLD, "acme"), b: seat(NEW, "beta"), c: seat("jba_FOREIGNKEYFOREIGNKEYFOREIGN1", "gamma", "https://other.example") };
    expect(seatForBearer(seats, URL_, NEW)?.seatId).toBe("b");
    expect(seatForBearer(seats, ORIGIN, OLD)?.seat.company.slug).toBe("acme");
    expect(seatForBearer(seats, URL_, "jba_UNKNOWNKEYUNKNOWNKEYUNKNOWN1")).toBeUndefined();
    expect(seatForBearer(seats, "https://other.example/api/mcp", OLD)).toBeUndefined();
    expect(seatForBearer(seats, "not a url", OLD)).toBeUndefined();
  });
});

describe("codexUpdateStep", () => {
  const step = (token = NEW) => codexUpdateStep({ home, env: {} }, seat(token), URL_);

  it.each(FORMS)("rewrites the key in %s and nothing else", async (_name, text) => {
    const original = `model = "o4"\n\n${text}\n[other]\nx = 1\n`;
    writeFileSync(file, original);
    const result = await step().apply();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "configured" });
    // A single-quoted value comes back double-quoted (still valid TOML); everything else is byte-identical.
    expect(readFileSync(file, "utf8")).toBe(original.replace(`'Bearer ${OLD}'`, `"Bearer ${NEW}"`).replace(OLD, NEW));
    expect(readCodexEntry(file)?.bearer).toBe(NEW);
  });

  it("is a sensitive step with a preview that holds no key", () => {
    const planned = step();
    expect(planned.sensitive).toBe(true);
    expect(planned.preview).not.toMatch(/jba_/);
  });

  it("reports a key that isn't in a readable header form as skipped and leaves the file alone", async () => {
    const original = `[mcp_servers.jubarteai]\nurl = "${URL_}"\nbearer_token_env_var = "JUBARTEAI_TOKEN"\n`;
    writeFileSync(file, original);
    const result = await step().apply();
    expect(result).toMatchObject({ status: "skipped", detail: INIT_COPY.codexUnreadableReason });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("rewrites only an entry whose url is exactly the account's", async () => {
    const original = `[mcp_servers.jubarteai]\nurl = "https://other.example/api/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`;
    writeFileSync(file, original);
    expect((await step().apply()).status).toBe("already configured");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("refuses a saved key of an unexpected shape", async () => {
    writeFileSync(file, FORMS[0]?.[1] ?? "");
    const result = await codexUpdateStep({ home, env: {} }, seat("not-a-key"), URL_).apply();
    expect(result).toMatchObject({ status: "failed", detail: INIT_COPY.codexKeyShape });
  });
});
