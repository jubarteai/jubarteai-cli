import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { CLI_NAME } from "../constants.js";

/**
 * What a hook's command line starts with: `"<node>" "<this install's bin script>"`, both absolute. An editor started
 * from the desktop often has no nvm, Homebrew or ~/.local/bin on its PATH, so a bare `jubarteai hook ...` would exit
 * 127 there. Falls back to the bare `jubarteai` when either path is missing, relative, can't be resolved or holds a
 * double quote (it could not be quoted safely). A re-run of `init` after a Node upgrade rewrites a hook whose command
 * differs. `init` registers hooks with this value and `doctor` inspects with the same one; the permission rule and
 * every message keep the bare name, which is what agents type.
 */
export function resolveCliCommand(execPath: string = process.execPath, script: string | null | undefined = process.argv[1]): string {
  if (script === undefined || script === null || script === "" || !isAbsolute(execPath)) return CLI_NAME;
  let bin: string;
  try {
    bin = realpathSync(script);
  } catch {
    return CLI_NAME;
  }
  if (!isAbsolute(bin) || execPath.includes('"') || bin.includes('"')) return CLI_NAME;
  return `"${execPath}" "${bin}"`;
}
