import { describe, expect, it } from "vitest";

import { fakeStream } from "../../test/helpers/ui-streams.js";
import { stripAnsi } from "./display.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("spin", () => {
  it("prints nothing when not animating (plain, pipe, verbose)", async () => {
    for (const [out, opts] of [
      [fakeStream(), { plain: true }],
      [fakeStream({ tty: true, columns: 80 }), { verbose: true }],
    ] as const) {
      const ui = createUi(out, { ...opts, env: UTF8 });
      expect(await ui.spin("Working", async () => sleep(200).then(() => 7))).toBe(7);
      expect(out.text()).toBe("");
    }
  });

  it("shows no frame for fast work, braille frames for slow work, and restores the cursor on resolve", async () => {
    const out = fakeStream({ tty: true, columns: 80, depth: 24 });
    const ui = createUi(out, { env: UTF8 });
    await ui.spin("Quick", async () => sleep(10));
    expect(out.text()).toBe("");
    await ui.spin("Slow", async () => sleep(400));
    expect(out.text()).toContain("\u001b[?25l");
    expect(out.text()).toContain("Slow");
    expect(out.text()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out.text().endsWith("\u001b[?25h")).toBe(true);
  });

  it("uses ASCII frames off a UTF-8 terminal and restores the cursor on reject", async () => {
    const out = fakeStream({ tty: true, columns: 80, depth: 8 });
    const ui = createUi(out, { env: { LANG: "C" } });
    await expect(
      ui.spin("Boom", async () => {
        await sleep(300);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(stripAnsi(out.text())).toMatch(/[|/\\-] {2}Boom/);
    expect(out.text()).not.toMatch(/[⠋⠙⠹]/);
    expect(out.text().endsWith("\u001b[?25h")).toBe(true);
  });
});
