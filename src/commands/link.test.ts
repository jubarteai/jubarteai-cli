import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitSandbox, scriptedTty, sink } from "../../test/helpers/init-sandbox.js";
import type { InitSandbox } from "../../test/helpers/init-sandbox.js";
import { saveSeat } from "../auth/credentials.js";
import type { StoredSeat } from "../auth/credentials.js";
import { routeWith } from "../cli/router.js";
import { INIT_COPY } from "../install/init-copy.js";
import { linkCommand } from "./link.js";

vi.setConfig({ testTimeout: 60_000 });

const ACME = { id: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme Inc" };
const BETA = { id: "55555555-5555-4555-8555-555555555555", slug: "beta", name: "Beta LLC" };

let sb: InitSandbox;

beforeEach(() => {
  sb = createInitSandbox();
});

afterEach(() => {
  sb.restore();
});

function seat(company: typeof ACME, email: string, token: string, savedAt: string): StoredSeat {
  return {
    origin: "https://jubarte.ai",
    token,
    minted_by: "dashboard",
    key: { id: `key-${company.slug}`, prefix: token.slice(0, 12), name: "Dashboard key" },
    user: { id: `user-${email}`, email },
    company,
    saved_at: savedAt,
  };
}

function storeSeats(): void {
  saveSeat("seat-acme", seat(ACME, "ada@example.com", "jba_ACMEKEYACMEKEYACMEKEY0001", "2026-11-01T00:00:00.000Z"), { makeDefault: true });
  saveSeat("seat-beta", seat(BETA, "ada@example.com", "jba_BETAKEYBETAKEYBETAKEY0002", "2026-11-02T00:00:00.000Z"), { makeDefault: false });
}

async function run(argv: string[], cwd: string = sb.repo): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await routeWith([linkCommand], argv, { stdout: out.stream, stderr: err.stream, stdin: new PassThrough(), cwd });
  return { code, out: out.text(), err: err.text() };
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const configPath = (): string => join(sb.repo, ".jubarteai", "config.json");
const localPath = (): string => join(sb.repo, ".jubarteai", "config.local.json");

function bindPrivately(company: typeof ACME): void {
  mkdirSync(join(sb.repo, ".jubarteai"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ version: 1, workspace: { id: company.id, slug: company.slug }, user: { email: "ada@example.com" } }, null, 2) + "\n");
}

describe("link: rebinding", () => {
  it("--workspace rebinds the repo, keeps the private form and says what it was before", async () => {
    storeSeats();
    bindPrivately(ACME);
    const result = await run(["link", "--workspace", "beta"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toEqual({ version: 1, workspace: { id: BETA.id, slug: "beta" }, user: { email: "ada@example.com" } });
    expect(result.err).toContain("This repo is bound to workspace beta as ada@example.com (private binding).");
    expect(result.err).toContain("Before: workspace acme (private binding).");
    expect(result.out).toBe("");
  });

  it("keeps a shared form when it rebinds", async () => {
    storeSeats();
    bindPrivately(ACME);
    expect((await run(["link", "--share-binding"])).code).toBe(0);
    const result = await run(["link", "--workspace", "beta"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toEqual({ version: 1, workspace: { id: BETA.id, slug: "beta" } });
    expect(json(localPath())).toEqual({ version: 1, user: { email: "ada@example.com" } });
    expect(result.err).toContain("(shared binding)");
  });

  it("with no binding yet, a login and --workspace write a private one (never asked without a terminal)", async () => {
    storeSeats();
    const result = await run(["link", "--workspace", "acme"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toMatchObject({ workspace: { slug: "acme" }, user: { email: "ada@example.com" } });
    expect(readFileSync(join(sb.repo, ".gitignore"), "utf8")).toContain("# jubarteai: private workspace binding");
  });

  it("a second identical link changes nothing and says so", async () => {
    storeSeats();
    expect((await run(["link", "--workspace", "acme"])).code).toBe(0);
    const before = readFileSync(configPath(), "utf8");
    const again = await run(["link", "--workspace", "acme"]);
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(again.err).toContain(INIT_COPY.bindingUnchanged);
    expect(again.err).not.toContain("Before:");
  });

  it("uses the default login with no flags when there is no terminal", async () => {
    storeSeats();
    const result = await run(["link"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toMatchObject({ workspace: { slug: "acme" } });
  });

  it("offers the saved logins on a terminal, the bound one first, and asks the share question for a new binding", async () => {
    storeSeats();
    const tty = scriptedTty((p) => (p.startsWith(INIT_COPY.chooseAccount) ? "2" : p.startsWith(INIT_COPY.shareBindingQuestion) ? "y" : ""));
    const result = await run(["link"]);
    expect(result.code, result.err).toBe(0);
    expect(tty.prompts[0]).toContain("1) ada@example.com — Acme Inc");
    expect(tty.prompts[0]).toContain("2) ada@example.com — Beta LLC");
    expect(tty.prompts[1]).toBe(`${INIT_COPY.shareBindingQuestion} [y/N] `);
    expect(json(configPath())).toEqual({ version: 1, workspace: { id: BETA.id, slug: "beta" } });
    expect(json(localPath())).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("does not ask the share question when a binding exists or a flag is given", async () => {
    storeSeats();
    bindPrivately(ACME);
    const tty = scriptedTty(() => "");
    expect((await run(["link", "--workspace", "beta"])).code).toBe(0);
    expect(tty.prompts.some((p) => p.includes("Share this workspace binding"))).toBe(false);
  });
});

describe("link: converting the form", () => {
  it("--share-binding alone converts the binding without any login, moving the address out of config.json", async () => {
    bindPrivately(ACME);
    const result = await run(["link", "--share-binding"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toEqual({ version: 1, workspace: { id: ACME.id, slug: "acme" } });
    expect(json(localPath())).toEqual({ version: 1, user: { email: "ada@example.com" } });
    expect(readFileSync(join(sb.repo, ".jubarteai", ".gitignore"), "utf8")).toContain("config.local.json");
    expect(result.err).toContain("Switched the binding to the shared form.");
  });

  it("--private-binding alone converts it back, and a repeat is a no-op", async () => {
    bindPrivately(ACME);
    expect((await run(["link", "--share-binding"])).code).toBe(0);
    const back = await run(["link", "--private-binding"]);
    expect(back.code, back.err).toBe(0);
    expect(json(configPath())).toMatchObject({ workspace: { slug: "acme" }, user: { email: "ada@example.com" } });
    expect(existsSync(localPath())).toBe(false);
    const again = await run(["link", "--private-binding"]);
    expect(again.err).toContain(INIT_COPY.bindingUnchanged);
  });

  it("a tracked binding stays shared when asked to go private, and says why", async () => {
    bindPrivately(ACME);
    expect((await run(["link", "--share-binding"])).code).toBe(0);
    sb.git(["add", ".jubarteai/config.json"]);
    sb.git(["commit", "-q", "-m", "bind"]);
    const result = await run(["link", "--private-binding"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).not.toHaveProperty("user");
    expect(result.err).toContain(INIT_COPY.bindingKeptSharedTracked);
  });

  it("refuses both flags together, and nothing changes", async () => {
    bindPrivately(ACME);
    const before = readFileSync(configPath(), "utf8");
    const result = await run(["link", "--share-binding", "--private-binding"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(INIT_COPY.bindingConflict);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("a flag plus --workspace rebinds and sets the form", async () => {
    storeSeats();
    bindPrivately(ACME);
    const result = await run(["link", "--workspace", "beta", "--share-binding"]);
    expect(result.code, result.err).toBe(0);
    expect(json(configPath())).toEqual({ version: 1, workspace: { id: BETA.id, slug: "beta" } });
    expect(json(localPath())).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("a shared binding with no address recorded on this machine needs a login to convert", async () => {
    storeSeats();
    mkdirSync(join(sb.repo, ".jubarteai"));
    writeFileSync(configPath(), JSON.stringify({ version: 1, workspace: { id: BETA.id, slug: "beta" } }));
    const result = await run(["link", "--share-binding"]);
    expect(result.code, result.err).toBe(0);
    // the bound workspace's login is chosen, and the address lands in the ignored local file
    expect(json(localPath())).toMatchObject({ user: { email: "ada@example.com" } });
    expect(json(configPath())).toMatchObject({ workspace: { slug: "beta" } });
  });
});

describe("link: refusals", () => {
  it("with no saved login exits 5 with the sign-in hint", async () => {
    const result = await run(["link"]);
    expect(result.code).toBe(5);
    expect(result.err).toContain(INIT_COPY.notSignedIn);
    expect(existsSync(join(sb.repo, ".jubarteai"))).toBe(false);
  });

  it("an unknown --workspace exits 5 and names the login command", async () => {
    storeSeats();
    const result = await run(["link", "--workspace", "nope"]);
    expect(result.code).toBe(5);
    expect(result.err).toContain("No saved login for workspace nope. Run: jubarteai login --workspace nope");
  });

  it("from the home folder exits 2: a binding belongs to a repo", async () => {
    storeSeats();
    const result = await run(["link", "--workspace", "acme"], sb.home);
    expect(result.code).toBe(2);
    expect(result.err).toContain(INIT_COPY.linkNeedsProject);
    expect(existsSync(join(sb.home, ".jubarteai"))).toBe(false);
  });

  it("takes no positional arguments", async () => {
    storeSeats();
    expect((await run(["link", "acme"])).code).toBe(2);
  });

  it("never prints a key", async () => {
    storeSeats();
    const result = await run(["link", "--workspace", "beta"]);
    expect(result.err + result.out).not.toMatch(/jba_[A-Za-z0-9]/);
  });
});
