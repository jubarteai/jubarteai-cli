// R-M1: inside a coding agent's shell the commands that change the saved account or the repo binding refuse, whatever
// flags the agent passes, and nothing is read from stdin or written to disk first.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCredentials, saveSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { credentialsPath } from "../paths.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { initCommand } from "./init.js";
import { linkCommand } from "./link.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";

const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"] as const;
const KEY = "jba_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY = "jba_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const REFUSAL = /needs you, not an agent\. Run it yourself in a terminal\./;

let sandbox: string;
let saved: Record<string, string | undefined>;

function seat(slug: string, token: string): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token,
    minted_by: "cli",
    key: { id: `key-${slug}`, prefix: token.slice(0, 12), name: `CLI · host · ${slug}` },
    user: { id: "user-1", email: "a@example.com" },
    company: { id: `company-${slug}`, slug, name: slug.toUpperCase() },
    saved_at: "2026-11-01T00:00:00Z",
  };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-agent-guard-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.JUBARTEAI_TOKEN;
  delete process.env.JUBARTEAI_URL;
  resetEnvTokenForTests();
  saveSeat("s1", seat("acme", KEY), { makeDefault: true });
  vi.stubEnv("CLAUDECODE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetEnvTokenForTests();
  rmSync(sandbox, { recursive: true, force: true });
});

async function run(argv: string[], cwd: string = sandbox, stdinText?: string) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const stdin = new PassThrough();
  let read = false;
  stdin.on("resume", () => (read = true));
  if (stdinText !== undefined) stdin.end(stdinText);
  const code = await routeWith([initCommand, linkCommand, loginCommand, logoutCommand], argv, { stdout, stderr, stdin, cwd });
  return { code, out, err, read };
}

function credentialsText(): string {
  return readFileSync(credentialsPath(), "utf8");
}

describe("inside an agent session", () => {
  it("login --with-token refuses before reading the key from stdin", async () => {
    const before = credentialsText();
    const result = await run(["login", "--with-token"], sandbox, `${OTHER_KEY}\n`);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(REFUSAL);
    expect(result.read).toBe(false);
    expect(credentialsText()).toBe(before);
    expect(result.err + result.out).not.toContain(OTHER_KEY);
  });

  it("link refuses, with --yes too; a flag before the command is refused by the router before link runs (R-S8)", async () => {
    const repo = join(sandbox, "repo");
    mkdirSync(repo);
    for (const argv of [["link"], ["link", "--workspace", "acme", "--share-binding"], ["link", "--yes"]]) {
      const result = await run(argv, repo);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(REFUSAL);
    }
    const leading = await run(["--yes", "link"], repo);
    expect(leading.code).toBe(2);
    expect(leading.err).toContain("Put flags after the command name: jubarteai link [options].");
    expect(() => readFileSync(join(repo, ".jubarteai"), "utf8")).toThrow();
  });

  it("logout refuses and keeps the saved login", async () => {
    const result = await run(["logout"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(REFUSAL);
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
  });

  it("init with JUBARTEAI_TOKEN refuses to save the key", async () => {
    process.env.JUBARTEAI_TOKEN = OTHER_KEY;
    const before = credentialsText();
    const result = await run(["init", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(REFUSAL);
    expect(credentialsText()).toBe(before);
    expect(result.err + result.out).not.toContain(OTHER_KEY);
  });
});

describe("outside an agent session", () => {
  it("logout still works as before", async () => {
    vi.unstubAllEnvs();
    const result = await run(["logout"]);
    expect(result.code).toBe(0);
    expect(readCredentials().seats).toEqual({});
  });
});
