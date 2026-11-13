import { describe, expect, it } from "vitest";
import { isSafeRelativePath, isValidSkillName, joinInside } from "./paths.js";

describe("skill paths", () => {
  it("accepts relative forward-slash paths", () => {
    for (const p of ["SKILL.md", "scripts/a.sh", "refs/x/y.md"]) expect(isSafeRelativePath(p)).toBe(true);
  });
  it.each(["", "/abs", "../x", "a/../b", "a//b", "a\\b", "C:x", "con", "x/NUL.txt", "a/", "a.", "a\0b", "a/\u0007", "a/\u0085", "run\u202e.sh", "a\u200bb", "\ufeffSKILL.md", "a/\u{e0041}", "x".repeat(600)])("rejects %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
  it("joinInside stays inside the base", () => {
    expect(joinInside("/tmp/base", "a/b.txt")).toMatch(/base[\\/]a[\\/]b\.txt$/);
    expect(joinInside("/tmp/base", "../b")).toBeNull();
  });
  it("validates folder names", () => {
    expect(isValidSkillName("pdf-tools")).toBe(true);
    for (const n of ["", "A", "a--b", "-a", "../x", "a/b", 3]) expect(isValidSkillName(n)).toBe(false);
  });
  it("joins Windows-style bases through the platform path module", async () => {
    const { win32 } = await import("node:path");
    expect(win32.isAbsolute("C:\\a")).toBe(true);
    expect(isSafeRelativePath("C:\\a")).toBe(false);
  });
});
