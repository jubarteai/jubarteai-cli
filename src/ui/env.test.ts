import { describe, expect, it } from "vitest";

import { fakeStream } from "../../test/helpers/ui-streams.js";
import { detectUiMode } from "./env.js";

const tty = (columns = 100, depth = 24) => fakeStream({ tty: true, columns, depth });
const mode = (stream: object, env: NodeJS.ProcessEnv = {}, extra: { plain?: boolean; verbose?: boolean; platform?: NodeJS.Platform } = {}) =>
  detectUiMode(stream, { env: { LANG: "en_US.UTF-8", ...env }, ...extra });

describe("detectUiMode precedence", () => {
  it("is rich on a terminal with the depth the terminal reports", () => {
    expect(mode(tty(100, 24))).toMatchObject({ rich: true, color: 24, animate: true, columns: 100, unicode: true });
    expect(mode(tty(100, 8)).color).toBe(8);
    expect(mode(tty(100, 4)).color).toBe(4);
    expect(mode(tty(100, 1)).color).toBe(0);
  });

  it("--plain beats everything, including JUBARTEAI_UI=rich and FORCE_COLOR", () => {
    expect(mode(tty(), { JUBARTEAI_UI: "rich", FORCE_COLOR: "3" }, { plain: true })).toMatchObject({ rich: false, color: 0, animate: false });
  });

  it("JUBARTEAI_UI=plain|rich overrides NO_COLOR and the stream", () => {
    expect(mode(tty(), { JUBARTEAI_UI: "plain" }).rich).toBe(false);
    expect(mode(fakeStream(), { JUBARTEAI_UI: "rich" }).rich).toBe(true);
    expect(mode(tty(), { JUBARTEAI_UI: "rich", NO_COLOR: "1" }).rich).toBe(true);
  });

  it("a non-empty NO_COLOR is plain; an empty one is ignored (Node 22 quirk read by us)", () => {
    expect(mode(tty(), { NO_COLOR: "1" }).rich).toBe(false);
    expect(mode(tty(), { NO_COLOR: "" }).rich).toBe(true);
  });

  it("TERM=dumb is plain", () => {
    expect(mode(tty(), { TERM: "dumb" }).rich).toBe(false);
  });

  it("a pipe is plain, unless FORCE_COLOR >= 1: then colours but never animation", () => {
    expect(mode(fakeStream()).rich).toBe(false);
    expect(mode(fakeStream(), { FORCE_COLOR: "3" })).toMatchObject({ rich: true, color: 24, animate: false });
    expect(mode(fakeStream(), { FORCE_COLOR: "1" }).color).toBe(4);
    expect(mode(fakeStream(), { FORCE_COLOR: "2" }).color).toBe(8);
    expect(mode(fakeStream(), { FORCE_COLOR: "0" }).rich).toBe(false);
  });

  it("FORCE_COLOR=0 on a terminal keeps the layout but drops colour", () => {
    expect(mode(tty(), { FORCE_COLOR: "0" })).toMatchObject({ rich: true, color: 0 });
  });

  it("--verbose stops the animation", () => {
    expect(mode(tty(), {}, { verbose: true })).toMatchObject({ rich: true, animate: false, verbose: true });
  });

  it("columns 0 or missing becomes 80", () => {
    expect(mode(tty(0)).columns).toBe(80);
    expect(mode({}).columns).toBe(80);
  });

  it("glyph set: UTF-8 locale on POSIX; WT_SESSION, VS Code or ConEmu on Windows", () => {
    expect(detectUiMode(tty(), { env: { LANG: "C" } }).unicode).toBe(false);
    expect(detectUiMode(tty(), { env: { LC_ALL: "en_US.utf8", LANG: "C" } }).unicode).toBe(true);
    expect(detectUiMode(tty(), { env: {}, platform: "win32" }).unicode).toBe(false);
    expect(detectUiMode(tty(), { env: { WT_SESSION: "x" }, platform: "win32" }).unicode).toBe(true);
    expect(detectUiMode(tty(), { env: { TERM_PROGRAM: "vscode" }, platform: "win32" }).unicode).toBe(true);
    expect(detectUiMode(tty(), { env: { ConEmuANSI: "ON" }, platform: "win32" }).unicode).toBe(true);
  });
});
