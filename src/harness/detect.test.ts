import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDetectEnv, detectHarnesses } from "./detect.js";
import { ADAPTERS } from "./registry.js";
import type { DetectEnv } from "./types.js";

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jba-detect-")));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const none: DetectEnv["which"] = () => null;
const ids = async (env: Partial<DetectEnv>): Promise<string[]> => (await detectHarnesses({ platform: "linux", env: {}, ...env })).map((a) => a.id);

describe("detectHarnesses", () => {
  it("an empty machine has none", async () => {
    expect(await ids({ home, which: none })).toEqual([]);
  });

  it("finds a harness by its binary on PATH", async () => {
    expect(await ids({ home, which: (c) => (c === "claude" ? "/usr/bin/claude" : null) })).toEqual(["claude-code"]);
    expect(await ids({ home, which: (c) => (c === "codex" ? "/usr/bin/codex" : null) })).toEqual(["codex"]);
  });

  it("finds a harness by its directory", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".codex"));
    expect(await ids({ home, which: none })).toEqual(["claude-code", "codex"]);
  });

  it("returns adapters in registry order and as the registry's own objects", async () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.mkdirSync(path.join(home, ".claude"));
    const found = await detectHarnesses({ home, which: none, platform: "linux", env: {} });
    expect(found[0]).toBe(ADAPTERS[0]);
    expect(found[1]).toBe(ADAPTERS[1]);
  });

  it("passes the injected environment to each adapter", async () => {
    const custom = path.join(home, "elsewhere");
    fs.mkdirSync(custom);
    expect(await ids({ home, which: none, env: { CODEX_HOME: custom } })).toEqual(["codex"]);
    expect(await ids({ home, which: none, env: { CLAUDE_CONFIG_DIR: custom } })).toEqual(["claude-code"]);
  });

  it("an adapter whose detection throws counts as absent, the others still answer", async () => {
    const original = ADAPTERS[0]!.detect;
    (ADAPTERS[0] as { detect: unknown }).detect = async () => {
      throw new Error("boom");
    };
    try {
      expect(await ids({ home, which: (c) => (c === "codex" ? "/bin/codex" : c === "claude" ? "/bin/claude" : null) })).toEqual(["codex"]);
    } finally {
      (ADAPTERS[0] as { detect: unknown }).detect = original;
    }
  });
});

describe("defaultDetectEnv", () => {
  it("is this machine: process environment, platform and the real home", () => {
    const env = defaultDetectEnv();
    expect(env.env).toBe(process.env);
    expect(env.platform).toBe(process.platform);
    expect(path.isAbsolute(env.home)).toBe(true);
    expect(env.which("definitely-not-a-command-jba")).toBeNull();
    expect(env.which("node")).not.toBeNull();
  });
});
