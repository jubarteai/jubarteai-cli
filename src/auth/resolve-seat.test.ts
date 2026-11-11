import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBinding } from "../binding/binding.js";
import { saveSeat } from "./credentials.js";
import type { StoredSeat } from "./credentials.js";
import type { ResolveError, ResolvedSeat } from "./resolve-seat.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "TMPDIR", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"] as const;
const ENV_TOKEN = "jba_ENVENVENVENVENVENVENVENVENVENV";
const FAKE = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKE";

const ACME = { id: "22222222-0000-4000-8000-0000000000a1", slug: "acme" };
const GLOBEX = { id: "22222222-0000-4000-8000-0000000000b2", slug: "globex" };

let sandbox: string;
let repo: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-resolve-")));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
  process.env.APPDATA = join(sandbox, "AppData");
  process.env.TMPDIR = join(sandbox, "tmp");
  delete process.env.JUBARTEAI_TOKEN;
  delete process.env.JUBARTEAI_URL;
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  gitInit(repo);
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  if (spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" }).status !== 0) throw new Error("git init failed");
}

/** A fresh copy of the module, so process-env's one-shot token cache starts empty for every test. */
async function resolve(opts: { workspace?: string; cwd?: string } = {}): Promise<ResolvedSeat | ResolveError> {
  const mod = await import("./resolve-seat.js");
  return mod.resolveSeat({ cwd: repo, ...opts });
}

const userIds: Record<string, string> = {
  "alice@example.com": "11111111-0000-4000-8000-0000000000a1",
  "bob@example.com": "11111111-0000-4000-8000-0000000000b2",
};

function seat(email: string, company: { id: string; slug: string }, n: number, extra: Partial<StoredSeat> = {}): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token: `${FAKE}${n}`,
    minted_by: "cli",
    key: { id: null, prefix: `jba_FAKE000${n}`, name: "CLI" },
    user: { id: userIds[email] ?? `11111111-0000-4000-8000-0000000000f${n}`, email },
    company: { id: company.id, slug: company.slug, name: company.slug.toUpperCase() },
    saved_at: `2026-11-0${n}T00:00:00.000Z`,
    ...extra,
  };
}

function ok(result: ResolvedSeat | ResolveError): ResolvedSeat {
  if ("error" in result) throw new Error(`unexpected resolve error: ${result.error}`);
  return result;
}

function fail(result: ResolvedSeat | ResolveError): ResolveError {
  if (!("error" in result)) throw new Error("expected a resolve error");
  return result;
}

// Two users, A and B, each with a seat in acme; A also has a seat in globex.
function seedTwoUsers(opts: { defaultSeat?: "a-globex" | "b-acme" } = {}): void {
  saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: false });
  saveSeat("b-acme", seat("bob@example.com", ACME, 2), { makeDefault: false });
  saveSeat("a-globex", seat("alice@example.com", GLOBEX, 3), { makeDefault: false });
  // Logging in last is what makes a seat the default.
  const last = opts.defaultSeat ?? "a-globex";
  saveSeat(last, last === "b-acme" ? seat("bob@example.com", ACME, 2) : seat("alice@example.com", GLOBEX, 3), {
    makeDefault: true,
  });
}

describe("default seat and no seat", () => {
  it("exits 5 with the login hint when nothing is stored", async () => {
    expect(fail(await resolve())).toEqual({ error: "Not signed in. Run: jubarteai login", exitCode: 5 });
  });

  it("uses the default seat and its stored origin and token", async () => {
    saveSeat("s1", seat("alice@example.com", ACME, 1, { origin: "http://127.0.0.1:3000" }), { makeDefault: true });
    const r = ok(await resolve());
    expect(r).toMatchObject({ seatId: "s1", origin: "http://127.0.0.1:3000", token: `${FAKE}1`, source: "default" });
    expect(r.seat?.company.slug).toBe("acme");
  });

  it("is not changed by JUBARTEAI_URL: a stored key is sent only to its own origin", async () => {
    saveSeat("s1", seat("alice@example.com", ACME, 1), { makeDefault: true });
    process.env.JUBARTEAI_URL = "https://other.example.com";
    expect(ok(await resolve()).origin).toBe("https://jubarte.ai");
  });
});

describe("an unreadable seat entry", () => {
  it("does not stop the readable seats from resolving", async () => {
    saveSeat("good", seat("alice@example.com", ACME, 1), { makeDefault: true });
    const path = join(sandbox, ".config", "jubarteai", "credentials.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seats.bad = { ...doc.seats.good, token: "" };
    writeFileSync(path, JSON.stringify(doc));
    expect(ok(await resolve())).toMatchObject({ seatId: "good", source: "default" });
    vi.resetModules();
    expect(fail(await resolve({ workspace: "nope" })).exitCode).toBe(5);
  });
});

describe("binding", () => {
  it("resolves two different users in one workspace by each repo's binding (private form)", async () => {
    seedTwoUsers();
    const repoB = join(sandbox, "repo-b");
    mkdirSync(repoB);
    gitInit(repoB);
    writeBinding(repo, { workspace: ACME, email: "alice@example.com", shared: false });
    writeBinding(repoB, { workspace: ACME, email: "bob@example.com", shared: false });
    const a = ok(await resolve({ cwd: repo }));
    expect(a).toMatchObject({ seatId: "a-acme", token: `${FAKE}1`, source: "binding" });
    vi.resetModules();
    const b = ok(await resolve({ cwd: repoB }));
    expect(b).toMatchObject({ seatId: "b-acme", token: `${FAKE}2`, source: "binding" });
  });

  it("resolves by the shared form too (email from config.local.json)", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: true });
    expect(ok(await resolve())).toMatchObject({ seatId: "b-acme", source: "binding" });
  });

  it("matches the email case-insensitively", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "BOB@Example.com", shared: false });
    expect(ok(await resolve()).seatId).toBe("b-acme");
  });

  it("beats the default seat", async () => {
    seedTwoUsers({ defaultSeat: "a-globex" });
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    expect(ok(await resolve()).seatId).toBe("b-acme");
  });

  it("works from a subfolder of the bound repo", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    mkdirSync(join(repo, "src", "x"), { recursive: true });
    expect(ok(await resolve({ cwd: join(repo, "src", "x") })).seatId).toBe("b-acme");
  });

  it("exits 5 with the login hint when no stored seat matches the bound user", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "carol@example.com", shared: false });
    expect(fail(await resolve())).toEqual({
      error: "This repo uses workspace acme as carol@example.com. Run: jubarteai login --workspace acme",
      exitCode: 5,
    });
  });

  it("does not fall back to the default seat when the bound workspace has no stored seat", async () => {
    saveSeat("a-globex", seat("alice@example.com", GLOBEX, 3), { makeDefault: true });
    writeBinding(repo, { workspace: ACME, email: "alice@example.com", shared: false });
    const e = fail(await resolve());
    expect(e.exitCode).toBe(5);
    expect(e.error).toBe("This repo uses workspace acme as alice@example.com. Run: jubarteai login --workspace acme");
  });

  it("a shared binding with no recorded user uses the only stored seat of the workspace", async () => {
    saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: true });
    writeBinding(repo, { workspace: ACME, email: "x@example.com", shared: true });
    rmSync(join(repo, ".jubarteai", "config.local.json"));
    expect(ok(await resolve())).toMatchObject({ seatId: "a-acme", source: "binding" });
  });

  it("a shared binding with no recorded user and two stored users picks the default's user", async () => {
    seedTwoUsers({ defaultSeat: "b-acme" });
    writeBinding(repo, { workspace: ACME, email: "x@example.com", shared: true });
    rmSync(join(repo, ".jubarteai", "config.local.json"));
    expect(ok(await resolve()).seatId).toBe("b-acme");
  });

  it("a shared binding with no recorded user and no way to choose between two users is exit 5 with both emails", async () => {
    saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: false });
    saveSeat("b-acme", seat("bob@example.com", ACME, 2), { makeDefault: false });
    saveSeat("c-globex", seat("carol@example.com", GLOBEX, 3), { makeDefault: true });
    writeBinding(repo, { workspace: ACME, email: "x@example.com", shared: true });
    rmSync(join(repo, ".jubarteai", "config.local.json"));
    const e = fail(await resolve());
    expect(e.exitCode).toBe(5);
    expect(e.emails).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("a shared binding with no stored seat in the workspace and no user says so", async () => {
    writeBinding(repo, { workspace: ACME, email: "x@example.com", shared: true });
    rmSync(join(repo, ".jubarteai", "config.local.json"));
    expect(fail(await resolve())).toEqual({
      error: "This repo uses workspace acme. Run: jubarteai login --workspace acme",
      exitCode: 5,
    });
  });

  it("a malformed binding is exit 2, not silently ignored", async () => {
    saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: true });
    mkdirSync(join(repo, ".jubarteai"), { recursive: true });
    writeFileSync(join(repo, ".jubarteai", "config.json"), "{ not json");
    const e = fail(await resolve());
    expect(e.exitCode).toBe(2);
    expect(e.error).not.toContain("not json");
  });

  it("an origin written into a binding changes nothing", async () => {
    saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: true });
    mkdirSync(join(repo, ".jubarteai"), { recursive: true });
    writeFileSync(
      join(repo, ".jubarteai", "config.json"),
      JSON.stringify({ version: 1, workspace: ACME, user: { email: "alice@example.com" }, origin: "https://evil.example.com" }),
    );
    expect(ok(await resolve()).origin).toBe("https://jubarte.ai");
  });
});

describe("--workspace", () => {
  it("picks the stored seat of that slug, beating the binding and the default", async () => {
    seedTwoUsers({ defaultSeat: "b-acme" });
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    expect(ok(await resolve({ workspace: "globex" }))).toMatchObject({
      seatId: "a-globex",
      source: "flag",
      origin: "https://jubarte.ai",
    });
  });

  it("exits 5 naming an unknown slug", async () => {
    seedTwoUsers();
    const e = fail(await resolve({ workspace: "nope" }));
    expect(e.exitCode).toBe(5);
    expect(e.error).toContain("nope");
  });

  it("does not echo control characters from the flag", async () => {
    const e = fail(await resolve({ workspace: "a\u001b[2Jb" }));
    expect(e.error).not.toContain("\u001b");
  });

  it("does not echo C1 control characters or DEL from the flag either", async () => {
    const e = fail(await resolve({ workspace: "a\u0085b\u009bc\u007fd" }));
    expect(e.error).toContain("a?b?c?d");
  });

  it("two users in the slug: prefers the binding's user", async () => {
    seedTwoUsers({ defaultSeat: "a-globex" });
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    expect(ok(await resolve({ workspace: "acme" })).seatId).toBe("b-acme");
  });

  it("two users in the slug: then the default seat's user", async () => {
    seedTwoUsers({ defaultSeat: "b-acme" });
    expect(ok(await resolve({ workspace: "acme" })).seatId).toBe("b-acme");
  });

  it("two users in the slug: the default's user is also considered when it is in another workspace", async () => {
    seedTwoUsers({ defaultSeat: "a-globex" });
    expect(ok(await resolve({ workspace: "acme" })).seatId).toBe("a-acme");
  });

  it("two users in the slug and nothing to prefer: exit 5 listing both emails", async () => {
    saveSeat("a-acme", seat("alice@example.com", ACME, 1), { makeDefault: false });
    saveSeat("b-acme", seat("bob@example.com", ACME, 2), { makeDefault: false });
    saveSeat("c-other", seat("carol@example.com", GLOBEX, 3), { makeDefault: true });
    const e = fail(await resolve({ workspace: "acme" }));
    expect(e.exitCode).toBe(5);
    expect(e.emails).toEqual(["alice@example.com", "bob@example.com"]);
    expect(e.error).toContain("alice@example.com");
    expect(e.error).toContain("bob@example.com");
  });

  it("a binding for another user does not break a one-match flag, even if the binding is malformed", async () => {
    seedTwoUsers();
    mkdirSync(join(repo, ".jubarteai"), { recursive: true });
    writeFileSync(join(repo, ".jubarteai", "config.json"), "garbage");
    expect(ok(await resolve({ workspace: "globex" })).seatId).toBe("a-globex");
  });
});

describe("JUBARTEAI_TOKEN", () => {
  it("is used as is, never saved, sent to the default origin, and removed from process.env", async () => {
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    const r = ok(await resolve());
    expect(r).toEqual({ seatId: null, origin: "https://jubarte.ai", token: ENV_TOKEN, source: "env", seat: null });
    expect(process.env.JUBARTEAI_TOKEN).toBeUndefined();
  });

  it("goes to JUBARTEAI_URL when set (normalized to an origin)", async () => {
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    process.env.JUBARTEAI_URL = "http://127.0.0.1:3000/some/path";
    expect(ok(await resolve()).origin).toBe("http://127.0.0.1:3000");
  });

  it("an invalid JUBARTEAI_URL is a usage error that never repeats the token", async () => {
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    process.env.JUBARTEAI_URL = "http://evil.example.com";
    const mod = await import("./resolve-seat.js");
    let message = "";
    let exitCode = 0;
    try {
      mod.resolveSeat({ cwd: repo });
    } catch (error) {
      message = (error as Error).message;
      exitCode = (error as { exitCode: number }).exitCode;
    }
    expect(exitCode).toBe(2);
    expect(message).not.toContain(ENV_TOKEN);
  });

  it("needs no credentials file and ignores a broken binding (CI)", async () => {
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    mkdirSync(join(repo, ".jubarteai"), { recursive: true });
    writeFileSync(join(repo, ".jubarteai", "config.json"), "garbage");
    expect(ok(await resolve()).source).toBe("env");
  });

  it("beats the binding and the default seat", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    expect(ok(await resolve())).toMatchObject({ source: "env", seatId: null });
  });

  it("loses to --workspace, and is still removed from process.env", async () => {
    seedTwoUsers();
    process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
    const r = ok(await resolve({ workspace: "globex" }));
    expect(r.source).toBe("flag");
    expect(r.token).toBe(`${FAKE}3`);
    expect(process.env.JUBARTEAI_TOKEN).toBeUndefined();
  });

  it("a blank value is treated as unset", async () => {
    process.env.JUBARTEAI_TOKEN = "   ";
    expect(fail(await resolve()).exitCode).toBe(5);
  });
});

describe("precedence, one tier at a time", () => {
  it("--workspace > env > binding > default", async () => {
    seedTwoUsers({ defaultSeat: "a-globex" });
    writeBinding(repo, { workspace: ACME, email: "bob@example.com", shared: false });
    const run = async (env: boolean, workspace?: string): Promise<ResolvedSeat> => {
      vi.resetModules();
      if (env) process.env.JUBARTEAI_TOKEN = ENV_TOKEN;
      else delete process.env.JUBARTEAI_TOKEN;
      return ok(await resolve(workspace === undefined ? {} : { workspace }));
    };
    expect((await run(true, "globex")).source).toBe("flag");
    expect((await run(true)).source).toBe("env");
    expect((await run(false)).source).toBe("binding");
    // Take the binding away: the default seat answers.
    rmSync(join(repo, ".jubarteai"), { recursive: true });
    expect(await run(false)).toMatchObject({ source: "default", seatId: "a-globex" });
  });
});

describe("secrets in messages", () => {
  it("no resolve error contains a stored or environment token", async () => {
    seedTwoUsers();
    writeBinding(repo, { workspace: ACME, email: "carol@example.com", shared: false });
    const errors = [fail(await resolve()), fail(await resolve({ workspace: "nope" }))];
    for (const e of errors) {
      expect(e.error).not.toContain(FAKE);
      expect(e.error).not.toContain(ENV_TOKEN);
    }
    expect(errors).toHaveLength(2);
  });
});
