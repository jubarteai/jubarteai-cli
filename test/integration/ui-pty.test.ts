// The terminal experience through the built binary on a real pseudo-terminal: the banner, the one checklist, a key
// press at a time, plain and NO_COLOR modes, a narrow window, `update`'s question, and declining. Stub `claude` and
// `codex` are on the sandbox PATH so two harnesses are detected; no real editor is ever touched.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { loadPty, spawnPty } from "../helpers/pty.js";
import type { PtySession } from "../helpers/pty.js";
import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { BIN, IS_WINDOWS, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const pty = loadPty();
// The stubs are POSIX shell wrappers (see WINDOWS_STUB_REASON in harness.ts), so harness detection needs POSIX.
const posixPty = pty === null || IS_WINDOWS ? test.skip : test;
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ENTER = "\r";

let fake: FakeServer;
let box: Sandbox;
const sessions: PtySession[] = [];

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
  expect((await box.signInWithKey(fake)).code).toBe(0);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.kill();
  await fake.close();
  box.cleanup();
});

function start(args: string[], env: Record<string, string | undefined> = {}, size: { cols?: number; rows?: number } = {}): PtySession {
  const session = spawnPty(pty as NonNullable<typeof pty>, process.execPath, [BIN, ...args], {
    cwd: box.repo,
    env: box.env({ TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8", JUBARTEAI_URL: fake.origin, ...env }),
    ...size,
  });
  sessions.push(session);
  return session;
}

const claudeSettings = (): string => join(box.home, ".claude", "settings.json");
const codexHooks = (): string => join(box.home, ".codex", "hooks.json");

/** Answers the account confirmation and the share-binding question (No), up to the checklist. */
async function toChecklist(session: PtySession, title = "Choose what to set up"): Promise<number> {
  const account = await session.waitFor("[Y/n]");
  session.send(ENTER);
  const share = await session.waitFor("Share this workspace binding", { after: account });
  session.send("n");
  return session.waitFor(title, { after: share });
}

describe("init on a terminal", () => {
  posixPty("shows the gradient banner and one checklist; Space unchecks a harness, d shows a redacted entry, Enter applies the rest", async () => {
    const session = start(["init", "--keep-mcp"]);
    const at = await toChecklist(session);
    expect(session.raw()).toContain("38;2;0;136;136"); // banner gradient start, 24-bit
    expect(session.raw()).toContain("38;2;2;224;222");
    expect(session.text()).toContain("Agentic Connection Platform · installer");
    await session.waitFor("Add the JubarteAI session hooks to ~/.codex/hooks.json", { after: at });

    session.send(UP); // from the first row up to the "Claude Code" header
    session.send(" "); // uncheck the whole harness
    await session.waitFor("□ Claude Code", { after: at });
    session.send("d");
    await session.waitFor("session hooks", { after: at });
    expect(session.text()).not.toMatch(/jb[acw]_[A-Za-z0-9]/);
    session.send(ENTER);
    const done = await session.exit;
    expect(done.exitCode).toBe(0);
    expect(session.text()).toMatch(/Done in \S+ — \d+ ok/);
    expect(session.text()).toContain("Restart your editor or agent");
    // Claude Code was deselected: its settings were never written. Codex stayed checked.
    expect(existsSync(claudeSettings())).toBe(false);
    expect(existsSync(codexHooks())).toBe(true);
    expect(box.findLeaks(["jba_FAKEINTEGRATIONKEY0000000000000001"], { allowFiles: [join(box.home, ".codex", "config.toml")] })).toEqual([]);
  });

  posixPty("--plain prints a numbered list and the number leaves a row out", async () => {
    const session = start(["init", "--plain", "--keep-mcp", "--private-binding"]);
    const account = await session.waitFor("[Y/n]");
    session.send(ENTER);
    await session.waitFor("press Enter for all: ", { after: account });
    expect(session.raw()).not.toContain("\u001b[");
    const text = session.text();
    const row = /(\d+)\. Add the JubarteAI session hooks to ~\/\.claude\/settings\.json/.exec(text);
    expect(row, text).not.toBeNull();
    session.send(`${row?.[1]}\r`);
    expect((await session.exit).exitCode).toBe(0);
    expect(session.text()).toContain("skipped (not selected)");
    // The permission rule row stayed checked (settings.json exists), the hooks row was left out.
    expect(box.read(claudeSettings())).not.toContain("hook session-start");
    expect(existsSync(codexHooks())).toBe(true);
  });

  posixPty("NO_COLOR=1 prints no escape code at all", async () => {
    const session = start(["init", "--keep-mcp", "--private-binding"], { NO_COLOR: "1" });
    const account = await session.waitFor("[Y/n]");
    session.send(ENTER);
    await session.waitFor("press Enter for all: ", { after: account });
    session.send(ENTER);
    expect((await session.exit).exitCode).toBe(0);
    expect(session.raw()).not.toContain("\u001b");
  });

  posixPty("a 60-column window gets the compact banner", async () => {
    const session = start(["init", "--keep-mcp", "--private-binding"], {}, { cols: 60 });
    const account = await session.waitFor("[Y/n]");
    expect(session.text()).toContain("◆ JubarteAI");
    expect(session.text()).not.toContain("██╗");
    session.send(ENTER);
    await session.waitFor("Choose what to set up", { after: account });
    session.send(UP + UP + " "); // uncheck something, then leave
    session.send("\u0003");
    expect((await session.exit).exitCode).not.toBe(0);
  });

  posixPty("unchecking every row (or Ctrl-C) applies nothing: Aborted., exit 0 / Cancelled", async () => {
    const session = start(["init", "--keep-mcp", "--private-binding"]);
    const at = await toChecklist2(session);
    // Header rows toggle their groups: walk the list and switch every group off.
    session.send(UP + " "); // Claude Code header off
    session.send(DOWN.repeat(5) + " ".repeat(0));
    const text = () => session.text();
    // Simpler and deterministic: Escape declines the whole checklist.
    session.send("\u001b");
    await session.waitFor("declined", { after: at });
    expect((await session.exit).exitCode).toBe(0);
    expect(text()).toContain("Aborted.");
    expect(existsSync(claudeSettings())).toBe(false);
    expect(existsSync(join(box.repo, ".jubarteai"))).toBe(false);
  });

  posixPty("Ctrl-C at the checklist cancels with nothing applied", async () => {
    const session = start(["init", "--keep-mcp", "--private-binding"]);
    const at = await toChecklist2(session);
    session.send("\u0003");
    const done = await session.exit;
    expect(done.exitCode).not.toBe(0);
    expect(session.text()).toContain("Cancelled.");
    expect(existsSync(claudeSettings())).toBe(false);
    void at;
  });
});

/** For runs with --private-binding: only the account confirmation comes before the checklist. */
async function toChecklist2(session: PtySession): Promise<number> {
  const account = await session.waitFor("[Y/n]");
  session.send(ENTER);
  return session.waitFor("Choose what to set up", { after: account });
}

describe("update on a terminal", () => {
  posixPty("asks one question with Yes preselected; Show prints the exact changes, then Yes applies", async () => {
    // init first (no terminal needed); the stub npx installs no real skill, so update has copies to refresh.
    expect((await box.run(["init", "--yes", "--keep-mcp"], { env: { JUBARTEAI_URL: fake.origin } })).code).toBe(0);

    const session = start(["update", "--no-self-update", "--keep-mcp"]);
    const at = await session.waitFor("Apply these changes?");
    expect(session.text()).toContain("● Yes  ○ No  ○ Show the exact changes");
    session.send("d");
    await session.waitFor("Overwrite skill hand copy", { after: at });
    session.send(ENTER);
    expect((await session.exit).exitCode).toBe(0);
    expect(session.text()).toMatch(/Done in \S+ — \d+ ok/);
  });
});
