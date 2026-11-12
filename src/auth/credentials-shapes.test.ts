import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../errors.js";
import { readCredentials, readCredentialsReport, saveSeat } from "./credentials.js";
import type { StoredSeat } from "./credentials.js";

// The credentials file is local, but anything can write it (an older CLI, a hand edit, a sync tool): every seat is
// validated field by field before its key reaches an Authorization header, and one bad seat is skipped and reported
// rather than locking the user out of the rest (spec §7.4). These tables break one field of one seat at a time, beside a
// good seat, against a baseline proved to load.

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "TMPDIR"] as const;
const TOKEN = "jba_SHAPESSHAPESSHAPESSHAPES";

let sandbox: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-creds-shapes-")));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
  process.env.APPDATA = join(sandbox, "AppData");
  process.env.TMPDIR = join(sandbox, "tmp");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function credsFile(): string {
  return process.platform === "win32" ? join(sandbox, "AppData", "jubarteai", "credentials.json") : join(sandbox, ".config", "jubarteai", "credentials.json");
}

function writeStore(store: unknown): string {
  mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
  const text = typeof store === "string" ? store : JSON.stringify(store);
  writeFileSync(credsFile(), text, { mode: 0o600 });
  return text;
}

function seat(n: number): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token: `${TOKEN}${n}`,
    minted_by: "cli",
    key: { id: `key-${n}`, prefix: "jba_SHAPESSH", name: `CLI · host · ${n}` },
    user: { id: `user-${n}`, email: `user${n}@example.com` },
    company: { id: `company-${n}`, slug: `acme${n}`, name: `Acme ${n}` },
    saved_at: "2026-11-11T10:00:00.000Z",
  };
}

const REMOVE = Symbol("remove");
function mutate(base: StoredSeat, path: string, value: unknown): unknown {
  const copy = structuredClone(base) as unknown as Record<string, unknown>;
  const parts = path.split(".");
  let at = copy;
  for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>;
  const last = parts[parts.length - 1] as string;
  if (value === REMOVE) delete at[last];
  else at[last] = value;
  return copy;
}

function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("readCredentialsReport: a stored seat, field by field", () => {
  it("the baseline loads, both seats, with the default kept", () => {
    writeStore({ version: 1, default_seat: "good", seats: { good: seat(1), probe: seat(2) } });
    const report = readCredentialsReport();
    expect(report.invalid_seats).toEqual([]);
    expect(report.credentials.seats).toEqual({ good: seat(1), probe: seat(2) });
    expect(report.credentials.default_seat).toBe("good");
  });

  const refused: ReadonlyArray<[string, unknown]> = [
    // Pinned to a bare origin (spec I2): no path, no trailing slash, https or loopback http only.
    ["origin", "https://jubarte.ai/"],
    ["origin", "https://jubarte.ai/api"],
    ["origin", "https://JUBARTE.AI"],
    ["origin", "http://jubarte.ai"],
    ["origin", "https://user:pw@jubarte.ai"],
    ["origin", 443],
    ["origin", REMOVE],
    // The token goes into an Authorization header: one printable ASCII value, at most 512 characters.
    ["token", ""],
    ["token", "jba_with space"],
    ["token", "jba_tab\there"],
    ["token", "jba_é"],
    ["token", `jba_${"x".repeat(509)}`],
    ["token", null],
    ["minted_by", "admin"],
    ["minted_by", REMOVE],
    ["key", "jba_SHAPESSH"],
    ["key.id", ""],
    ["key.id", 5],
    ["key.prefix", REMOVE],
    ["key.prefix", ""],
    ["key.name", 1],
    ["key.name", "n".repeat(4097)],
    ["user", null],
    ["user.id", ""],
    ["user.email", REMOVE],
    ["user.email", ""],
    ["user.email", "e".repeat(4097)],
    ["company", []],
    ["company.id", REMOVE],
    ["company.slug", ""],
    ["company.name", null],
    ["company.name", "c".repeat(4097)],
    ["saved_at", ""],
    ["saved_at", "2".repeat(65)],
    ["saved_at", 1731319200000],
  ];
  for (const [path, value] of refused) {
    it(`skips a seat whose ${path} is ${value === REMOVE ? "missing" : JSON.stringify(value).slice(0, 32)}, keeps the other, echoes no token`, () => {
      writeStore({ version: 1, default_seat: "good", seats: { good: seat(1), probe: mutate(seat(2), path, value) } });
      const report = readCredentialsReport();
      expect(report.invalid_seats).toEqual(["probe"]);
      expect(Object.keys(report.credentials.seats)).toEqual(["good"]);
      expect(report.credentials.default_seat).toBe("good");
      expect(JSON.stringify(report)).not.toContain(`${TOKEN}2`);
    });
  }

  const accepted: ReadonlyArray<[string, unknown]> = [
    ["origin", "http://127.0.0.1:3000"],
    ["origin", "http://localhost:3000"],
    ["minted_by", "dashboard"],
    ["key.id", null],
    ["key.name", ""],
    ["key.name", "n".repeat(4096)],
    ["company.name", ""],
    ["token", `jba_${"x".repeat(508)}`],
    ["saved_at", "2".repeat(64)],
  ];
  for (const [path, value] of accepted) {
    it(`loads a seat whose ${path} is ${JSON.stringify(value).slice(0, 32)} (a boundary or an allowed value)`, () => {
      writeStore({ version: 1, seats: { probe: mutate(seat(2), path, value) } });
      const report = readCredentialsReport();
      expect(report.invalid_seats).toEqual([]);
      expect(Object.keys(report.credentials.seats)).toEqual(["probe"]);
    });
  }

  it("a seat that is not an object, or a seat id longer than 128 characters, is skipped", () => {
    const longId = "s".repeat(129);
    writeStore({ version: 1, seats: { good: seat(1), str: "jba_x", arr: [seat(2)], nul: null, [longId]: seat(3), ["t".repeat(128)]: seat(4) } });
    const report = readCredentialsReport();
    expect(report.invalid_seats.sort()).toEqual(["arr", "nul", "s".repeat(128), "str"].sort());
    expect(Object.keys(report.credentials.seats).sort()).toEqual(["good", "t".repeat(128)].sort());
  });
});

describe("readCredentials: the file as a whole", () => {
  it("refuses a file over 1 MiB as malformed without reading it into the error", () => {
    const store = { version: 1, seats: { s1: seat(1) }, padding: "p".repeat(1024 * 1024) };
    writeStore(store);
    const error = thrown(() => readCredentials());
    expect({ exit: error.exitCode, code: error.code }).toEqual({ exit: 1, code: "credentials_malformed" });
    expect(error.message).toContain(credsFile());
    expect(error.message).not.toContain(TOKEN);
  });

  it("a file of exactly 1 MiB (the inclusive limit) still loads", () => {
    const base = JSON.stringify({ version: 1, seats: { s1: seat(1) }, padding: "" });
    writeStore({ version: 1, seats: { s1: seat(1) }, padding: "p".repeat(1024 * 1024 - Buffer.byteLength(base)) });
    expect(readFileSync(credsFile()).length).toBe(1024 * 1024);
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
  });

  it("a non-string default_seat, a version that is not a number, or a top level that is not an object is malformed; nothing is echoed", () => {
    for (const store of [
      { version: 1, default_seat: 7, seats: {} },
      { version: 1, default_seat: { id: "s1" }, seats: {} },
      { version: "1", seats: {} },
      [1, 2, 3],
      "\"jba_SHAPESSHAPESSHAPESSHAPES1\"",
    ]) {
      writeStore(store);
      const error = thrown(() => readCredentials());
      expect(error.code, JSON.stringify(store)).toBe("credentials_malformed");
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("a credentials path that is a folder is an unreadable file (exit 1), not an empty store a save would overwrite", () => {
    mkdirSync(credsFile(), { recursive: true, mode: 0o700 });
    const read = thrown(() => readCredentials());
    expect({ exit: read.exitCode, code: read.code }).toEqual({ exit: 1, code: "credentials_unreadable" });
    // The save must stop at its read, not reach the rename onto the folder (which would throw credentials_unwritable).
    const save = thrown(() => saveSeat("s1", seat(1), { makeDefault: true }));
    expect({ exit: save.exitCode, code: save.code }).toEqual({ exit: 1, code: "credentials_unreadable" });
  });
});
