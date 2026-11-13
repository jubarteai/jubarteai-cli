// init then uninstall through the built binary: the machine and the repo come back to what they were, except for the
// skill copies the stub installer made (a hand copy is printed, never deleted) and the saved login, which uninstall
// removes unless asked not to. The key keeps working server-side: nothing here revokes it.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { loadPty, spawnPty } from "../helpers/pty.js";
import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { BIN, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const pty = loadPty();

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
});
afterEach(async () => {
  await fake.close();
  box.cleanup();
});

/** Every file under `dir` (relative path → content), without .git and without the stub call log. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue;
      const path = join(current, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) out[relative(dir, path).replaceAll("\\", "/")] = readFileSync(path, "utf8"); // "/" on every OS
    }
  };
  walk(dir);
  return out;
}

describe("init then uninstall", () => {
  test("--yes restores every file init touched, keeps the person's own settings, and signs out locally", async () => {
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)"] } }, null, 2) + "\n");
    writeFileSync(join(box.repo, "AGENTS.md"), "# Acme\n");
    const before = { home: snapshot(box.home), repo: snapshot(box.repo) };

    expect((await box.signInWithKey(fake)).code).toBe(0);
    const init = await box.run(["init", "--yes"], { env: { JUBARTEAI_URL: fake.origin } });
    expect(init.code, init.stderr).toBe(0);
    expect(snapshot(box.repo)).not.toEqual(before.repo);

    const out = await box.run(["uninstall", "--yes"], { env: { JUBARTEAI_URL: fake.origin } });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("This key still works until you revoke it in Dashboard → API keys.");
    expect(out.stderr).toContain("npm uninstall -g jubarteai");

    const after = { home: snapshot(box.home), repo: snapshot(box.repo) };
    // What differs from the start: the credentials (now empty or gone) and the stub installer's hand-copied skill folders.
    const ignored = (path: string): boolean => path.includes("credentials.json") || path.includes("skills/jubarteai") || path === "skills-lock.json";
    const strip = (files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([path]) => !ignored(path)));
    expect(strip(after.home)).toEqual(strip(before.home));
    expect(strip(after.repo)).toEqual(strip(before.repo));
    expect(JSON.parse(readFileSync(box.credentialsFile, "utf8"))).toMatchObject({ seats: {} });
    expect(box.findLeaks(["jba_FAKEINTEGRATIONKEY0000000000000001"])).toEqual([]);
  });

  test("--keep-login signs nothing out, and is idempotent: a second uninstall removes nothing more", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    expect((await box.run(["init", "--yes"], { env: { JUBARTEAI_URL: fake.origin } })).code).toBe(0);
    const first = await box.run(["uninstall", "--yes", "--keep-login"]);
    expect(first.code, first.stderr).toBe(0);
    expect(Object.keys((JSON.parse(readFileSync(box.credentialsFile, "utf8")) as { seats: object }).seats)).toHaveLength(1);
    const again = await box.run(["uninstall", "--yes", "--keep-login"]);
    expect(again.code, again.stderr).toBe(0);
    // Only the printed hand-copy instructions are left: nothing the CLI itself may remove.
    expect(again.stderr).toContain("Do these by hand:");
    expect(again.stderr).not.toContain("removed");
  });

  test("in an agent's environment it exits 2 and changes nothing", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    expect((await box.run(["init", "--yes"], { env: { JUBARTEAI_URL: fake.origin } })).code).toBe(0);
    const before = { home: snapshot(box.home), repo: snapshot(box.repo) };
    const refused = await box.run(["uninstall", "--yes"], { env: { CLAUDECODE: "1" } });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("needs you, not an agent");
    expect({ home: snapshot(box.home), repo: snapshot(box.repo) }).toEqual(before);
  });

  test.skipIf(pty === null)("on a terminal, leaving the sign-out row unchecked keeps the saved login", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    expect((await box.run(["init", "--yes"], { env: { JUBARTEAI_URL: fake.origin } })).code).toBe(0);
    const session = spawnPty(pty as NonNullable<typeof pty>, box.node, [BIN, "uninstall", "--plain"], { cwd: box.repo, env: box.env({ TERM: "xterm-256color", LANG: "en_US.UTF-8", JUBARTEAI_URL: fake.origin }) });
    try {
      await session.waitFor("press Enter for all: ");
      const row = /(\d+)\. Sign out of every saved login/.exec(session.text());
      expect(row, session.text()).not.toBeNull();
      session.send(`${row?.[1]}\r`);
      expect((await session.exit).exitCode).toBe(0);
      expect(session.text()).toContain("skipped (not selected)");
      expect(Object.keys((JSON.parse(readFileSync(box.credentialsFile, "utf8")) as { seats: object }).seats)).toHaveLength(1);
    } finally {
      session.kill();
    }
  });
});
