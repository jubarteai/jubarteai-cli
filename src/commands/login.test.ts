import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import type { FakeAuthServer } from "../../test/helpers/fake-auth-server.js";
import { readCredentials } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { keyDigest } from "../auth/key-digest.js";
import { CODEX_REVOKED_HINT } from "../install/init-copy.js";
import { routeWith } from "../cli/router.js";
import { DEFAULT_ORIGIN } from "../constants.js";
import { scriptedTty } from "../../test/helpers/init-sandbox.js";
import { setTtyOpenerForTests } from "../prompt.js";
import type { TtyHandle } from "../prompt.js";
import { loginCommand } from "./login.js";

const flowMock = vi.hoisted(() => ({ loginFlow: vi.fn() }));
vi.mock("../auth/login-flow.js", async (importActual) => {
  const actual = await importActual<typeof import("../auth/login-flow.js")>();
  return { ...actual, loginFlow: flowMock.loginFlow };
});

const KEY = "jba_DASHBOARDKEYDASHBOARDKEY01";
const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL", "CODEX_HOME"] as const;

let sandbox: string;
let fake: FakeAuthServer;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-logincmd-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.JUBARTEAI_URL;
  delete process.env.CODEX_HOME;
  fake = await startFakeAuthServer();
  flowMock.loginFlow.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  setTtyOpenerForTests(null);
  await fake.close();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function sink() {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => text };
}

async function run(argv: string[], stdin: NodeJS.ReadableStream = new PassThrough()) {
  const out = sink();
  const err = sink();
  const code = await routeWith([loginCommand], argv, { stdout: out.stream, stderr: err.stream, stdin, cwd: sandbox });
  return { code, out: out.text(), err: err.text() };
}

function piped(text: string): PassThrough {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

describe("login: browser flows", () => {
  it("runs the browser login at the default origin", async () => {
    flowMock.loginFlow.mockResolvedValue({ seatId: "seat-1", seat: {}, replacedDigest: null });
    const result = await run(["login"]);
    expect(result.code).toBe(0);
    expect(flowMock.loginFlow).toHaveBeenCalledTimes(1);
    expect(flowMock.loginFlow.mock.calls[0]?.[1]).toEqual({ origin: DEFAULT_ORIGIN, noBrowser: false, paste: false });
  });

  it("passes --workspace, --paste and --no-browser through, and JUBARTEAI_URL as the origin", async () => {
    flowMock.loginFlow.mockResolvedValue({ seatId: "seat-1", seat: {}, replacedDigest: null });
    process.env.JUBARTEAI_URL = "http://127.0.0.1:4010/some/path";
    const result = await run(["login", "--workspace", "acme", "--paste", "--no-browser"]);
    expect(result.code).toBe(0);
    expect(flowMock.loginFlow.mock.calls[0]?.[1]).toEqual({ origin: "http://127.0.0.1:4010", workspace: "acme", noBrowser: true, paste: true });
  });

  it("refuses an unusable JUBARTEAI_URL with exit 2 and without repeating it", async () => {
    process.env.JUBARTEAI_URL = "http://evil.example/?jba_SECRETSECRETSECRET01";
    const result = await run(["login"]);
    expect(result.code).toBe(2);
    expect(result.err).not.toContain("evil.example");
    expect(result.err).not.toContain("SECRET");
    expect(flowMock.loginFlow).not.toHaveBeenCalled();
  });

  it("takes no positional arguments", async () => {
    const result = await run(["login", "extra"]);
    expect(result.code).toBe(2);
    expect(flowMock.loginFlow).not.toHaveBeenCalled();
  });
});

describe("login: Codex's key after a re-login revoked the old one (R-M2)", () => {
  const OLD = "jba_OLDCLIKEYOLDCLIKEYOLDCLI01";
  const NEW = "jba_NEWCLIKEYNEWCLIKEYNEWCLI02";
  const codexFile = (): string => join(sandbox, ".codex", "config.toml");

  function entry(key: string, url: string = `${fake.origin}/api/mcp`): string {
    return `model = "o4"\n\n[mcp_servers.jubarteai]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }\n`;
  }

  function plantCodex(text: string): void {
    mkdirSync(join(sandbox, ".codex"), { recursive: true });
    writeFileSync(codexFile(), text);
  }

  function signedIn(replaced: string | null): void {
    const seat: StoredSeat = {
      origin: fake.origin,
      token: NEW,
      minted_by: "cli",
      key: { id: "k", prefix: NEW.slice(0, 12), name: "CLI" },
      user: { id: "u", email: "ada@example.com" },
      company: { id: "c", slug: "acme", name: "Acme Inc" },
      saved_at: "2026-11-10T00:00:00.000Z",
    };
    flowMock.loginFlow.mockResolvedValue({ seatId: "seat-1", seat, replacedDigest: replaced === null ? null : keyDigest(replaced) });
    process.env.JUBARTEAI_URL = fake.origin;
  }

  it("without a terminal or --yes, prints the fixed hint and leaves the entry alone", async () => {
    plantCodex(entry(OLD));
    signedIn(OLD);
    const result = await run(["login"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(CODEX_REVOKED_HINT);
    expect(readFileSync(codexFile(), "utf8")).toBe(entry(OLD));
    expect(result.err + result.out).not.toMatch(/jba_[A-Za-z0-9]/);
  });

  it("with --yes, rewrites the entry to the new key through the shared step, and prints no key and no hint", async () => {
    plantCodex(entry(OLD));
    signedIn(OLD);
    const result = await run(["login", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(codexFile(), "utf8")).toBe(entry(NEW));
    expect(result.err).not.toContain(CODEX_REVOKED_HINT);
    expect(result.err + result.out).not.toMatch(/jba_[A-Za-z0-9]/);
  });

  it("still prints the hint when --yes cannot apply the step (inside an agent's shell)", async () => {
    plantCodex(entry(OLD));
    signedIn(OLD);
    process.env.CLAUDECODE = "1";
    try {
      const result = await run(["login", "--yes"]);
      expect(result.code, result.err).toBe(0);
      expect(readFileSync(codexFile(), "utf8")).toBe(entry(OLD));
      expect(result.err).toContain(CODEX_REVOKED_HINT);
    } finally {
      delete process.env.CLAUDECODE;
    }
  });

  it("asks on a terminal (default yes) and rewrites on yes; a decline leaves it and prints the hint", async () => {
    for (const [answer, rewritten] of [["", true], ["n", false]] as const) {
      plantCodex(entry(OLD));
      signedIn(OLD);
      const tty = scriptedTty((prompt) => (prompt.startsWith("Proceed?") ? "y" : answer));
      const result = await run(["login"]);
      expect(tty.prompts.some((p) => p.startsWith('Apply "Update the key in Codex'))).toBe(true);
      expect(readFileSync(codexFile(), "utf8")).toBe(rewritten ? entry(NEW) : entry(OLD));
      expect(result.err.includes(CODEX_REVOKED_HINT)).toBe(!rewritten);
      expect(result.err + tty.shown()).not.toMatch(/jba_[A-Za-z0-9]/);
    }
  });

  it("does nothing when the entry holds a different key, another address, or nothing was revoked", async () => {
    const cases: Array<[string, string | null]> = [
      [entry("jba_SOMEOTHERKEYSOMEOTHERKEY001"), OLD],
      [entry(OLD, "https://other.example/api/mcp"), OLD],
      [entry(OLD), null],
    ];
    for (const [text, replaced] of cases) {
      plantCodex(text);
      signedIn(replaced);
      const result = await run(["login", "--yes"]);
      expect(result.code).toBe(0);
      expect(readFileSync(codexFile(), "utf8")).toBe(text);
      expect(result.err).not.toContain(CODEX_REVOKED_HINT);
    }
  });

  it("does nothing without a Codex config", async () => {
    signedIn(OLD);
    const result = await run(["login", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });
});

describe("login --with-token", () => {
  it("never takes the key from argv, and never echoes what was typed", async () => {
    for (const argv of [["login", "--with-token", KEY], [`login`, `--with-token=${KEY}`], ["login", "--with-token", "--", KEY]]) {
      fake.addKey(KEY);
      const result = await run(argv, piped(`${KEY}\n`));
      expect(result.code).toBe(2);
      expect(result.err).not.toContain(KEY);
      expect(result.out).not.toContain(KEY);
    }
    expect(fake.requests).toHaveLength(0);
    expect(() => readCredentials()).not.toThrow();
    expect(Object.keys(readCredentials().seats)).toHaveLength(0);
  });

  it("reads a piped key from stdin, checks it with whoami and saves it as a dashboard key", async () => {
    fake.addKey(KEY);
    process.env.JUBARTEAI_URL = fake.origin;
    const result = await run(["login", "--with-token"], piped(`${KEY}\n`));
    expect(result.code).toBe(0);
    expect(result.err).toBe("Signed in as ada@example.com — Acme Inc\n");
    expect(result.out).toBe("");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ path: "/api/cli/whoami", authorization: `Bearer ${KEY}` });
    const stored = readCredentials();
    expect(stored.default_seat).toBe(fake.identity.seat_id);
    expect(stored.seats[fake.identity.seat_id]).toMatchObject({ minted_by: "dashboard", token: KEY, origin: fake.origin });
  });

  it("trims whitespace and a trailing CRLF around a piped key", async () => {
    fake.addKey(KEY);
    process.env.JUBARTEAI_URL = fake.origin;
    const result = await run(["login", "--with-token"], piped(`  ${KEY}\r\n`));
    expect(result.code).toBe(0);
  });

  it("asks for the key with a hidden prompt when stdin is a terminal", async () => {
    fake.addKey(KEY);
    process.env.JUBARTEAI_URL = fake.origin;
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };
    input.isTTY = true;
    const rawCalls: boolean[] = [];
    input.setRawMode = (mode) => {
      rawCalls.push(mode);
      return input;
    };
    let shown = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        shown += chunk.toString("utf8");
        callback();
      },
    });
    const handle: TtyHandle = { input, output, close() {} };
    setTtyOpenerForTests(() => handle);
    input.write(`${KEY}\r`);
    const result = await run(["login", "--with-token"], input);
    expect(result.code).toBe(0);
    expect(rawCalls).toContain(true);
    expect(shown).not.toContain(KEY);
    expect(result.err).not.toContain(KEY);
  });

  it("uses only the first line of piped input", async () => {
    fake.addKey(KEY);
    process.env.JUBARTEAI_URL = fake.origin;
    const result = await run(["login", "--with-token"], piped(`${KEY}\nsecond line that is ignored\n`));
    expect(result.code).toBe(0);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("stops at the first newline without waiting for the pipe to close", async () => {
    fake.addKey(KEY);
    process.env.JUBARTEAI_URL = fake.origin;
    const open = new PassThrough();
    open.write(`${KEY}\n`);
    const result = await run(["login", "--with-token"], open);
    expect(result.code).toBe(0);
  });

  it("is a usage error when the first line alone is over 4 KB", async () => {
    const result = await run(["login", "--with-token"], piped(`${"x".repeat(5000)}\n${KEY}\n`));
    expect(result.code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it("gives up after 30 seconds on a pipe that never sends a line (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const silent = new PassThrough();
      const pending = run(["login", "--with-token"], silent);
      await vi.advanceTimersByTimeAsync(29_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.code).toBe(2);
      expect(result.err).toContain("Timed out waiting for a key on standard input.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a usage error when nothing is piped in", async () => {
    const result = await run(["login", "--with-token"], piped("   \n"));
    expect(result.code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it("is a usage error for input far too large to be a key, without echoing it", async () => {
    const result = await run(["login", "--with-token"], piped(`${KEY}${"x".repeat(10_000)}`));
    expect(result.code).toBe(2);
    expect(result.err).not.toContain(KEY);
  });

  it("is a usage error for text that is not a key", async () => {
    const result = await run(["login", "--with-token"], piped("hello there\n"));
    expect(result.code).toBe(2);
    expect(result.err).not.toContain("hello");
    expect(fake.requests).toHaveLength(0);
  });

  it("exits 3 and saves nothing for a key the server refuses", async () => {
    process.env.JUBARTEAI_URL = fake.origin;
    const result = await run(["login", "--with-token"], piped(`${KEY}\n`));
    expect(result.code).toBe(3);
    expect(result.err).not.toContain(KEY);
    expect(Object.keys(readCredentials().seats)).toHaveLength(0);
  });

  it("can't be combined with --paste, --no-browser or --workspace", async () => {
    for (const extra of [["--paste"], ["--no-browser"], ["--workspace", "acme"]]) {
      const result = await run(["login", "--with-token", ...extra], piped(`${KEY}\n`));
      expect(result.code).toBe(2);
    }
    expect(fake.requests).toHaveLength(0);
  });
});
