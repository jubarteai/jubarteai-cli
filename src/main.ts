import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { route } from "./cli/router.js";
import { takeEnvToken } from "./process-env.js";

let brokenPipeHandled = false;

/** `jubarteai … | head` closes stdout early; that is not an error worth a stack trace. */
function ignoreBrokenPipe(): void {
  if (brokenPipeHandled) return;
  brokenPipeHandled = true;
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

export async function main(argv: string[]): Promise<number> {
  // Take the key out of process.env before any command can start a child process.
  takeEnvToken();
  ignoreBrokenPipe();
  return route(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
  });
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
