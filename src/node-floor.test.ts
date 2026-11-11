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

  describe("hooks never fail the harness (I7)", () => {
    // A real process.exit ends the process; the stand-in can't, so only what happens before the first exit counts.
    async function runBin(version: string, argv: string[]): Promise<{ exits: number[]; stderr: string }> {
      const exits: number[] = [];
      let stderr = "";
      const sandbox = {
        process: {
          versions: { node: version },
          argv,
          stderr: { write: (text: string) => (exits.length === 0 ? (stderr += text) : stderr) },
          exit: (code: number) => exits.push(code),
        },
        String,
        Number,
      };
      new vm.Script(binSource).runInNewContext(sandbox);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return { exits, stderr };
    }

    it("under an unsupported Node, `hook` exits 0 before saying anything", async () => {
      const { exits, stderr } = await runBin("20.20.2", ["node", "jubarteai", "hook", "session-start", "--harness", "codex"]);
      expect(exits[0]).toBe(0);
      expect(stderr).not.toContain("needs Node");
    });

    it("any other command under an unsupported Node still exits 1 with the floor message", async () => {
      for (const argv of [["node", "jubarteai", "status"], ["node", "jubarteai"], ["node", "jubarteai", "--help", "hook"]]) {
        const { exits, stderr } = await runBin("20.20.2", argv);
        expect(exits[0]).toBe(1);
        expect(stderr).toContain("needs Node 22.23.4");
      }
    });

    it("under a supported Node a hook whose CLI cannot load exits 0 silently, other commands report it", async () => {
      const hook = await runBin("24.22.1", ["node", "jubarteai", "hook", "session-end"]);
      expect(hook.exits[0]).toBe(0);
      expect(hook.stderr).toBe("");
      const other = await runBin("24.22.1", ["node", "jubarteai", "status"]);
      expect(other.exits[0]).toBe(1);
      expect(other.stderr).toContain("failed to start");
    });
  });

  describe("release metadata (CREL)", () => {
    const full = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

    it("the CI matrix names every floor and the latest of each line", () => {
      const line = /^\s+node: \[(.*)\]\s*$/m.exec(ci);
      expect(line).not.toBeNull();
      const versions = [...(line as RegExpExecArray)[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(versions).toEqual([...Object.values(NODE_FLOORS), ...Object.keys(NODE_FLOORS).map((major) => `${major}.x`)]);
    });

    it("ships exactly bin, dist, assets, README.md and LICENSE, at 0.1.0, with no runtime dependencies", () => {
      expect(full.files).toEqual(["bin", "dist", "assets", "README.md", "LICENSE"]);
      expect(full.version).toBe("0.1.0");
      expect(full.dependencies).toBeUndefined();
      expect(full.publishConfig).toEqual({ access: "public", provenance: true });
      expect((full.scripts as Record<string, string>).prepack).toContain("npm run build");
    });

    it("release.yml publishes through OIDC: id-token write, provenance, no npm token", () => {
      expect(release).toMatch(/id-token: write/);
      expect(release).toMatch(/npm publish --provenance --access public/);
      expect(release).toMatch(/uses: \.\/\.github\/workflows\/ci\.yml/);
      expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    });

    it("every action in both workflows is pinned to a commit SHA", () => {
      for (const source of [ci, release]) {
        for (const match of source.matchAll(/^\s+- uses: (\S+)/gm)) {
          expect(match[1], "action pin").toMatch(/@[0-9a-f]{40}$/);
        }
      }
    });
  });
});
