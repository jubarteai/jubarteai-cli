import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configDir, credentialsPath, homeDir, sessionsDir, watchLocksDir } from "./paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreGetuid?.();
  restoreGetuid = undefined;
});

function stubPlatform(platform: string): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
}

/** process.getuid does not exist on Windows, where vi.spyOn would throw: define it for the test and put it back. */
let restoreGetuid: (() => void) | undefined;
function stubGetuid(uid: number): void {
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true, writable: true });
  restoreGetuid = () => {
    if (original) Object.defineProperty(process, "getuid", original);
    else delete (process as { getuid?: unknown }).getuid;
  };
}

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
function stubHome(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
}

describe("paths", () => {
  it("homeDir follows HOME (USERPROFILE on Windows)", () => {
    stubHome("/tmp/fake-home");
    expect(homeDir()).toBe("/tmp/fake-home");
  });

  it("uses $XDG_CONFIG_HOME/jubarteai when it is absolute", () => {
    stubPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(configDir()).toBe(join("/tmp/xdg", "jubarteai"));
    expect(credentialsPath()).toBe(join("/tmp/xdg", "jubarteai", "credentials.json"));
  });

  it("falls back to ~/.config/jubarteai when XDG_CONFIG_HOME is unset, empty or relative", () => {
    stubPlatform("linux");
    stubHome("/tmp/fake-home");
    for (const value of [undefined, "", "relative/dir"]) {
      vi.stubEnv("XDG_CONFIG_HOME", value);
      expect(configDir()).toBe(join("/tmp/fake-home", ".config", "jubarteai"));
    }
  });

  it("uses %APPDATA%\\jubarteai on Windows and ignores XDG_CONFIG_HOME", () => {
    stubPlatform("win32");
    vi.stubEnv("APPDATA", "/tmp/AppData/Roaming");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(configDir()).toBe(join("/tmp/AppData/Roaming", "jubarteai"));
    expect(credentialsPath()).toBe(join("/tmp/AppData/Roaming", "jubarteai", "credentials.json"));
  });

  it("falls back to ~/AppData/Roaming on Windows when APPDATA is unset", () => {
    stubPlatform("win32");
    vi.stubEnv("APPDATA", undefined);
    stubHome("/tmp/winhome");
    expect(configDir()).toBe(join("/tmp/winhome", "AppData", "Roaming", "jubarteai"));
  });

  it("puts sessions under the temp dir, which follows TMPDIR", () => {
    stubPlatform("linux");
    stubGetuid(501);
    vi.stubEnv("TMPDIR", "/tmp/custom-tmp");
    expect(sessionsDir()).toBe(join(tmpdir(), "jubarteai-501", "sessions"));
    expect(sessionsDir().startsWith(tmpdir())).toBe(true);
  });

  it("keys the POSIX sessions directory by uid so another user cannot pre-create it", () => {
    stubPlatform("linux");
    stubGetuid(4242);
    vi.stubEnv("TMPDIR", "/tmp/shared");
    expect(sessionsDir()).toBe(join(tmpdir(), "jubarteai-4242", "sessions"));
    expect(sessionsDir()).not.toBe(join(tmpdir(), "jubarteai", "sessions"));
  });

  it("leaves the Windows sessions directory unchanged", () => {
    stubPlatform("win32");
    stubGetuid(4242);
    expect(sessionsDir()).toBe(join(tmpdir(), "jubarteai", "sessions"));
  });

  it("keeps the watcher locks next to the sessions, keyed by uid on POSIX", () => {
    stubPlatform("linux");
    stubGetuid(4242);
    expect(watchLocksDir()).toBe(join(tmpdir(), "jubarteai-4242", "watch"));
    stubPlatform("win32");
    expect(watchLocksDir()).toBe(join(tmpdir(), "jubarteai", "watch"));
  });
});
