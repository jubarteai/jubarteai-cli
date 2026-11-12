import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openBrowser } from "./open-browser.js";

type FakeChild = EventEmitter & { unref: () => void };

function child(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.unref = vi.fn();
  return emitter;
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const URL_WITH_AMPERSANDS = "https://jubarte.ai/cli/authorize?v=1&challenge=abc&state=def&port=5555&host=my-mac";

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  delete process.env.JUBARTEAI_TOKEN;
  vi.useRealTimers();
});

describe("openBrowser", () => {
  it.each([
    ["darwin", "open", [URL_WITH_AMPERSANDS]],
    ["linux", "xdg-open", [URL_WITH_AMPERSANDS]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", URL_WITH_AMPERSANDS]],
  ] as const)("on %s spawns %s with an argument array and no shell", async (platform, command, args) => {
    setPlatform(platform);
    const fake = child();
    spawnMock.mockReturnValue(fake);
    const opened = openBrowser(URL_WITH_AMPERSANDS);
    fake.emit("spawn");
    fake.emit("exit", 0);
    await expect(opened).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [calledCommand, calledArgs, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(calledCommand).toBe(command);
    expect(calledArgs).toEqual(args);
    expect(options.shell).toBe(false);
    expect(options.stdio).toBe("ignore");
    expect(options.detached).toBe(true);
    expect(fake.unref).toHaveBeenCalled();
  });

  it("never goes through cmd.exe on Windows, so an & in the URL can't be interpreted", async () => {
    setPlatform("win32");
    const fake = child();
    spawnMock.mockReturnValue(fake);
    const opened = openBrowser(URL_WITH_AMPERSANDS);
    fake.emit("spawn");
    fake.emit("exit", 0);
    await opened;
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).not.toMatch(/cmd/i);
    expect(args).not.toContain("/c");
    expect(args.filter((arg) => arg.includes("&"))).toEqual([URL_WITH_AMPERSANDS]);
  });

  it("gives the child an environment without JUBARTEAI_TOKEN", async () => {
    setPlatform("darwin");
    process.env.JUBARTEAI_TOKEN = "jba_FAKEFAKEFAKEFAKE0001";
    process.env.JUBARTEAI_TEST_MARKER = "kept";
    const fake = child();
    spawnMock.mockReturnValue(fake);
    const opened = openBrowser(URL_WITH_AMPERSANDS);
    fake.emit("spawn");
    fake.emit("exit", 0);
    await opened;
    const env = (spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.JUBARTEAI_TOKEN).toBeUndefined();
    expect(env.JUBARTEAI_TEST_MARKER).toBe("kept");
    delete process.env.JUBARTEAI_TEST_MARKER;
  });

  it("reports false when the launcher is missing", async () => {
    setPlatform("linux");
    const fake = child();
    spawnMock.mockReturnValue(fake);
    const opened = openBrowser(URL_WITH_AMPERSANDS);
    fake.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    await expect(opened).resolves.toBe(false);
  });

  it("reports false when the launcher fails straight away, true when it exits cleanly", async () => {
    setPlatform("linux");
    const failing = child();
    spawnMock.mockReturnValueOnce(failing);
    const first = openBrowser(URL_WITH_AMPERSANDS);
    failing.emit("spawn");
    failing.emit("exit", 3);
    await expect(first).resolves.toBe(false);

    const fine = child();
    spawnMock.mockReturnValueOnce(fine);
    const second = openBrowser(URL_WITH_AMPERSANDS);
    fine.emit("spawn");
    fine.emit("exit", 0);
    await expect(second).resolves.toBe(true);
  });

  it("counts a launcher that is still running after the quick-failure window as opened", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setPlatform("darwin");
    const fake = child();
    spawnMock.mockReturnValue(fake);
    const opened = openBrowser(URL_WITH_AMPERSANDS);
    fake.emit("spawn");
    vi.advanceTimersByTime(2000);
    await expect(opened).resolves.toBe(true);
  });

  it("reports false when spawn throws", async () => {
    setPlatform("darwin");
    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(openBrowser(URL_WITH_AMPERSANDS)).resolves.toBe(false);
  });

  it("refuses anything that is not an http(s) URL without spawning", async () => {
    setPlatform("darwin");
    for (const value of ["file:///etc/passwd", "javascript:alert(1)", "--help", "-a Calculator", "not a url", ""]) {
      await expect(openBrowser(value)).resolves.toBe(false);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
