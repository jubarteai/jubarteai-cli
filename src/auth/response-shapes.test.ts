import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../errors.js";
import { exchangeCode } from "./token-exchange.js";
import { whoami } from "./whoami.js";

// The two auth endpoints' 200 bodies are untrusted (spec §7.2, §7.3): every field is checked for type and length
// before anything is saved. These tables break one field at a time, against a baseline that is proved to parse, so a
// check that is dropped or loosened shows up as the one mutation that starts being accepted.

const KEY = "jba_RESPONSESHAPEKEY0001";
const CODE = `jbc_${"A".repeat(43)}`;
const VERIFIER = "v".repeat(43);
/** A string the parsers must never echo into an error. */
const LEAK = "LEAKED-SERVER-TEXT";
const FIELD_MAX = 512;

let server: Server;
let origin: string;
let answer: { status: number; body: unknown };
let seen: IncomingHttpHeaders[];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

beforeEach(() => {
  seen = [];
});

async function thrown(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

type Json = Record<string, unknown>;

/** A deep copy of `base` with `path` set to `value`, or removed when `value` is REMOVE. */
const REMOVE = Symbol("remove");
function mutate(base: Json, path: string, value: unknown): Json {
  const copy = structuredClone(base);
  const parts = path.split(".");
  let at: Json = copy;
  for (const part of parts.slice(0, -1)) at = at[part] as Json;
  const last = parts[parts.length - 1] as string;
  if (value === REMOVE) delete at[last];
  else at[last] = value;
  return copy;
}

const long = (n: number): string => "x".repeat(n);

function tokenBody(): Json {
  return {
    token: "jba_ABCDEFGHIJKLMNOPQRSTUV",
    key: { id: "k1", prefix: "jba_ABCDEFGH", name: "CLI · host · 2026-11-11" },
    seat_id: "s1",
    user: { id: "u1", email: "ada@example.com" },
    company: { id: "c1", slug: "acme", name: "Acme" },
    replaced: false,
  };
}

const exchange = () => exchangeCode(origin, { code: CODE, code_verifier: VERIFIER, replaces: null });

describe("exchangeCode: the 200 body, field by field", () => {
  it("the baseline parses, so every refusal below is the mutated field's", async () => {
    answer = { status: 200, body: tokenBody() };
    await expect(exchange()).resolves.toMatchObject({ seat_id: "s1", key: { id: "k1" }, replaced: false });
  });

  const refused: ReadonlyArray<[string, unknown]> = [
    ["token", REMOVE],
    ["token", 42],
    ["token", "jba_short"],
    ["token", `jba_${long(129)}`],
    ["token", "jba_with space in it"],
    ["token", "Bearer jba_ABCDEFGHIJKLMNOPQRSTUV"],
    ["token", "jba_ABCDEFGHIJKLMNOP\nX-Injected: 1"],
    ["key", REMOVE],
    ["key", ["k1"]],
    ["key", null],
    ["key.id", ""],
    ["key.id", 7],
    ["key.id", long(FIELD_MAX + 1)],
    ["key.prefix", REMOVE],
    ["key.prefix", ""],
    ["key.name", 7],
    ["key.name", long(FIELD_MAX + 1)],
    ["seat_id", REMOVE],
    ["seat_id", 1],
    ["seat_id", long(FIELD_MAX + 1)],
    ["user", REMOVE],
    ["user", "u1"],
    ["user.id", ""],
    ["user.email", ""],
    ["user.email", 1],
    ["user.email", REMOVE],
    ["user.email", long(FIELD_MAX + 1)],
    ["company", REMOVE],
    ["company.id", ""],
    ["company.slug", ""],
    ["company.slug", false],
    ["company.name", 3],
    ["company.name", long(FIELD_MAX + 1)],
    ["replaced", REMOVE],
    ["replaced", "false"],
    ["replaced", 0],
  ];
  for (const [path, value] of refused) {
    it(`refuses ${path} = ${value === REMOVE ? "(missing)" : JSON.stringify(value).slice(0, 40)}, without echoing the body`, async () => {
      const body = mutate(tokenBody(), path, value);
      answer = { status: 200, body: { ...body, note: LEAK } };
      const error = await thrown(exchange());
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 1, code: "unexpected_response" });
      expect(error.message).not.toContain(LEAK);
      expect(error.message).not.toContain("jba_ABCDEFGHIJKLMNOPQRSTUV");
    });
  }

  const accepted: ReadonlyArray<[string, unknown, (t: Awaited<ReturnType<typeof exchange>>) => unknown, unknown]> = [
    ["user.email", null, (t) => t.user.email, null],
    ["company.slug", null, (t) => t.company.slug, null],
    ["company.name", null, (t) => t.company.name, null],
    ["company.name", "", (t) => t.company.name, ""],
    ["key.name", "", (t) => t.key.name, ""],
    ["key.id", long(FIELD_MAX), (t) => t.key.id.length, FIELD_MAX],
    ["seat_id", long(FIELD_MAX), (t) => t.seat_id.length, FIELD_MAX],
    ["token", `jba_${long(128)}`, (t) => t.token.length, 132],
    ["token", "jba_12345678", (t) => t.token, "jba_12345678"],
  ];
  for (const [path, value, pick, expected] of accepted) {
    it(`accepts ${path} = ${JSON.stringify(value).slice(0, 30)} (a boundary or a documented null)`, async () => {
      answer = { status: 200, body: mutate(tokenBody(), path, value) };
      expect(pick(await exchange())).toEqual(expected);
    });
  }

  it("ignores unknown fields rather than refusing a newer server's answer", async () => {
    answer = { status: 200, body: { ...tokenBody(), future_field: { anything: [1, 2] } } };
    await expect(exchange()).resolves.toMatchObject({ seat_id: "s1" });
  });
});

describe("exchangeCode: statuses outside the documented set", () => {
  const cases: ReadonlyArray<[number, unknown, number, string]> = [
    [401, { error: "invalid_api_key" }, 1, "unexpected_response"],
    [404, "<html>not found</html>", 1, "unexpected_response"],
    [405, { error: "method_not_allowed" }, 1, "unexpected_response"],
    [429, { error: "rate_limited" }, 1, "unexpected_response"],
    [499, {}, 1, "unexpected_response"],
    // A 400 whose code is not the plain snake_case invalid_grant is the generic refusal, never a server-chosen code.
    [400, { error: "Invalid_Grant" }, 1, "invalid_request"],
    [400, { error: `invalid_grant ${LEAK}` }, 1, "invalid_request"],
    [400, "not json", 1, "invalid_request"],
    [503, {}, 4, "server_error"],
  ];
  for (const [status, body, exit, code] of cases) {
    it(`${status} ${JSON.stringify(body).slice(0, 40)} → exit ${exit} (${code})`, async () => {
      answer = { status, body };
      const error = await thrown(exchange());
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit, code });
      expect(error.message).not.toContain(LEAK);
    });
  }

  it("sends no Authorization header: the code and verifier are the credential", async () => {
    answer = { status: 200, body: tokenBody() };
    await exchange();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.["content-type"]).toBe("application/json");
  });
});

function whoamiBody(): Json {
  return {
    seat_id: "s1",
    user: { id: "u1", email: "ada@example.com" },
    company: { id: "c1", slug: "acme", name: "Acme" },
    key: { id: "k1", prefix: "jba_RESPONSE", name: "Laptop key", minted_by: "dashboard" },
  };
}

describe("whoami: the 200 body, field by field", () => {
  it("the baseline parses, and the key travels only as the bearer header", async () => {
    answer = { status: 200, body: whoamiBody() };
    await expect(whoami(origin, KEY)).resolves.toEqual(whoamiBody());
    expect(seen.map((headers) => headers.authorization)).toEqual([`Bearer ${KEY}`]);
  });

  const refused: ReadonlyArray<[string, unknown]> = [
    ["seat_id", REMOVE],
    ["seat_id", ""],
    ["user", REMOVE],
    ["user.id", 1],
    ["user.email", ""],
    ["user.email", 5],
    ["user.email", REMOVE],
    ["user.email", long(FIELD_MAX + 1)],
    ["company", []],
    ["company.id", ""],
    // Unlike the token response, whoami always knows the workspace: a null slug or name is malformed here.
    ["company.slug", null],
    ["company.slug", ""],
    ["company.name", null],
    ["company.name", long(FIELD_MAX + 1)],
    ["key", REMOVE],
    ["key.id", ""],
    ["key.prefix", null],
    ["key.name", 9],
    ["key.minted_by", REMOVE],
    ["key.minted_by", ""],
  ];
  for (const [path, value] of refused) {
    it(`refuses ${path} = ${value === REMOVE ? "(missing)" : JSON.stringify(value).slice(0, 40)}, without echoing the key or the body`, async () => {
      answer = { status: 200, body: { ...mutate(whoamiBody(), path, value), note: LEAK } };
      const error = await thrown(whoami(origin, KEY));
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 1, code: "unexpected_response" });
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(LEAK);
    });
  }

  it("accepts an empty workspace or key name and a null email", async () => {
    for (const [path, value] of [["company.name", ""], ["key.name", ""], ["user.email", null]] as const) {
      answer = { status: 200, body: mutate(whoamiBody(), path, value) };
      await expect(whoami(origin, KEY), path).resolves.toMatchObject({ seat_id: "s1" });
    }
  });

  it("a 401 carries the server's snake_case code (revoked vs invalid) and nothing else from the body", async () => {
    for (const [body, code] of [
      [{ error: "revoked_api_key", message: LEAK }, "revoked_api_key"],
      [{ error: "invalid_api_key" }, "invalid_api_key"],
      [{ error: `Not A Code ${LEAK}` }, "invalid_api_key"],
      ["", "invalid_api_key"],
    ] as const) {
      answer = { status: 401, body };
      const error = await thrown(whoami(origin, KEY));
      expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 3, code });
      expect(error.message).not.toContain(LEAK);
      expect(error.message).not.toContain(KEY);
    }
  });

  it("an undocumented status is an unexpected response (exit 1), not an auth failure", async () => {
    for (const status of [404, 405, 429]) {
      answer = { status, body: { error: "whatever" } };
      const error = await thrown(whoami(origin, KEY));
      expect({ exit: error.exitCode, code: error.code }, String(status)).toEqual({ exit: 1, code: "unexpected_response" });
    }
  });
});
