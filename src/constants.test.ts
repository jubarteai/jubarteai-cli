import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cliVersion, DEFAULT_ORIGIN, LOOPBACK_HOSTS } from "./constants.js";

describe("constants", () => {
  it("cliVersion matches package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(cliVersion()).toBe(manifest.version);
    expect(cliVersion()).toBe(cliVersion());
  });

  it("the default origin is https and the loopback list is exactly the three hosts", () => {
    expect(DEFAULT_ORIGIN).toBe("https://jubarte.ai");
    expect([...LOOPBACK_HOSTS]).toEqual(["127.0.0.1", "localhost", "[::1]"]);
  });
});
