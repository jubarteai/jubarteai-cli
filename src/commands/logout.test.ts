import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCredentials, saveSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { logoutCommand } from "./logout.js";

const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const LINE = "This key still works until you revoke it in Dashboard → API keys.";

let sandbox: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-logout-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function seat(slug: string, email: string, token: string, savedAt: string): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token,
    minted_by: "cli",
    key: { id: `key-${slug}-${email}`, prefix: token.slice(0, 12), name: `CLI · host · ${slug}` },
    user: { id: `user-${email}`, email },
    company: { id: `company-${slug}`, slug, name: slug.toUpperCase() },
    saved_at: savedAt,
  };
}

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const code = await routeWith([logoutCommand], argv, { stdout, stderr, stdin: new PassThrough(), cwd: sandbox });
  return { code, out, err };
}

describe("logout", () => {
  it("removes the default seat and prints the revoke line", async () => {
    saveSeat("s1", seat("acme", "a@example.com", "jba_AAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-01T00:00:00Z"), { makeDefault: true });
    const result = await run(["logout"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(LINE);
    expect(result.err).toContain("Signed out of ACME (a@example.com)");
    expect(result.out).toBe("");
    expect(readCredentials().seats).toEqual({});
  });

  it("moves the default to the most recently saved seat that remains", async () => {
    saveSeat("s1", seat("acme", "a@example.com", "jba_AAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-01T00:00:00Z"), { makeDefault: true });
    saveSeat("s2", seat("beta", "a@example.com", "jba_BBBBBBBBBBBBBBBBBBBBBBBB", "2026-11-02T00:00:00Z"), { makeDefault: false });
    expect((await run(["logout"])).code).toBe(0);
    expect(readCredentials().default_seat).toBe("s2");
  });

  it("with --workspace removes that seat only", async () => {
    saveSeat("s1", seat("acme", "a@example.com", "jba_AAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-01T00:00:00Z"), { makeDefault: true });
    saveSeat("s2", seat("beta", "a@example.com", "jba_BBBBBBBBBBBBBBBBBBBBBBBB", "2026-11-02T00:00:00Z"), { makeDefault: false });
    const result = await run(["logout", "--workspace", "beta"]);
    expect(result.code).toBe(0);
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
    expect(readCredentials().default_seat).toBe("s1");
  });

  it("exits 5 when nothing is stored", async () => {
    const result = await run(["logout"]);
    expect(result.code).toBe(5);
    expect(result.err).toContain("Not signed in");
    expect(result.err).not.toContain(LINE);
  });

  it("exits 5 for a workspace with no saved login", async () => {
    saveSeat("s1", seat("acme", "a@example.com", "jba_AAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-01T00:00:00Z"), { makeDefault: true });
    const result = await run(["logout", "--workspace", "nope"]);
    expect(result.code).toBe(5);
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
  });

  it("asks which of two users in one workspace, and --email picks one", async () => {
    saveSeat("s1", seat("acme", "a@example.com", "jba_AAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-01T00:00:00Z"), { makeDefault: true });
    saveSeat("s2", seat("acme", "b@example.com", "jba_BBBBBBBBBBBBBBBBBBBBBBBB", "2026-11-02T00:00:00Z"), { makeDefault: false });
    const ambiguous = await run(["logout", "--workspace", "acme"]);
    expect(ambiguous.code).toBe(5);
    expect(ambiguous.err).toContain("a@example.com");
    expect(ambiguous.err).toContain("b@example.com");
    expect(Object.keys(readCredentials().seats)).toHaveLength(2);
    const picked = await run(["logout", "--workspace", "acme", "--email", "B@Example.com"]);
    expect(picked.code).toBe(0);
    expect(Object.keys(readCredentials().seats)).toEqual(["s1"]);
  });

  it("never prints a key", async () => {
    const token = "jba_SUPERSECRETSUPERSECRET01";
    saveSeat("s1", seat("acme", "a@example.com", token, "2026-11-01T00:00:00Z"), { makeDefault: true });
    const result = await run(["logout"]);
    expect(result.err + result.out).not.toContain(token);
  });
});
