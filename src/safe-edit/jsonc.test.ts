// Scenarios ported from the app's src/lib/install-script.test.ts and script-fragments.ts (STRIP_JSONC_JS).
// B3 maps each deleted test to one below. Only the detection rule lives here; what each adapter does with a
// JSONC file (fail the step, print manual instructions, leave it byte-identical) is tested where it is wired.
//
// ported: Zed JSONC settings degrade gracefully: file byte-unchanged, token not echoed, exit 0
// ported: VS Code: a JSONC .vscode/mcp.json (comment, ${input:…} on another server, trailing comma) with the placeholder key fails with manual instructions, unchanged
// ported: Zed: a .zed/settings.json with comments that sets another key is reported as failed (exit 1) and left as it is
// ported: Zed: a .zed/settings.json with comments that already has this key, or no jubarteai, is fine
// ported: a parent .mcp.json that only mentions jubarteai in a comment, or doesn't parse and holds no key, is not a failure
// ported: stripJsonc: comments and trailing commas count only outside strings
import { describe, expect, it } from "vitest";
import { looksLikeJsonc } from "./jsonc.js";

describe("looksLikeJsonc", () => {
  it("is false for plain JSON, however it is formatted", () => {
    expect(looksLikeJsonc("")).toBe(false);
    expect(looksLikeJsonc("{}")).toBe(false);
    expect(looksLikeJsonc('{"a":[1,2,{"b":null}],"c":"d"}')).toBe(false);
    expect(looksLikeJsonc('{\n  "a": [\n    1,\n    2\n  ]\n}\n')).toBe(false);
  });

  it("is true for a line comment", () => {
    expect(looksLikeJsonc('{\n  // my servers\n  "a": 1\n}')).toBe(true);
    expect(looksLikeJsonc('{"a": 1} // trailing')).toBe(true);
  });

  it("is true for a block comment", () => {
    expect(looksLikeJsonc('{/* note */ "a": 1}')).toBe(true);
    expect(looksLikeJsonc('{"a": 1 /* never closed')).toBe(true);
  });

  it("is true for a trailing comma before } or ], across whitespace and newlines", () => {
    expect(looksLikeJsonc('{"a": 1,}')).toBe(true);
    expect(looksLikeJsonc('{"a": [1, 2,]}')).toBe(true);
    expect(looksLikeJsonc('{\n  "a": 1,\n}\n')).toBe(true);
    expect(looksLikeJsonc('{"a": 1,\r\n\t }')).toBe(true);
  });

  it("is false for a comma that is not trailing", () => {
    expect(looksLikeJsonc('{"a": 1, "b": 2}')).toBe(false);
    expect(looksLikeJsonc('[1,\n2]')).toBe(false);
  });

  it("is false when // or /* or a comma-bracket only appears inside a string", () => {
    expect(looksLikeJsonc('{"url": "https://example.com/mcp"}')).toBe(false);
    expect(looksLikeJsonc('{"a": "/* not a comment */"}')).toBe(false);
    expect(looksLikeJsonc('{"a": "x,}"}')).toBe(false);
    expect(looksLikeJsonc('{"a": "// b", "c": "d, ]"}')).toBe(false);
  });

  it("is not fooled by an escaped quote or backslash inside a string", () => {
    expect(looksLikeJsonc('{"a": "say \\"// hi\\" now"}')).toBe(false);
    expect(looksLikeJsonc('{"a": "ends with a backslash \\\\", "b": 1}')).toBe(false);
    expect(looksLikeJsonc('{"a": "x\\\\"} // really a comment')).toBe(true);
  });

  it("terminates on an unterminated string", () => {
    expect(looksLikeJsonc('{"a": "never closed // not a comment')).toBe(false);
    expect(looksLikeJsonc('{"a": "\\')).toBe(false);
  });
});
