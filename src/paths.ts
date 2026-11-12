import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CLI_NAME } from "./constants.js";

/** The user's home directory (os.homedir honours HOME, or USERPROFILE on Windows). */
export function homeDir(): string {
  return homedir();
}

/**
 * Where the CLI keeps its per-user config. `$XDG_CONFIG_HOME` is used only when it
 * is an absolute path, as the XDG spec says. Windows uses `%APPDATA%`.
 */
export function configDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const base = appData !== undefined && appData !== "" ? appData : join(homeDir(), "AppData", "Roaming");
    return join(base, CLI_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(homeDir(), ".config");
  return join(base, CLI_NAME);
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

/**
 * Per-session agent cache. os.tmpdir() honours TMPDIR (and TEMP/TMP on Windows). On POSIX the
 * directory name carries the uid, so in a shared /tmp no other user can pre-create the path;
 * Windows temp is already per-user.
 */
export function sessionsDir(): string {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return join(tmpdir(), CLI_NAME, "sessions");
  }
  return join(tmpdir(), `${CLI_NAME}-${process.getuid()}`, "sessions");
}
