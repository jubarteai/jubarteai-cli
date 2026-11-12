// node-pty works on this runner: the built binary answers --version on a pseudo-terminal (POSIX openpty, Windows ConPTY).
import { expect, test } from "vitest";

import { loadPty, spawnPty } from "../helpers/pty.js";
import { BIN, CLI_ROOT, ensureBuilt } from "./harness.js";

const pty = loadPty();

test.skipIf(pty === null)("the built binary runs on a pseudo-terminal", async () => {
  ensureBuilt();
  const session = spawnPty(pty as NonNullable<typeof pty>, process.execPath, [BIN, "--version"], { cwd: CLI_ROOT, env: { ...process.env } });
  const done = await session.exit;
  expect(done.exitCode).toBe(0);
  expect(session.text()).toMatch(/\d+\.\d+\.\d+/);
});
