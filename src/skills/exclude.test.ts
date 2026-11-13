import { describe, expect, it } from "vitest";
import { EXCLUDE_BEGIN, EXCLUDE_END, withManagedBlock } from "./exclude.js";

describe("withManagedBlock", () => {
  it("adds, replaces and removes only its own block", () => {
    const user = "# mine\nnode_modules\n";
    const added = withManagedBlock(user, ["/a/", "/b/"]);
    expect(added).toBe(`${user}${EXCLUDE_BEGIN}\n/a/\n/b/\n${EXCLUDE_END}\n`);
    expect(withManagedBlock(added, ["/c/"])).toBe(`${user}${EXCLUDE_BEGIN}\n/c/\n${EXCLUDE_END}\n`);
    expect(withManagedBlock(added, [])).toBe(user);
    expect(withManagedBlock("", [])).toBe("");
    expect(withManagedBlock("no newline", ["/a/"])).toContain("no newline\n" + EXCLUDE_BEGIN);
  });
});
