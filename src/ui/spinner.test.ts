import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeStream } from "../../test/helpers/ui-streams.js";
import { stripAnsi } from "./display.js";
import { createUi } from "./index.js";

const UTF8 = { LANG: "en_US.UTF-8" };

describe("spin", () => {
  // The spinner's start delay and frames run on timers: fake ones, so "slow work" is a clock advanced on purpose.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Work that settles after `ms` of (fake) time: with what `settle` returns, or rejected with what it throws. */
  const after =
    <T>(ms: number, settle: () => T): (() => Promise<T>) =>
    () =>
      new Promise<T>((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(settle());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }, ms),
      );

  it("prints nothing when not animating (plain, pipe, verbose)", async () => {
    for (const [out, opts] of [
      [fakeStream(), { plain: true }],
      [fakeStream({ tty: true, columns: 80 }), { verbose: true }],
    ] as const) {
      const ui = createUi(out, { ...opts, env: UTF8 });
      const pending = ui.spin("Working", after(200, () => 7));
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toBe(7);
      expect(out.text()).toBe("");
    }
  });

  it("shows no frame for fast work, braille frames for slow work, and restores the cursor on resolve", async () => {
    const out = fakeStream({ tty: true, columns: 80, depth: 24 });
    const ui = createUi(out, { env: UTF8 });
    const quick = ui.spin("Quick", after(10, () => undefined));
    await vi.advanceTimersByTimeAsync(10);
    await quick;
    expect(out.text()).toBe("");
    const slow = ui.spin("Slow", after(400, () => undefined));
    await vi.advanceTimersByTimeAsync(400);
    await slow;
    expect(out.text()).toContain("\u001b[?25l");
    expect(out.text()).toContain("Slow");
    expect(out.text()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out.text().endsWith("\u001b[?25h")).toBe(true);
  });

  it("uses ASCII frames off a UTF-8 terminal and restores the cursor on reject", async () => {
    const out = fakeStream({ tty: true, columns: 80, depth: 8 });
    const ui = createUi(out, { env: { LANG: "C" } });
    const failing = expect(
      ui.spin(
        "Boom",
        after(300, () => {
          throw new Error("nope");
        }),
      ),
    ).rejects.toThrow("nope");
    await vi.advanceTimersByTimeAsync(300);
    await failing;
    expect(stripAnsi(out.text())).toMatch(/[|/\\-] {2}Boom/);
    expect(out.text()).not.toMatch(/[⠋⠙⠹]/);
    expect(out.text().endsWith("\u001b[?25h")).toBe(true);
  });
});

describe("spin: a terminating signal while a frame is live", () => {
  const HIDE = "\u001b[?25l";
  const SHOW = "\u001b[?25h";
  const SIGNALS = ["SIGINT", "SIGTERM"] as const;
  type Listener = (...args: unknown[]) => void;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const listeners = (signal: NodeJS.Signals): Listener[] => process.listeners(signal) as Listener[];
  /** The listeners on `signal` that were not there in `before`: the spinner's own. */
  const addedSince = (signal: NodeJS.Signals, before: readonly Listener[]): Listener[] => listeners(signal).filter((l) => !before.includes(l));

  /** A live spinner on a terminal: started, past its start delay, with its first frame drawn. */
  async function liveSpinner(): Promise<{ out: ReturnType<typeof fakeStream>; finish: () => Promise<void> }> {
    const out = fakeStream({ tty: true, columns: 80, depth: 24 });
    const work = deferred();
    const pending = createUi(out, { env: UTF8 }).spin("Slow", () => work.promise);
    await vi.advanceTimersByTimeAsync(200);
    expect(out.text()).toContain(HIDE);
    return {
      out,
      finish: async () => {
        work.resolve();
        await pending;
      },
    };
  }

  it("listens for SIGINT and SIGTERM only while a frame is live, and never for fast work", async () => {
    const before = { SIGINT: listeners("SIGINT"), SIGTERM: listeners("SIGTERM") };
    // Fast work: done before the start delay, so no frame and no listener, then or later.
    const quick = createUi(fakeStream({ tty: true, columns: 80, depth: 24 }), { env: UTF8 }).spin("Quick", async () => 1);
    expect(await quick).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    for (const signal of SIGNALS) expect(addedSince(signal, before[signal])).toHaveLength(0);

    const live = await liveSpinner();
    for (const signal of SIGNALS) expect(addedSince(signal, before[signal])).toHaveLength(1);
    await live.finish();
    for (const signal of SIGNALS) expect(addedSince(signal, before[signal])).toHaveLength(0);
    expect(live.out.text().endsWith(SHOW)).toBe(true);
  });

  it("two live spinners share one listener per signal, which goes when the last one settles", async () => {
    const before = listeners("SIGINT");
    const first = await liveSpinner();
    const second = await liveSpinner();
    expect(addedSince("SIGINT", before)).toHaveLength(1);
    await first.finish();
    expect(addedSince("SIGINT", before)).toHaveLength(1);
    await second.finish();
    expect(addedSince("SIGINT", before)).toHaveLength(0);
  });

  for (const signal of SIGNALS) {
    it(`${signal}: shows the cursor again and, when the program listens too, leaves ending the process to that listener`, async () => {
      const own = vi.fn();
      process.on(signal, own);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const before = listeners(signal);
        const live = await liveSpinner();
        const [handler] = addedSince(signal, before);
        expect(handler).toBeDefined();
        handler?.();
        expect(live.out.text().endsWith(SHOW)).toBe(true);
        expect(live.out.text().lastIndexOf(SHOW)).toBeGreaterThan(live.out.text().lastIndexOf(HIDE));
        expect(kill).not.toHaveBeenCalled();
        // Both of the spinner's listeners are gone, the program's own stays.
        for (const s of SIGNALS) expect(listeners(s).filter((l) => !before.includes(l) && l !== own)).toHaveLength(0);
        expect(listeners(signal)).toContain(own);
        await live.finish();
      } finally {
        process.off(signal, own);
      }
    });

    it(`${signal}: with no other listener, re-raises the signal after showing the cursor, so the process ends as it would have`, async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const before = listeners(signal);
      const live = await liveSpinner();
      const [handler] = addedSince(signal, before);
      expect(handler).toBeDefined();
      // Nobody else listens at the moment the signal lands: take the test runner's listeners off for that instant only.
      for (const l of before) process.off(signal, l);
      try {
        handler?.();
      } finally {
        for (const l of before) process.on(signal, l);
      }
      expect(live.out.text().endsWith(SHOW)).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      await live.finish();
    });
  }
});
