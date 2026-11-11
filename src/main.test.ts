import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main", () => {
  it("prints the package version for --version", async () => {
    const io = capture();
    expect(await main(["--version"])).toBe(0);
    expect(io.out()).toBe("0.0.0-dev\n");
    expect(io.err()).toBe("");
  });

  it("prints usage for --help", async () => {
    const io = capture();
    expect(await main(["--help"])).toBe(0);
    expect(io.out()).toContain("Usage:");
    expect(io.out()).toContain("--version");
  });

  it("prints usage when called with no arguments", async () => {
    const io = capture();
    expect(await main([])).toBe(0);
    expect(io.out()).toContain("Usage:");
  });

  it("rejects an unknown argument with exit 2 on stderr", async () => {
    const io = capture();
    expect(await main(["--nope"])).toBe(2);
    expect(io.out()).toBe("");
    expect(io.err()).toContain("Unknown argument: --nope");
  });
});
