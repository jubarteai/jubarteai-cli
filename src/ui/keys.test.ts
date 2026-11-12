import { describe, expect, it } from "vitest";

import { KeyDecoder } from "./keys.js";

const names = (keys: Array<{ name: string; char?: string }>): string[] => keys.map((k) => (k.name === "char" ? `char:${k.char ?? ""}` : k.name));

describe("KeyDecoder", () => {
  it("decodes CSI and SS3 arrows, space, enter (CRLF is one), Ctrl-C, Ctrl-D, backspace and characters", () => {
    const d = new KeyDecoder();
    expect(names(d.push("\u001b[A\u001b[B\u001b[C\u001b[D"))).toEqual(["up", "down", "right", "left"]);
    expect(names(d.push("\u001bOA\u001bOB"))).toEqual(["up", "down"]);
    expect(names(d.push(" \r\n\u0003\u0004\u007fd"))).toEqual(["space", "enter", "ctrl-c", "ctrl-d", "backspace", "char:d"]);
  });

  it("treats CRLF as one Enter", () => {
    expect(names(new KeyDecoder().push("\r\n"))).toEqual(["enter"]);
  });

  it("decodes Windows scan-code arrows", () => {
    expect(names(new KeyDecoder().push("\u0000HàP\u0000KàM"))).toEqual(["up", "down", "left", "right"]);
  });

  it("keeps a sequence split across chunks", () => {
    const d = new KeyDecoder();
    expect(d.push("\u001b")).toEqual([]);
    expect(d.hasPending()).toBe(true);
    expect(names(d.push("[A"))).toEqual(["up"]);
    expect(d.push("\u001b[")).toEqual([]);
    expect(names(d.push("1;5C"))).toEqual([]); // modified arrow: swallowed whole, not misread
    expect(names(d.push("x"))).toEqual(["char:x"]);
  });

  it("a lone Escape resolves on flush; a following key makes it the Escape key", () => {
    const d = new KeyDecoder();
    d.push("\u001b");
    expect(names(d.flush())).toEqual(["escape"]);
    expect(names(d.push("\u001bq"))).toEqual(["escape", "char:q"]);
    expect(d.flush()).toEqual([]);
  });

  it("drops unknown sequences (Home, Delete, function keys) without producing keys", () => {
    expect(names(new KeyDecoder().push("\u001b[H\u001b[3~\u001bOP"))).toEqual([]);
  });
});
