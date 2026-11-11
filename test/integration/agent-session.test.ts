// R-M1 through the built binary: run from a coding agent's shell (its session variable set, stdin not a terminal),
// `init --yes` writes the non-sensitive steps but none of the harness or security files, and the account commands refuse.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { FAKE_KEY, IS_WINDOWS, WINDOWS_STUB_REASON, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const OTHER_KEY = "jba_ATTACKERKEY0000000000000000000001";
const NEEDS_PERSON = "needs your approval: an agent's --yes doesn't count; run the command yourself in a terminal";

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox({ stubs: ["npx", "npm", "claude"] });
});

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

describe.skipIf(IS_WINDOWS)(`inside an agent session (POSIX only: ${WINDOWS_STUB_REASON})`, () => {
  for (const variable of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) {
    test(`init --yes with ${variable} set leaves the Claude Code settings alone`, async () => {
      expect((await box.signInWithKey(fake)).code).toBe(0);
      const result = await box.run(["init", "--yes"], { env: { [variable]: "session-1" } });
      expect(result.stderr).toContain(NEEDS_PERSON);
      expect(result.stderr).not.toMatch(/rerun with --yes/);
      expect(existsSync(join(box.home, ".claude", "settings.json"))).toBe(false);
      // The non-sensitive steps still ran: the repo is bound.
      expect(existsSync(join(box.repo, ".jubarteai", "config.json"))).toBe(true);
    });
  }

  test("without the variable, init --yes writes the permission with its ask rules", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    const result = await box.run(["init", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    const settings = box.readJson(join(box.home, ".claude", "settings.json")) as { permissions: { allow: string[]; ask: string[] } };
    expect(settings.permissions.allow).toEqual(["Bash(jubarteai *)"]);
    for (const sub of ["login", "logout", "link", "init", "update"]) expect(settings.permissions.ask).toContain(`Bash(jubarteai ${sub} *)`);
    // No leading-flag rule: the router refuses `jubarteai --yes init`, and `jubarteai --help` stays pre-approved (R-S8).
    expect(settings.permissions.ask.some((rule) => rule.includes(" -*"))).toBe(false);
  });

  test("login --with-token refuses and keeps the saved login; the piped key is never echoed", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    const before = box.read(box.credentialsFile);
    const result = await box.run(["login", "--with-token"], { stdin: `${OTHER_KEY}\n`, env: { JUBARTEAI_URL: fake.origin, CLAUDECODE: "1" } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs you, not an agent");
    expect(box.read(box.credentialsFile)).toBe(before);
    expect(result.stdout + result.stderr).not.toContain(OTHER_KEY);
    expect(result.stdout + result.stderr).not.toContain(FAKE_KEY);
  });
});
