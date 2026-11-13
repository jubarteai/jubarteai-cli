import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { writeBinding } from "../binding/binding.js";
import { routeWith } from "../cli/router.js";
import { credentialsPath } from "../paths.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { writeSession } from "../session/cache.js";
import { statusCommand } from "./status.js";

const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "JUBARTEAI_TOKEN", "JUBARTEAI_URL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"] as const;
const TOKEN_A = "jba_SECRETAAAAAAAAAAAAAAAAAA01";
const TOKEN_B = "jba_SECRETBBBBBBBBBBBBBBBBBB02";
const AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let sandbox: string;
let repo: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-status-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.TMPDIR = join(sandbox, "tmp");
  mkdirSync(process.env.TMPDIR);
  for (const name of ["XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[name];
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  resetEnvTokenForTests();
});

afterEach(() => {
  resetEnvTokenForTests();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function seat(slug: string, email: string, token: string, mintedBy: "cli" | "dashboard" = "cli", savedAt = "2026-11-01T00:00:00Z"): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token,
    minted_by: mintedBy,
    key: { id: `key-${slug}`, prefix: token.slice(0, 12), name: `CLI · host · ${slug}` },
    user: { id: `user-${email}`, email },
    company: { id: `company-${slug}`, slug, name: slug === "acme" ? "Acme Inc" : slug.toUpperCase() },
    saved_at: savedAt,
  };
}

async function run(argv: string[], cwd = repo) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const code = await routeWith([statusCommand], argv, { stdout, stderr, stdin: new PassThrough(), cwd });
  return { code, out, err };
}

describe("status", () => {
  it("says so when nothing is stored, and still reports the folder", async () => {
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Saved logins: none. Run: jubarteai login");
    expect(result.out).toContain("Repo binding: none for this folder");
    expect(result.out).toContain("Not signed in. Run: jubarteai login");
    expect(result.out).toContain("Session agent: not in a known agent session");
    expect(result.err).toBe("");
  });

  it("lists every seat with user, workspace, key name and prefix, marks the default, and never prints a key", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: false });
    saveSeat("s2", seat("beta", "b@example.com", TOKEN_B, "dashboard"), { makeDefault: true });
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("a@example.com — Acme Inc (acme)");
    expect(result.out).toContain("b@example.com — BETA (beta)  [default]");
    expect(result.out).toContain("CLI · host · acme");
    expect(result.out).toContain(TOKEN_A.slice(0, 12));
    expect(result.out).toContain("browser login");
    expect(result.out).toContain("pasted dashboard key");
    for (const text of [result.out, result.err]) {
      expect(text).not.toContain(TOKEN_A);
      expect(text).not.toContain(TOKEN_B);
      expect(text).not.toContain(TOKEN_A.slice(13));
    }
  });

  it("shows the repo binding and the seat it resolves to", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    saveSeat("s2", seat("beta", "b@example.com", TOKEN_B), { makeDefault: false });
    writeBinding(repo, { workspace: { id: "company-beta", slug: "beta" }, email: "b@example.com", shared: false });
    const result = await run(["status"]);
    expect(result.out).toContain("Repo binding: workspace beta as b@example.com (private,");
    expect(result.out).toContain("This folder would use: b@example.com — beta (from binding)");
  });

  const worktreeIt = process.platform === "win32" ? it.skip : it;
  function worktreeOfRepo(): string {
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q");
    git("commit", "--allow-empty", "-q", "-m", "init");
    const tree = join(sandbox, "wt");
    git("worktree", "add", "-q", tree);
    return realpathSync(tree);
  }

  worktreeIt("says a worktree's binding comes from the main checkout, and --json adds binding.inherited_from", async () => {
    saveSeat("s1", seat("beta", "b@example.com", TOKEN_B), { makeDefault: true });
    const tree = worktreeOfRepo();
    writeBinding(repo, { workspace: { id: "company-beta", slug: "beta" }, email: "b@example.com", shared: false });
    const text = await run(["status"], tree);
    expect(text.out).toContain("Repo binding: workspace beta as b@example.com (private,");
    expect(text.out).toContain("from the main checkout");
    const json = JSON.parse((await run(["status", "--json"], tree)).out) as { binding: Record<string, unknown> };
    expect(json.binding["inherited_from"]).toBe(tree);
    const own = JSON.parse((await run(["status", "--json"], repo)).out) as { binding: Record<string, unknown> };
    expect("inherited_from" in own.binding).toBe(false);
  });

  it("reports the resolution error text when the binding has no stored seat", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    writeBinding(repo, { workspace: { id: "company-gamma", slug: "gamma" }, email: "a@example.com", shared: false });
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("This repo uses workspace gamma as a@example.com. Run: jubarteai login --workspace gamma");
  });

  it("reports a binding that can't be read instead of failing", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    mkdirSync(join(repo, ".jubarteai"));
    writeFileSync(join(repo, ".jubarteai", "config.json"), "{ nope");
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Repo binding: unreadable.");
  });

  it("honours --workspace for the seat it resolves to", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    saveSeat("s2", seat("beta", "b@example.com", TOKEN_B), { makeDefault: false });
    const result = await run(["status", "--workspace", "beta"]);
    expect(result.out).toContain("This folder would use: b@example.com — beta (from flag)");
  });

  it("names the environment key without printing it", async () => {
    process.env.JUBARTEAI_TOKEN = TOKEN_A;
    const result = await run(["status"]);
    expect(result.out).toContain("the key in JUBARTEAI_TOKEN (not saved), sent to https://jubarte.ai");
    expect(result.out).not.toContain(TOKEN_A);
    const json = await run(["status", "--json"]);
    expect(json.out).not.toContain(TOKEN_A);
  });

  it("lists unreadable seat entries and keeps the readable ones", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    const path = credentialsPath();
    const doc = JSON.parse((await import("node:fs")).readFileSync(path, "utf8")) as { seats: Record<string, unknown> };
    doc.seats["broken-seat"] = { origin: "nope" };
    writeFileSync(path, JSON.stringify(doc));
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("a@example.com");
    expect(result.out).toContain("Unreadable entries (skipped): broken-seat");
  });

  it("reports a credentials file it can't read, exits 1, and still shows the rest", async () => {
    // The config folder is ~/.config/jubarteai on POSIX and %APPDATA%\\jubarteai on Windows.
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), `{ "token": "${TOKEN_A}" nope`);
    const result = await run(["status"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Saved logins: unreadable.");
    expect(result.out).toContain("Repo binding: none");
    expect(result.out).not.toContain(TOKEN_A);
  });

  it("neutralises terminal escapes in stored values", async () => {
    saveSeat("s1", seat("acme", "a\u001b[31m@example.com", TOKEN_A), { makeDefault: true });
    const result = await run(["status"]);
    expect(result.out).not.toContain("\u001b");
    expect(result.out).toContain("a?[31m@example.com");
  });

  it("shows the cached session agent, or says there is none yet", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "session-1";
    const none = await run(["status"]);
    expect(none.out).toContain("Session agent: none yet for this claude-code session");
    writeSession("claude-code", "session-1", { harness: "claude-code", agent_id: AGENT, seat_id: "s1", origin: "https://jubarte.ai", name: "swift-otter" }, { overwrite: false });
    const result = await run(["status"]);
    expect(result.out).toContain(`Session agent: ${AGENT} (swift-otter) in claude-code`);
  });

  it("hides a cached agent that belongs to another workspace or origin", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    process.env.CLAUDE_CODE_SESSION_ID = "session-3";
    writeSession("claude-code", "session-3", { harness: "claude-code", agent_id: AGENT, seat_id: "some-other-seat", origin: "https://jubarte.ai" }, { overwrite: false });
    const result = await run(["status"]);
    expect(result.out).toContain("Session agent: belongs to another workspace than this folder uses");
    expect(result.out).not.toContain(AGENT);
    const json = JSON.parse((await run(["status", "--json"])).out) as { session: { agent_id: string | null; other_workspace: boolean } };
    expect(json.session).toMatchObject({ agent_id: null, other_workspace: true });

    writeSession("claude-code", "session-3", { harness: "claude-code", agent_id: AGENT, seat_id: "s1", origin: "https://staging.example.com" }, { overwrite: true });
    expect((await run(["status"])).out).toContain("belongs to another workspace");

    writeSession("claude-code", "session-3", { harness: "claude-code", agent_id: AGENT, seat_id: "s1", origin: "https://jubarte.ai" }, { overwrite: true });
    expect((await run(["status"])).out).toContain(`Session agent: ${AGENT}`);
  });

  it("--json prints the same facts, compact by default and indented with --pretty, without any key", async () => {
    saveSeat("s1", seat("acme", "a@example.com", TOKEN_A), { makeDefault: true });
    process.env.CLAUDE_CODE_SESSION_ID = "session-2";
    writeSession("claude-code", "session-2", { harness: "claude-code", agent_id: AGENT, seat_id: "s1", origin: "https://jubarte.ai" }, { overwrite: false });
    writeBinding(repo, { workspace: { id: "company-acme", slug: "acme" }, email: "a@example.com", shared: true });

    const compact = await run(["status", "--json"]);
    expect(compact.code).toBe(0);
    expect(compact.out.trim().split("\n")).toHaveLength(1);
    const report = JSON.parse(compact.out) as {
      seats: Array<Record<string, unknown>>;
      binding: unknown;
      resolved: unknown;
      session: unknown;
    };
    expect(report.seats).toHaveLength(1);
    expect(report.seats[0]).toMatchObject({ seat_id: "s1", default: true, minted_by: "cli", user: { email: "a@example.com" }, company: { slug: "acme" } });
    expect(Object.keys(report.seats[0] ?? {})).not.toContain("token");
    expect(report.binding).toMatchObject({ found: true, workspace: { slug: "acme" }, shared: true });
    expect(report.resolved).toMatchObject({ seat_id: "s1", source: "binding", workspace: "acme" });
    expect(report.session).toMatchObject({ harness: "claude-code", agent_id: AGENT });
    expect(compact.out).not.toContain(TOKEN_A);

    const pretty = await run(["status", "--json", "--pretty"]);
    expect(pretty.out.split("\n").length).toBeGreaterThan(5);
    expect(JSON.parse(pretty.out)).toEqual(report);
  });

  it("takes no positional arguments", async () => {
    expect((await run(["status", "extra"])).code).toBe(2);
  });
});
