import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { ENGINES_RANGE, meetsNodeFloor, NODE_FLOORS } from "./node-floor.js";

const binSource = readFileSync(new URL("../bin/jubarteai.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };

function binFloors(): Record<string, string> {
  const match = /var FLOORS = \{([^}]*)\};/.exec(binSource);
  expect(match).not.toBeNull();
  const floors: Record<string, string> = {};
  for (const pair of (match as RegExpExecArray)[1]!.matchAll(/(\d+):\s*"([\d.]+)"/g)) {
    floors[pair[1] as string] = pair[2] as string;
  }
  return floors;
}

describe("node floor", () => {
  it("NODE_FLOORS equals the table inlined in bin/jubarteai.js", () => {
    const fromBin = binFloors();
    expect(Object.keys(fromBin).length).toBe(3);
    expect(fromBin).toEqual({ ...NODE_FLOORS });
  });

  it("the bin LAST_LINE is the highest key of NODE_FLOORS", () => {
    const match = /var LAST_LINE = (\d+);/.exec(binSource);
    expect(Number((match as RegExpExecArray)[1])).toBe(Math.max(...Object.keys(NODE_FLOORS).map(Number)));
  });

  it("ENGINES_RANGE equals package.json engines.node and is built from the floors", () => {
    expect(ENGINES_RANGE).toBe(manifest.engines.node);
    expect(ENGINES_RANGE).toBe(`^${NODE_FLOORS[22]} || ^${NODE_FLOORS[24]} || >=${NODE_FLOORS[26]}`);
  });

  const refused = ["12.0.0", "20.20.2", "21.9.0", "22.23.3", "23.5.0", "24.22.0", "25.1.0", "26.12.0", "27.0.0"];
  const accepted = ["22.23.4", "22.99.0", "24.22.1", "26.12.1", "28.0.0"];

  it.each(refused)("refuses %s", (version) => {
    expect(meetsNodeFloor(version)).toBe(false);
  });

  it.each(accepted)("accepts %s", (version) => {
    expect(meetsNodeFloor(version)).toBe(true);
  });

  it("refuses garbage", () => {
    expect(meetsNodeFloor("abc")).toBe(false);
    expect(meetsNodeFloor("")).toBe(false);
  });

  it("gives the same verdict as the real bin/jubarteai.js for every boundary version", async () => {
    expect(refused.length + accepted.length).toBeGreaterThan(10);
    for (const version of [...refused, ...accepted]) {
      let stderr = "";
      const sandbox = {
        process: {
          versions: { node: version },
          argv: [],
          stderr: { write: (text: string) => (stderr += text) },
          exit: () => undefined,
        },
        String,
        Number,
      };
      // The bin imports ../dist/main.js; with no import hook that rejects, which the bin reports as a start failure.
      new vm.Script(binSource).runInNewContext(sandbox);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const refusedByBin = stderr.includes("needs Node");
      expect(refusedByBin, `bin verdict for ${version}`).toBe(!meetsNodeFloor(version));
    }
  });
});
