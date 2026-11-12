import { afterEach, describe, expect, it, vi } from "vitest";

import { cliVersion } from "./constants.js";
import { main } from "./main.js";
import { resetEnvTokenForTests } from "./process-env.js";

function capture() {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  return { out: () => out, err: () => err };
}

const FAKE_KEY = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKE0003";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.JUBARTEAI_TOKEN;
  resetEnvTokenForTests();
});

describe("main", () => {
  it("prints the package version for --version", async () => {
    const io = capture();
    expect(await main(["--version"])).toBe(0);
    expect(io.out()).toBe(`${cliVersion()}\n`);
    expect(io.out()).toBe("0.0.0-dev\n");
    expect(io.err()).toBe("");
  });

  it("prints usage for --help and with no arguments", async () => {
    for (const argv of [["--help"], []]) {
      const io = capture();
      expect(await main(argv)).toBe(0);
      expect(io.out()).toContain("Usage:");
      expect(io.out()).toContain("--version");
      expect(io.err()).toBe("");
    }
  });

  it("rejects an unknown flag and an unknown command with exit 2 on stderr", async () => {
    const io = capture();
    expect(await main(["--nope"])).toBe(2);
    expect(io.out()).toBe("");
    expect(io.err()).toContain("Unknown flag --nope");
    const second = capture();
    expect(await main(["bogus"])).toBe(2);
    expect(second.err()).toContain('Unknown command "bogus"');
  });

  it("removes JUBARTEAI_TOKEN from process.env before running anything", async () => {
    vi.stubEnv("JUBARTEAI_TOKEN", FAKE_KEY);
    capture();
    await main(["--version"]);
    expect("JUBARTEAI_TOKEN" in process.env).toBe(false);
  });

  it("never prints a key from the environment on --help, --version or an error", async () => {
    for (const argv of [["--help"], ["--version"], ["--help", "--all"], ["--nope"], ["bogus"], []]) {
      vi.stubEnv("JUBARTEAI_TOKEN", FAKE_KEY);
      vi.stubEnv("JUBARTEAI_URL", "http://127.0.0.1:3000");
      const io = capture();
      await main(argv);
      expect(io.out() + io.err(), `output of ${argv.join(" ")}`).not.toContain("FAKEFAKE");
      expect(io.out() + io.err()).not.toContain("jba_");
      vi.restoreAllMocks();
    }
  });
});
