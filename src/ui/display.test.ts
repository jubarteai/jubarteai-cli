import { describe, expect, it } from "vitest";

import { displayPath, stripAnsi, truncate, visibleWidth } from "./display.js";

describe("displayPath", () => {
  const home = "/home/ada";
  it("prints ./ under the root, ~/ under home, and the absolute path elsewhere", () => {
    expect(displayPath("/home/ada/work/repo/AGENTS.md", { home, root: "/home/ada/work/repo" })).toBe("./AGENTS.md");
    expect(displayPath("/home/ada/.claude/settings.json", { home, root: "/home/ada/work/repo" })).toBe("~/.claude/settings.json");
    expect(displayPath("/etc/hosts", { home, root: "/home/ada/work/repo" })).toBe("/etc/hosts");
    expect(displayPath("/home/ada/work/repo", { home, root: "/home/ada/work/repo" })).toBe(".");
    expect(displayPath("/home/ada", { home })).toBe("~");
  });
  it("is not fooled by a sibling folder with the same prefix", () => {
    expect(displayPath("/home/ada2/x", { home })).toBe("/home/ada2/x");
  });
  it("makes control characters and secrets safe", () => {
    expect(displayPath("/home/ada/a\u001b[31mb", { home })).toBe("~/a?[31mb");
    expect(displayPath("/home/ada/jba_SECRETSECRETSECRET1", { home })).toBe("~/[redacted]");
  });
});

describe("width helpers", () => {
  it("strips CSI and OSC sequences and measures what is visible", () => {
    const text = "\u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007";
    expect(stripAnsi(text)).toBe("red link");
    expect(visibleWidth(text)).toBe(8);
    expect(visibleWidth("██╗")).toBe(3);
  });
  it("truncates with an ellipsis and never splits an escape", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 6)).toBe("hello…");
    const cut = truncate("\u001b[31mhello world\u001b[0m", 6);
    expect(stripAnsi(cut)).toBe("hello…");
    expect(cut.endsWith("\u001b[0m")).toBe(true);
    // Every escape that survives the cut is a complete one (ESC then "["), never a lone half.
    expect(cut.split("\u001b").slice(1).every((part) => part.startsWith("["))).toBe(true);
    expect(truncate("abc", 0)).toBe("");
  });
});
