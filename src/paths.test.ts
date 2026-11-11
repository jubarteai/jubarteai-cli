import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configDir, credentialsPath, homeDir, sessionsDir } from "./paths.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubPlatform(platform: string): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
}

describe("paths", () => {
  it("homeDir follows HOME", () => {
    vi.stubEnv("HOME", "/tmp/fake-home");
    expect(homeDir()).toBe("/tmp/fake-home");
  });

  it("uses $XDG_CONFIG_HOME/jubarteai when it is absolute", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(configDir()).toBe(join("/tmp/xdg", "jubarteai"));
    expect(credentialsPath()).toBe(join("/tmp/xdg", "jubarteai", "credentials.json"));
  });

  it("falls back to ~/.config/jubarteai when XDG_CONFIG_HOME is unset, empty or relative", () => {
    vi.stubEnv("HOME", "/tmp/fake-home");
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
    vi.stubEnv("USERPROFILE", "/tmp/winhome");
    vi.stubEnv("HOME", "/tmp/winhome");
    expect(configDir()).toBe(join("/tmp/winhome", "AppData", "Roaming", "jubarteai"));
  });

  it("puts sessions under the temp dir, which follows TMPDIR", () => {
    vi.stubEnv("TMPDIR", "/tmp/custom-tmp");
    expect(sessionsDir()).toBe(join(tmpdir(), `jubarteai-${process.getuid?.()}`, "sessions"));
    expect(sessionsDir().startsWith(join("/tmp/custom-tmp"))).toBe(true);
  });

  it("keys the POSIX sessions directory by uid so another user cannot pre-create it", () => {
    stubPlatform("linux");
    vi.spyOn(process, "getuid").mockReturnValue(4242);
    vi.stubEnv("TMPDIR", "/tmp/shared");
    expect(sessionsDir()).toBe(join(tmpdir(), "jubarteai-4242", "sessions"));
    expect(sessionsDir()).not.toBe(join(tmpdir(), "jubarteai", "sessions"));
  });

  it("leaves the Windows sessions directory unchanged", () => {
    stubPlatform("win32");
    vi.spyOn(process, "getuid").mockReturnValue(4242);
    expect(sessionsDir()).toBe(join(tmpdir(), "jubarteai", "sessions"));
  });
});
