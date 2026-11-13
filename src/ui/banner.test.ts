import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fakeStream } from "../../test/helpers/ui-streams.js";
import { stripAnsi } from "./display.js";
import { bannerLines } from "./banner.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };

describe("banner", () => {
  it("is the old installer's six lines of ANSI Shadow art", () => {
    const lines = bannerLines();
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("     ██╗██╗   ██╗██████╗  █████╗ ██████╗ ████████╗███████╗ █████╗ ██╗");
    expect(lines[5]).toBe(" ╚════╝  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝");
    expect(readFileSync(new URL("../../assets/banner.txt", import.meta.url), "utf8").endsWith("\n")).toBe(true);
  });

  it("prints the art with a gradient and the tagline on a 24-bit terminal", () => {
    const out = fakeStream({ tty: true, columns: 100, depth: 24 });
    createUi(out, { platform: "linux", env: { ...UTF8, JUBARTEAI_BANNER: undefined } }).banner("installer");
    expect(out.text()).toContain("38;2;0;136;136");
    expect(out.text()).toContain("38;2;2;224;222");
    const text = stripAnsi(out.text());
    for (const line of bannerLines()) expect(text).toContain(line);
    expect(text).toContain("Agentic Connection Platform · installer");
  });

  it("uses one solid teal at 8 colours and none at 0", () => {
    const eight = fakeStream({ tty: true, columns: 100, depth: 8 });
    createUi(eight, { platform: "linux", env: UTF8 }).banner("updater");
    expect(eight.text()).toContain("38;5;37");
    expect(eight.text()).toContain("· updater");
    const none = fakeStream({ tty: true, columns: 100, depth: 8 });
    createUi(none, { platform: "linux", env: { ...UTF8, FORCE_COLOR: "0" } }).banner("uninstaller");
    expect(none.text()).not.toContain("\u001b");
    expect(none.text()).toContain("· uninstaller");
  });

  it("is a one-line mark under 72 columns", () => {
    const out = fakeStream({ tty: true, columns: 60, depth: 24 });
    createUi(out, { platform: "linux", env: UTF8 }).banner("installer");
    const text = stripAnsi(out.text());
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).toContain("◆ JubarteAI");
  });

  it("uses > for the compact mark off a UTF-8 terminal", () => {
    const out = fakeStream({ tty: true, columns: 60, depth: 24 });
    createUi(out, { platform: "linux", env: { LANG: "C" } }).banner("installer");
    expect(stripAnsi(out.text())).toContain("> JubarteAI");
  });

  it("prints nothing in plain mode or with JUBARTEAI_BANNER=off", () => {
    const pipe = fakeStream();
    createUi(pipe, { plain: true, platform: "linux", env: UTF8 }).banner("installer");
    expect(pipe.text()).toBe("");
    const off = fakeStream({ tty: true, columns: 100, depth: 24 });
    createUi(off, { platform: "linux", env: { ...UTF8, JUBARTEAI_BANNER: "off" } }).banner("installer");
    expect(off.text()).toBe("");
  });
});
