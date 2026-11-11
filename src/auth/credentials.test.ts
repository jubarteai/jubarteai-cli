import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { readCredentials, readCredentialsReport, removeSeat, saveSeat } from "./credentials.js";
import type { StoredSeat } from "./credentials.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "TMPDIR"] as const;
const FAKE_TOKEN = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const posix = process.platform !== "win32";

let sandbox: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-creds-")));
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
  return process.platform === "win32"
    ? join(sandbox, "AppData", "jubarteai", "credentials.json")
    : join(sandbox, ".config", "jubarteai", "credentials.json");
}

function seatFor(n: number, overrides: Partial<StoredSeat> = {}): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token: `${FAKE_TOKEN}${n}`,
    minted_by: "cli",
    key: { id: `00000000-0000-4000-8000-00000000000${n}`, prefix: `jba_FAKE000${n}`, name: `CLI · host · ${n}` },
    user: { id: `11111111-0000-4000-8000-00000000000${n}`, email: `user${n}@example.com` },
    company: { id: `22222222-0000-4000-8000-00000000000${n}`, slug: `acme${n}`, name: `Acme ${n}` },
    saved_at: `2026-11-1${n}T10:00:00.000Z`,
    ...overrides,
  };
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

describe("readCredentials", () => {
  it("returns an empty store when the file is missing", () => {
    expect(readCredentials()).toEqual({ version: 1, default_seat: null, seats: {} });
    expect(existsSync(credsFile())).toBe(false);
  });

  it("refuses an unknown version and writes nothing", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 2, default_seat: null, seats: {} });
    writeFileSync(credsFile(), body, { mode: 0o600 });
    const error = thrown(() => readCredentials());
    expect(error.message).toBe("Upgrade jubarteai to read this credentials file");
    expect(error.exitCode).toBe(1);
    expect(() => saveSeat("s1", seatFor(1), { makeDefault: true })).toThrow(/Upgrade jubarteai/);
    expect(readFileSync(credsFile(), "utf8")).toBe(body);
  });

  it("names the path but never echoes content for malformed JSON", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(credsFile(), `{"seats": {"a": {"token": "${FAKE_TOKEN}" oops`, { mode: 0o600 });
    const error = thrown(() => readCredentials());
    expect(error.message).toContain(credsFile());
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.message).not.toContain("oops");
  });

  it("skips a malformed seat and reports it, without failing the good one", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    const bad = { ...seatFor(2), origin: "http://evil.example.com" };
    writeFileSync(
      credsFile(),
      JSON.stringify({ version: 1, default_seat: "good", seats: { good: seatFor(1), bad } }),
      { mode: 0o600 },
    );
    const report = readCredentialsReport();
    expect(report.invalid_seats).toEqual(["bad"]);
    expect(Object.keys(report.credentials.seats)).toEqual(["good"]);
    expect(report.credentials.default_seat).toBe("good");
    expect(readCredentials().seats["bad"]).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(`${FAKE_TOKEN}2`);
  });

  it("reads a default_seat that names a skipped seat as null", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(
      credsFile(),
      JSON.stringify({ version: 1, default_seat: "bad", seats: { good: seatFor(1), bad: { ...seatFor(2), token: "" } } }),
      { mode: 0o600 },
    );
    const report = readCredentialsReport();
    expect(report.credentials.default_seat).toBeNull();
    expect(report.invalid_seats).toEqual(["bad"]);
  });

  it("a malformed top level still fails the whole store", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(credsFile(), JSON.stringify({ version: 1, seats: [] }), { mode: 0o600 });
    expect(thrown(() => readCredentials()).code).toBe("credentials_malformed");
    writeFileSync(credsFile(), JSON.stringify({ seats: {} }), { mode: 0o600 });
    expect(thrown(() => readCredentialsReport()).code).toBe("credentials_malformed");
  });

  it("skips a seat whose token is not a single printable header value, and prints a safe id", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    const bad = { ...seatFor(1), token: "jba_x\r\nX-Evil: 1" };
    writeFileSync(credsFile(), JSON.stringify({ version: 1, seats: { "bad\u001b[2J\u0085id": bad } }), { mode: 0o600 });
    const report = readCredentialsReport();
    expect(report.invalid_seats).toEqual(["bad?[2J?id"]);
    expect(report.credentials.seats).toEqual({});
  });

  it("a save keeps an unreadable entry it did not touch, and a remove can clear it", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    const bad = { future: "format" };
    writeFileSync(credsFile(), JSON.stringify({ version: 1, seats: { odd: bad } }), { mode: 0o600 });
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(JSON.parse(readFileSync(credsFile(), "utf8")).seats.odd).toEqual(bad);
    expect(readCredentialsReport().invalid_seats).toEqual(["odd"]);
    expect(removeSeat("odd")).toEqual({ removed: true, newDefault: "s1" });
    expect(readCredentialsReport().invalid_seats).toEqual([]);
  });

  it("saving over an unreadable entry's id replaces it (login again fixes it)", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(credsFile(), JSON.stringify({ version: 1, seats: { s1: { nope: 1 } } }), { mode: 0o600 });
    saveSeat("s1", seatFor(1), { makeDefault: true });
    const report = readCredentialsReport();
    expect(report.invalid_seats).toEqual([]);
    expect(report.credentials.seats["s1"]).toEqual(seatFor(1));
  });

  it("does not let a __proto__ seat id reach the prototype", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    const text = `{"version":1,"seats":{"__proto__":${JSON.stringify(seatFor(1))}}}`;
    writeFileSync(credsFile(), text, { mode: 0o600 });
    const credentials = readCredentials();
    expect(Object.getPrototypeOf(credentials.seats)).toBe(Object.prototype);
    expect(Object.keys(credentials.seats)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["token"]).toBeUndefined();
  });

  it("drops a default_seat that names no stored seat", () => {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(credsFile(), JSON.stringify({ version: 1, default_seat: "gone", seats: { s1: seatFor(1) } }), {
      mode: 0o600,
    });
    expect(readCredentials().default_seat).toBeNull();
  });
});

describe("saveSeat", () => {
  it("writes the spec format with mode 0600 in a 0700 directory", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(JSON.parse(readFileSync(credsFile(), "utf8"))).toEqual({
      version: 1,
      default_seat: "s1",
      seats: { s1: seatFor(1) },
    });
    if (posix) {
      expect(statSync(credsFile()).mode & 0o777).toBe(0o600);
      expect(statSync(join(credsFile(), "..")).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(credsFile(), ".."))).toEqual(["credentials.json"]);
  });

  it("tightens an older, looser credentials directory to 0700", () => {
    if (!posix) return;
    const dir = join(credsFile(), "..");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("moves the default only when asked, except that a first seat becomes the default", () => {
    saveSeat("s1", seatFor(1), { makeDefault: false });
    expect(readCredentials().default_seat).toBe("s1");
    saveSeat("s2", seatFor(2), { makeDefault: false });
    expect(readCredentials().default_seat).toBe("s1");
    saveSeat("s2", seatFor(2), { makeDefault: true });
    const credentials = readCredentials();
    expect(credentials.default_seat).toBe("s2");
    expect(Object.keys(credentials.seats).sort()).toEqual(["s1", "s2"]);
  });

  it("replaces a seat under the same id (re-login) without touching the others", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    saveSeat("s2", seatFor(2), { makeDefault: false });
    const renewed = seatFor(1, { token: `${FAKE_TOKEN}NEW` });
    saveSeat("s1", renewed, { makeDefault: true });
    const credentials = readCredentials();
    expect(credentials.seats["s1"]?.token).toBe(`${FAKE_TOKEN}NEW`);
    expect(credentials.seats["s2"]).toEqual(seatFor(2));
  });

  it("keeps a dashboard-minted seat's marker and a null key id", () => {
    const pasted = seatFor(1, { minted_by: "dashboard", key: { id: null, prefix: "jba_FAKE0001", name: "pasted" } });
    saveSeat("s1", pasted, { makeDefault: true });
    expect(readCredentials().seats["s1"]).toEqual(pasted);
  });

  it.skipIf(!posix)("refuses a symlinked credentials file and writes nothing through it", () => {
    const decoy = join(sandbox, "decoy.json");
    writeFileSync(decoy, "untouched");
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    symlinkSync(decoy, credsFile());
    const error = thrown(() => saveSeat("s1", seatFor(1), { makeDefault: true }));
    expect(error.code).toBe("credentials_unsafe");
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(readFileSync(decoy, "utf8")).toBe("untouched");
    expect(thrown(() => readCredentials()).code).toBe("credentials_unsafe");
  });

  it.skipIf(!posix)("refuses a credentials directory that is a symlink", () => {
    const real = join(sandbox, "real-config");
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(join(sandbox, ".config"), { recursive: true });
    symlinkSync(real, join(sandbox, ".config", "jubarteai"));
    expect(thrown(() => saveSeat("s1", seatFor(1), { makeDefault: true })).code).toBe("credentials_unsafe");
    expect(readdirSync(real)).toEqual([]);
  });

  it.skipIf(!posix)("refuses a credentials file with another hard link, without echoing it", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    linkSync(credsFile(), join(sandbox, "second-name.json"));
    const error = thrown(() => saveSeat("s2", seatFor(2), { makeDefault: true }));
    expect(error.code).toBe("credentials_unsafe");
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(Object.keys(JSON.parse(readFileSync(credsFile(), "utf8")).seats)).toEqual(["s1"]);
  });
});

describe("saveSeat validation", () => {
  it.each([
    ["an empty email", { user: { id: "u1", email: "" } }],
    ["an empty token", { token: "" }],
    ["a token with a newline", { token: "jba_x\ny" }],
    ["a non-https origin", { origin: "http://evil.example.com" }],
    ["an origin with a path", { origin: "https://jubarte.ai/x" }],
    ["an unknown minted_by", { minted_by: "other" as "cli" }],
    ["an empty slug", { company: { id: "c1", slug: "", name: "x" } }],
  ])("refuses %s and leaves the file byte-identical", (_name, override) => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    const before = readFileSync(credsFile(), "utf8");
    const error = thrown(() => saveSeat("s2", seatFor(2, override as Partial<StoredSeat>), { makeDefault: true }));
    expect(error).toMatchObject({ exitCode: 1, code: "credentials_invalid_seat" });
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(readFileSync(credsFile(), "utf8")).toBe(before);
  });

  it("creates no file when the very first save is invalid", () => {
    expect(() => saveSeat("s1", seatFor(1, { token: "" }), { makeDefault: true })).toThrow(CliError);
    expect(existsSync(credsFile())).toBe(false);
  });

  it("refuses an empty seat id", () => {
    expect(thrown(() => saveSeat("", seatFor(1), { makeDefault: true })).code).toBe("credentials_invalid_seat");
  });
});

describe("removeSeat", () => {
  it("deletes a non-default seat and keeps the default", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    saveSeat("s2", seatFor(2), { makeDefault: false });
    expect(removeSeat("s2")).toEqual({ removed: true, newDefault: "s1" });
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
  });

  it("moves a removed default to the most recently saved remaining seat", () => {
    saveSeat("old", seatFor(1, { saved_at: "2026-01-01T00:00:00.000Z" }), { makeDefault: false });
    saveSeat("newest", seatFor(2, { saved_at: "2026-09-01T00:00:00.000Z" }), { makeDefault: false });
    saveSeat("mid", seatFor(3, { saved_at: "2026-05-01T00:00:00.000Z" }), { makeDefault: false });
    saveSeat("current", seatFor(4, { saved_at: "2026-10-01T00:00:00.000Z" }), { makeDefault: true });
    expect(removeSeat("current")).toEqual({ removed: true, newDefault: "newest" });
    expect(readCredentials().default_seat).toBe("newest");
  });

  it("breaks a saved_at tie by seat id so the choice is deterministic", () => {
    const same = "2026-05-01T00:00:00.000Z";
    saveSeat("b", seatFor(1, { saved_at: same }), { makeDefault: false });
    saveSeat("a", seatFor(2, { saved_at: same }), { makeDefault: false });
    saveSeat("cur", seatFor(3), { makeDefault: true });
    expect(removeSeat("cur").newDefault).toBe("a");
  });

  it("clears the default (and omits the key) when the last seat goes", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(removeSeat("s1")).toEqual({ removed: true, newDefault: null });
    const onDisk = JSON.parse(readFileSync(credsFile(), "utf8"));
    expect(onDisk).toEqual({ version: 1, seats: {} });
    expect("default_seat" in onDisk).toBe(false);
  });

  it("reports an unknown seat without writing", () => {
    expect(removeSeat("nope")).toEqual({ removed: false, newDefault: null });
    expect(existsSync(credsFile())).toBe(false);
    saveSeat("s1", seatFor(1), { makeDefault: true });
    const before = readFileSync(credsFile(), "utf8");
    expect(removeSeat("nope")).toEqual({ removed: false, newDefault: "s1" });
    expect(readFileSync(credsFile(), "utf8")).toBe(before);
  });

  it("keeps seats of two users in one workspace apart", () => {
    const company = { id: "22222222-0000-4000-8000-000000000099", slug: "shared", name: "Shared" };
    saveSeat("a", seatFor(1, { company }), { makeDefault: true });
    saveSeat("b", seatFor(2, { company }), { makeDefault: false });
    removeSeat("a");
    const credentials = readCredentials();
    expect(Object.keys(credentials.seats)).toEqual(["b"]);
    expect(credentials.default_seat).toBe("b");
  });
});

describe("credentials lock", () => {
  const lockFile = (): string => join(credsFile(), "..", "credentials.lock");

  function plantLock(content: string, ageMs = 0): void {
    mkdirSync(join(credsFile(), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(), content, { mode: 0o600 });
    const when = new Date(Date.now() - ageMs);
    utimesSync(lockFile(), when, when);
  }

  it("is created 0600 while held and released after a save and after a failed one", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(existsSync(lockFile())).toBe(false);
    writeFileSync(credsFile(), "{ not json", { mode: 0o600 });
    expect(() => saveSeat("s2", seatFor(2), { makeDefault: true })).toThrow(CliError);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("waits, then fails with a fixed error when a live holder keeps the lock, writing nothing", () => {
    saveSeat("s1", seatFor(1), { makeDefault: true });
    const before = readFileSync(credsFile(), "utf8");
    plantLock(`99999 ${Date.now()} abc`);
    const started = Date.now();
    const error = thrown(() => saveSeat("s2", seatFor(2), { makeDefault: true }));
    expect(error).toMatchObject({ exitCode: 1, code: "credentials_locked" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(readFileSync(credsFile(), "utf8")).toBe(before);
    expect(readFileSync(lockFile(), "utf8")).toContain("99999");
    expect(() => removeSeat("s1")).toThrow(/Another jubarteai process/);
  }, 20_000);

  it("sweeps a lock older than 30 s once and proceeds", () => {
    plantLock(`99999 ${Date.now() - 31_000} abc`, 31_000);
    saveSeat("s1", seatFor(1), { makeDefault: true });
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
    expect(existsSync(lockFile())).toBe(false);
  });

  describe.skipIf(!posix)("two processes", () => {
    const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let compiled: string;

    // The children run the real code, transpiled into a scratch directory (as safe-edit's crash test does).
    beforeAll(() => {
      compiled = mkdtempSync(join(tmpdir(), "jba-creds-compiled-"));
      const queue = [join(SRC_DIR, "auth", "credentials.ts")];
      const seen = new Set<string>();
      for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (seen.has(file)) continue;
        seen.add(file);
        const code = readFileSync(file, "utf8");
        for (const m of code.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) queue.push(resolve(dirname(file), `${m[1]}.ts`));
        const out = ts.transpileModule(code, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const dest = join(compiled, file.slice(SRC_DIR.length + 1).replace(/\.ts$/, ".js"));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, out);
      }
      writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(compiled, "child.mjs"),
        `import { saveSeat } from "./auth/credentials.js";
const [prefix, count, seatJson] = process.argv.slice(2);
const base = JSON.parse(seatJson);
for (let i = 0; i < Number(count); i += 1) {
  saveSeat(prefix + "-" + i, { ...base, token: "jba_" + prefix + i }, { makeDefault: false });
}
`,
      );
    });

    afterAll(() => rmSync(compiled, { recursive: true, force: true }));

    function run(prefix: string, count: number): Promise<number | null> {
      return new Promise((done, fail) => {
        const child = spawn(process.execPath, [join(compiled, "child.mjs"), prefix, String(count), JSON.stringify(seatFor(1))], {
          env: { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, ".config") },
          stdio: "ignore",
        });
        child.on("error", fail);
        child.on("exit", (code) => done(code));
      });
    }

    it("interleaved saves for different seats both land (no lost update)", async () => {
      const codes = await Promise.all([run("a", 12), run("b", 12), run("c", 12)]);
      expect(codes).toEqual([0, 0, 0]);
      const ids = Object.keys(readCredentials().seats).sort();
      expect(ids).toHaveLength(36);
      expect(ids).toContain("a-11");
      expect(ids).toContain("b-0");
      expect(ids).toContain("c-11");
      expect(existsSync(join(credsFile(), "..", "credentials.lock"))).toBe(false);
    }, 60_000);
  });
});
