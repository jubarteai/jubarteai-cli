// Child process for src/safe-edit/atomic-write.test.ts. It writes a file with
// writeFileAtomicWith and, through the function's own test seam (the
// beforeRename dependency: a parameter, never read from the environment), stops
// with the temp file written and closed and the rename still to come, so the
// parent can kill it at exactly that point.
//
//   node crash-child.mjs <compiled-src-dir> <target> <ready-file> <go-file>
//
// <ready-file> is created when the child is paused; the child then waits for
// <go-file> to appear (it gives up after 30 s, so a failed test never leaves it
// running) before the rename.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const [, , srcDir, target, readyFile, goFile] = process.argv;
if (!srcDir || !target || !readyFile || !goFile) {
  process.exit(64);
}

const { writeFileAtomicWith } = await import(pathToFileURL(join(srcDir, "safe-edit", "atomic-write.js")).href);
const { defaultGuardEnv } = await import(pathToFileURL(join(srcDir, "safe-edit", "file-guards.js")).href);

const pause = new Int32Array(new SharedArrayBuffer(4));

writeFileAtomicWith(
  target,
  "NEW CONTENT\n",
  { mode: 0o600 },
  {
    guard: defaultGuardEnv(),
    beforeRename() {
      writeFileSync(readyFile, "paused");
      const deadline = Date.now() + 30_000;
      while (!existsSync(goFile)) {
        if (Date.now() > deadline) process.exit(65);
        Atomics.wait(pause, 0, 0, 10);
      }
    },
  },
);
