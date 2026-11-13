import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error the release script is plain JavaScript outside the TypeScript project
import { changelogSection } from "../scripts/changelog-section.mjs";

// fileURLToPath, not .pathname: on Windows .pathname is "/D:/a/..." and node cannot open the script.
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const section = changelogSection as (markdown: string, version: string) => string | null;

describe("changelog-section", () => {
  const doc = "# Changelog\n\n## 1.1.0\n\nnewer\n\n## 1.0.0\n\n### Added\n\n- one\n- two\n\n## 0.1.1\n\nold\n";
  it("returns one version's body and stops at the next heading", () => {
    expect(section(doc, "1.0.0")).toBe("### Added\n\n- one\n- two");
    expect(section(doc, "1.1.0")).toBe("newer");
  });
  it("is null for a missing or empty section, and a version is not a prefix match", () => {
    expect(section(doc, "2.0.0")).toBeNull();
    expect(section("## 1.0.0\n\n## 0.9\n\nx\n", "1.0.0")).toBeNull();
    expect(section("## 1.0.10\n\nx\n", "1.0.1")).toBeNull();
  });
  it("the repository's CHANGELOG has a section for the package's version", () => {
    const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    if (/^0\./.test(version)) return; // before 1.0.0 the changelog starts at the first stable release
    const result = spawnSync(process.execPath, [`${CLI_ROOT}scripts/changelog-section.mjs`, version], { cwd: CLI_ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(20);
  });
});
