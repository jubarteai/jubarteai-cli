import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { CLI_NAME } from "../constants.js";

export type CliCommandInfo = {
  /** What a hook's command line starts with. */
  command: string;
  /** True when the running install is a throwaway npx copy, so a hook naming it would break once the cache is cleaned. */
  npx: boolean;
};

/** A path inside npm's npx cache (`~/.npm/_npx/<hash>/...`). */
const NPX_CACHE = /[\\/]_npx[\\/]/;
/** Inside double quotes a POSIX shell still expands these. */
const SHELL_ACTIVE = /[$`\\]/;

/**
 * What a hook's command line starts with: `"<node>" "<this install's bin script>"`, both absolute. An editor started
 * from the desktop often has no nvm, Homebrew or ~/.local/bin on its PATH, so a bare `jubarteai hook ...` would exit
 * 127 there. Falls back to the bare `jubarteai` when:
 * - either path is missing, relative or can't be resolved;
 * - either path holds a double quote, or (on POSIX) a `$`, a backtick or a backslash, which the shell would expand
 *   inside the quotes;
 * - the platform is Windows: Cursor runs hooks through PowerShell, which can't parse `"a" "b"`, and Windows GUI apps
 *   inherit the user PATH, which holds npm's shims;
 * - the bin is inside the npx cache (`npx jubarteai init`): that copy goes away. `npx` says so, for a note.
 * A re-run of `init` after a Node upgrade rewrites a hook whose command differs. `init` registers hooks with this
 * value and `doctor` inspects with the same one; the permission rule and every message keep the bare name, which is
 * what agents type.
 */
export function cliCommandInfo(
  execPath: string = process.execPath,
  script: string | null | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): CliCommandInfo {
  const bare: CliCommandInfo = { command: CLI_NAME, npx: false };
  if (script === undefined || script === null || script === "" || !isAbsolute(execPath)) return bare;
  let bin: string;
  try {
    bin = realpathSync(script);
  } catch {
    return bare;
  }
  if (!isAbsolute(bin)) return bare;
  if (NPX_CACHE.test(bin)) return { command: CLI_NAME, npx: true };
  if (platform === "win32") return bare;
  if (execPath.includes('"') || bin.includes('"') || SHELL_ACTIVE.test(execPath) || SHELL_ACTIVE.test(bin)) return bare;
  return { command: `"${execPath}" "${bin}"`, npx: false };
}

/** The command prefix for hooks: see cliCommandInfo. */
export function resolveCliCommand(
  execPath: string = process.execPath,
  script: string | null | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string {
  return cliCommandInfo(execPath, script, platform).command;
}
