import { afterEach, describe, expect, it } from "vitest";

import { fakeStream, fakeTerminal } from "../../test/helpers/ui-streams.js";
import type { FakeTerminal } from "../../test/helpers/ui-streams.js";
import { stripAnsi } from "./display.js";
import { choice } from "./choice.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };
let term: FakeTerminal | null = null;
afterEach(() => {
  term?.restore();
  term = null;
});

const richUi = () => createUi(fakeStream({ tty: true, columns: 100, depth: 24 }), { platform: "linux", env: UTF8 });
const plainUi = () => createUi(fakeStream(), { plain: true, platform: "linux", env: UTF8 });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
const base = { question: "Install jubarteai@1.0.0?", options: ["yes", "no", "show"] as const, defaultIndex: 0, details: () => ["npm install -g jubarteai@1.0.0"] };

describe("choice: rich", () => {
  it("shows Yes preselected and Enter takes it", async () => {
    term = fakeTerminal();
    const pending = choice(richUi(), base);
    await tick();
    expect(stripAnsi(term.shown())).toContain("● Yes  ○ No  ○ Show the exact changes");
    term.type("\r");
    expect(await pending).toBe("yes");
    expect(stripAnsi(term.shown())).toContain("◇  Install jubarteai@1.0.0?  Yes");
  });

  it("arrows move, y/n answer, and Show prints the details then asks again", async () => {
    term = fakeTerminal();
    const pending = choice(richUi(), base);
    await tick();
    term.type("\u001b[C\u001b[C\r"); // to "Show" and Enter
    await tick();
    expect(stripAnsi(term.shown())).toContain("npm install -g jubarteai@1.0.0");
    term.type("n");
    expect(await pending).toBe("no");
  });

  it("d shows, then Enter on a moved selection answers", async () => {
    term = fakeTerminal();
    const pending = choice(richUi(), base);
    await tick();
    term.type("d");
    await tick();
    term.type("\u001b[C\r");
    expect(await pending).toBe("no");
  });

  it("Ctrl-C rejects and Escape is no", async () => {
    term = fakeTerminal();
    const first = choice(richUi(), base);
    await tick();
    term.type("\u0003");
    await expect(first).rejects.toThrow("Cancelled.");
    term.restore();
    term = fakeTerminal();
    const second = choice(richUi(), base);
    await tick();
    term.type("\u001b");
    expect(await second).toBe("no");
  });
});

describe("choice: line form", () => {
  it("asks `Proceed? [Y/n/d]`, Enter is the default", async () => {
    term = fakeTerminal();
    const pending = choice(plainUi(), { ...base, question: "Proceed?" });
    await tick();
    expect(term.shown()).toBe("Proceed? [Y/n/d] ");
    term.type("\n");
    expect(await pending).toBe("yes");
  });

  it("[y/N] when the default is No, and d shows then re-asks", async () => {
    term = fakeTerminal();
    const pending = choice(plainUi(), { ...base, question: "Proceed?", defaultIndex: 1 });
    await tick();
    expect(term.shown()).toBe("Proceed? [y/N/d] ");
    term.type("d\n");
    await tick();
    expect(term.shown()).toContain("npm install -g jubarteai@1.0.0");
    term.type("\n");
    expect(await pending).toBe("no");
  });

  it("two options only: [Y/n]; bad answers three times is no; no terminal is no", async () => {
    term = fakeTerminal();
    const pending = choice(plainUi(), { question: "Go?", options: ["yes", "no"], defaultIndex: 0 });
    await tick();
    expect(term.shown()).toBe("Go? [Y/n] ");
    term.type("x\ny\n");
    expect(await pending).toBe("yes");
    term.restore();
    term = fakeTerminal();
    const bad = choice(plainUi(), { question: "Go?", options: ["yes", "no"], defaultIndex: 0 });
    await tick();
    term.type("x\n");
    await tick();
    term.type("x\n");
    await tick();
    term.type("x\n");
    expect(await bad).toBe("no");
    term.restore();
    term = null;
    expect(await choice(plainUi(), { question: "Go?", options: ["yes", "no"], defaultIndex: 0 })).toBe("no");
  });
});
