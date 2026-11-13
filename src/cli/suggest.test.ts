import { describe, expect, it } from "vitest";

import { editDistance, suggest } from "./suggest.js";

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and adjacent swaps", () => {
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "abd")).toBe(1);
    expect(editDistance("abc", "ab")).toBe(1);
    expect(editDistance("abc", "acb")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "ab")).toBe(2);
  });
});

describe("suggest", () => {
  const commands = ["search-knowledge", "create-knowledge", "get-knowledge", "inbox", "init", "link", "login", "logout"];
  it("finds the one name within distance 2", () => {
    expect(suggest("serch-knowledge", commands)).toBe("search-knowledge");
    expect(suggest("inobx", commands)).toBe("inbox");
    expect(suggest("INBOX", commands)).toBe("inbox");
  });
  it("gives nothing at distance 3 or more, or for an exact tie", () => {
    expect(suggest("knowledge", commands)).toBeNull();
    expect(suggest("lo", ["log", "lot"])).toBeNull();
    expect(suggest("zzzzzz", commands)).toBeNull();
  });
});
