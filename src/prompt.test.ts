import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "./errors.js";
import { choose, confirm, controllingTtyPaths, isInteractive, promptHidden, promptLine, setTtyOpenerForTests } from "./prompt.js";
import type { TtyHandle } from "./prompt.js";

type FakeInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };

function fakeTty(): { handle: TtyHandle; input: FakeInput; shown: () => string; closes: () => number; rawCalls: () => boolean[] } {
  const input = new PassThrough() as FakeInput;
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
    return input;
  };
  let shown = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      shown += chunk.toString("utf8");
      callback();
    },
  });
  let closes = 0;
  const handle: TtyHandle = {
    input,
    output,
    close() {
      closes += 1;
    },
  };
  setTtyOpenerForTests(() => handle);
  return { handle, input, shown: () => shown, closes: () => closes, rawCalls: () => rawCalls };
}

afterEach(() => {
  setTtyOpenerForTests(null);
});

describe("with no terminal reachable", () => {
  it("returns the declared defaults", async () => {
    setTtyOpenerForTests(() => null);
    expect(isInteractive()).toBe(false);
    expect(await confirm("Sure?", { defaultYes: true })).toBe(true);
    expect(await confirm("Sure?", { defaultYes: false })).toBe(false);
    expect(await promptLine("Name?", { default: "bob" })).toBe("bob");
    expect(await promptLine("Name?")).toBeNull();
    expect(await promptHidden("Key?")).toBeNull();
    expect(await choose("Pick", [{ label: "a", value: "A" }, { label: "b", value: "B" }], { defaultIndex: 1 })).toBe("B");
  });
});

describe("isInteractive", () => {
  it("is true when a terminal opens, and closes what it opened", () => {
    const tty = fakeTty();
    expect(isInteractive()).toBe(true);
    expect(tty.closes()).toBe(1);
  });
});

describe("controllingTtyPaths", () => {
  it("uses /dev/tty on POSIX and CONIN$/CONOUT$ on Windows", () => {
    expect(controllingTtyPaths("linux")).toEqual({ input: "/dev/tty", output: "/dev/tty" });
    expect(controllingTtyPaths("darwin")).toEqual({ input: "/dev/tty", output: "/dev/tty" });
    expect(controllingTtyPaths("win32")).toEqual({ input: "CONIN$", output: "CONOUT$" });
  });
});

describe("confirm", () => {
  it.each([
    ["y\n", false, true],
    ["YES\n", false, true],
    ["n\n", true, false],
    ["No\r\n", true, false],
    ["\n", true, true],
    ["\n", false, false],
  ])("answers %j (default yes=%s) with %s", async (typed, defaultYes, expected) => {
    const tty = fakeTty();
    tty.input.write(typed);
    expect(await confirm("Go?", { defaultYes })).toBe(expected);
    expect(tty.shown()).toContain(defaultYes ? "Go? [Y/n] " : "Go? [y/N] ");
    expect(tty.closes()).toBe(1);
  });

  it("re-asks after an unusable answer", async () => {
    const tty = fakeTty();
    tty.input.write("maybe\ny\n");
    expect(await confirm("Go?", { defaultYes: false })).toBe(true);
    expect(tty.shown()).toContain("Please answer y or n.");
  });

  it("returns the default on end of input", async () => {
    const tty = fakeTty();
    tty.input.end();
    expect(await confirm("Go?", { defaultYes: true })).toBe(true);
  });

  it("closes the terminal even when the read is cancelled", async () => {
    const tty = fakeTty();
    tty.input.write("\u0003");
    await expect(confirm("Go?", { defaultYes: true })).rejects.toBeInstanceOf(CliError);
    expect(tty.closes()).toBe(1);
  });
});

describe("promptLine", () => {
  it("returns the trimmed answer, the default on empty, and shows the default", async () => {
    const tty = fakeTty();
    tty.input.write("  alice  \n");
    expect(await promptLine("Name?", { default: "bob" })).toBe("alice");
    expect(tty.shown()).toContain("Name? (bob) ");
    tty.input.write("\n");
    expect(await promptLine("Name?", { default: "bob" })).toBe("bob");
    tty.input.write("\n");
    expect(await promptLine("Name?")).toBe("");
  });

  it("serves two prompts from one burst of typed input", async () => {
    const tty = fakeTty();
    tty.input.write("y\nbob\n");
    expect(await confirm("Go?", { defaultYes: false })).toBe(true);
    expect(await promptLine("Name?")).toBe("bob");
  });

  it("rejects an over-long answer", async () => {
    const tty = fakeTty();
    tty.input.write(`${"x".repeat(9000)}\n`);
    await expect(promptLine("Name?")).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("promptHidden", () => {
  it("switches raw mode on then off and never echoes what is typed", async () => {
    const tty = fakeTty();
    tty.input.write("s3cr3t-value\r");
    expect(await promptHidden("Paste code:")).toBe("s3cr3t-value");
    expect(tty.rawCalls()).toEqual([true, false]);
    expect(tty.shown()).toBe("Paste code: \n");
    expect(tty.shown()).not.toContain("s3cr3t");
  });

  it("handles backspace (DEL and BS), ignores arrow-key sequences and control characters", async () => {
    const tty = fakeTty();
    tty.input.write("abcd\u007f\u007fX\b\u001b[A\u001b[1;5CY\u0001Z\n");
    expect(await promptHidden("Key:")).toBe("abYZ");
    expect(tty.shown()).not.toContain("abYZ");
  });

  it("backspaces whole code points", async () => {
    const tty = fakeTty();
    tty.input.write("a😀\u007fb\r");
    expect(await promptHidden("Key:")).toBe("ab");
  });

  it("works when the answer arrives one character at a time", async () => {
    const tty = fakeTty();
    const pending = promptHidden("Key:");
    for (const ch of ["t", "o", "k", "\r"]) tty.input.write(ch);
    expect(await pending).toBe("tok");
  });

  it("ctrl-C restores the terminal and rejects with a cancellation", async () => {
    const tty = fakeTty();
    tty.input.write("abc\u0003");
    await expect(promptHidden("Key:")).rejects.toMatchObject({ code: "cancelled", exitCode: 1 });
    expect(tty.rawCalls()).toEqual([true, false]);
    expect(tty.shown()).not.toContain("abc");
  });

  it("ctrl-D on an empty line is end of input; after text it is ignored", async () => {
    const tty = fakeTty();
    tty.input.write("\u0004");
    expect(await promptHidden("Key:")).toBeNull();
    tty.input.write("ab\u0004c\n");
    expect(await promptHidden("Key:")).toBe("abc");
  });

  it("returns null on end of input with nothing typed", async () => {
    const tty = fakeTty();
    tty.input.end();
    expect(await promptHidden("Key:")).toBeNull();
    expect(tty.rawCalls()).toEqual([true, false]);
  });

  it("an aborted signal resolves null, removes its listeners, restores raw mode and closes the terminal", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    const pending = promptHidden("Key:", { signal: controller.signal });
    expect(tty.input.listenerCount("data")).toBe(1);
    controller.abort();
    expect(await pending).toBeNull();
    expect(tty.input.listenerCount("data")).toBe(0);
    expect(tty.input.listenerCount("end")).toBe(0);
    expect(tty.rawCalls()).toEqual([true, false]);
    expect(tty.closes()).toBe(1);
    // Typing afterwards goes nowhere.
    tty.input.write("late\r");
  });

  it("an already-aborted signal never opens the terminal", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    controller.abort();
    expect(await promptHidden("Key:", { signal: controller.signal })).toBeNull();
    expect(await promptLine("Name?", { signal: controller.signal })).toBeNull();
    expect(tty.shown()).toBe("");
    expect(tty.rawCalls()).toEqual([]);
  });

  it("an answer typed before the abort still wins and leaves no abort listener behind", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    tty.input.write("typed\r");
    expect(await promptHidden("Key:", { signal: controller.signal })).toBe("typed");
    controller.abort();
    expect(tty.rawCalls()).toEqual([true, false]);
  });
});

describe("promptLine signal", () => {
  it("an aborted signal resolves null and removes the listeners", async () => {
    const tty = fakeTty();
    const controller = new AbortController();
    const pending = promptLine("Name?", { signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();
    expect(tty.input.listenerCount("data")).toBe(0);
  });
});

describe("choose", () => {
  const CHOICES = [
    { label: "first", value: 1 },
    { label: "second", value: 2 },
    { label: "third", value: 3 },
  ];

  it("lists the choices and returns the picked value", async () => {
    const tty = fakeTty();
    tty.input.write("3\n");
    expect(await choose("Pick one", CHOICES, { defaultIndex: 0 })).toBe(3);
    expect(tty.shown()).toContain("1) first");
    expect(tty.shown()).toContain("3) third");
  });

  it("returns the default on an empty answer", async () => {
    const tty = fakeTty();
    tty.input.write("\n");
    expect(await choose("Pick one", CHOICES, { defaultIndex: 1 })).toBe(2);
  });

  it("re-asks on 0, a too-large number and text, then accepts a good one", async () => {
    const tty = fakeTty();
    tty.input.write("0\n9\nbanana\n2\n");
    expect(await choose("Pick one", CHOICES, { defaultIndex: 0 })).toBe(2);
  });

  it("falls back to the default after repeated bad answers", async () => {
    const tty = fakeTty();
    tty.input.write("x\n".repeat(6));
    expect(await choose("Pick one", CHOICES, { defaultIndex: 2 })).toBe(3);
  });

  it("rejects an out-of-range defaultIndex", async () => {
    setTtyOpenerForTests(() => null);
    await expect(choose("Pick", CHOICES, { defaultIndex: 7 })).rejects.toBeInstanceOf(RangeError);
  });
});
