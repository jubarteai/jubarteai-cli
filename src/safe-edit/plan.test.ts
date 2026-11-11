// Scenarios ported from the app's install.sh / update.sh behaviour (record_step, the final summary, --yes / no-TTY
// handling) and src/lib/install-script.test.ts. B3 maps each deleted test to one below.
//
// ported: a step that fails is reported as failed and the run goes on with the next one
// ported: each step ends as configured | already configured | skipped | failed, and the summary prints one line per step
// ported: --yes runs every step without asking; without a TTY and without --yes nothing sensitive is applied
// ported: run with no TTY (curl | bash): hooks and permission files are skipped and named with the flag that applies them
// ported: a config it can't write is reported as failed (exit 1) and left as it was
// ported: the key never appears in a summary line or a prompt preview
//
// New in the CLI (spec §6.1 steps 3 and 7, §8 I6): one "Proceed? [Y/n]" for the plan, one prompt per sensitive step
// showing its exact entry; every prompt goes through the injectable confirm function.
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, ExitCode } from "../errors.js";
import { setTtyOpenerForTests, type confirm } from "../prompt.js";
import { SafeEditError } from "./atomic-write.js";
import { applyPlan, summarize, type PlanStep, type StepResult } from "./plan.js";

type Confirm = typeof confirm;

function collector(): { out: NodeJS.WritableStream; text: () => string } {
  const sink = new PassThrough();
  let text = "";
  sink.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return { out: sink, text: () => text };
}

function step(id: string, over: Partial<PlanStep> = {}, status: StepResult["status"] = "configured"): PlanStep & { ran: () => number } {
  let ran = 0;
  return {
    id,
    label: `Step ${id}`,
    files: [`/home/me/${id}.json`],
    sensitive: false,
    async apply() {
      ran++;
      return { id, label: `Step ${id}`, status };
    },
    ...over,
    ran: () => ran,
  };
}

function answers(...replies: boolean[]): { fn: Confirm; asked: Array<{ question: string; defaultYes: boolean }> } {
  const asked: Array<{ question: string; defaultYes: boolean }> = [];
  const queue = [...replies];
  const fn: Confirm = async (question, opts) => {
    asked.push({ question, defaultYes: opts.defaultYes });
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected extra prompt");
    return next;
  };
  return { fn, asked };
}

const neverAsked: Confirm = async () => {
  throw new Error("must not prompt");
};

afterEach(() => {
  setTtyOpenerForTests(null);
});

describe("applyPlan: printing the plan", () => {
  it("does nothing for an empty plan", async () => {
    const c = collector();
    expect(await applyPlan([], { tty: true, yes: false, out: c.out, confirmFn: neverAsked })).toEqual([]);
    expect(c.text()).toBe("");
  });

  it("prints each step's label and files, and marks the sensitive ones", async () => {
    const c = collector();
    await applyPlan([step("a"), step("b", { sensitive: true, files: ["/p/one", "/p/two"] })], { tty: false, yes: true, out: c.out, confirmFn: neverAsked });
    expect(c.text()).toBe("This will make these changes:\n  - Step a\n      /home/me/a.json\n  - Step b (asks first)\n      /p/one\n      /p/two\n");
  });

  it("strips control characters and secrets from what it prints", async () => {
    const c = collector();
    await applyPlan([step("a", { label: "Add \u001b[31mred\u001b[0m jba_ABCDEF123456", files: ["/x/\u0007bell\n/y"] })], {
      tty: false,
      yes: true,
      out: c.out,
      confirmFn: neverAsked,
    });
    expect(c.text()).not.toContain("\u001b");
    expect(c.text()).not.toContain("\u0007");
    expect(c.text()).not.toContain("jba_ABCDEF123456");
    expect(c.text()).toContain("[redacted]");
    expect(c.text().split("\n").filter((l) => l.startsWith("      ")).length).toBe(1);
  });
});

describe("applyPlan: duplicate steps", () => {
  it("steps sharing an id are printed, prompted and run once, first occurrence wins, order kept", async () => {
    const c = collector();
    const first = step("copilot:hooks", { sensitive: true, label: "First", preview: "entry" });
    const second = step("copilot:hooks", { sensitive: true, label: "Second" });
    const other = step("b");
    const { fn, asked } = answers(true, true);
    const res = await applyPlan([first, other, second], { tty: true, yes: false, out: c.out, confirmFn: fn });
    expect(first.ran()).toBe(1);
    expect(second.ran()).toBe(0);
    expect(asked.map((a) => a.question)).toEqual(["Proceed?", 'Apply "First"?']);
    expect(c.text().split("First").length - 1).toBe(2); // once in the plan, once above its own prompt
    expect(c.text()).not.toContain("Second");
    expect(res.map((r) => r.id)).toEqual(["copilot:hooks", "b"]);
    expect(summarize(res)).toHaveLength(2);
  });
});

describe("applyPlan: step kind", () => {
  it("an info step is printed, run and summarized exactly like a change step (the kind is for callers only)", async () => {
    const run = async (kind: PlanStep["kind"]): Promise<{ text: string; lines: string[]; ran: number }> => {
      const c = collector();
      const s = step("a", kind === undefined ? {} : { kind }, "already configured");
      const res = await applyPlan([s], { tty: false, yes: false, out: c.out, confirmFn: neverAsked });
      return { text: c.text(), lines: summarize(res), ran: s.ran() };
    };
    const info = await run("info");
    expect(info.ran).toBe(1);
    expect(info.lines).toEqual(["Step a: already configured"]);
    expect(await run("change")).toEqual(info);
    expect(await run(undefined)).toEqual(info);
  });
});

describe("applyPlan: on a TTY", () => {
  it("asks Proceed? once with default yes, then runs every non-sensitive step in order", async () => {
    const order: string[] = [];
    const mk = (id: string): PlanStep => ({
      id,
      label: id,
      files: [],
      sensitive: false,
      async apply() {
        order.push(id);
        return { id, label: id, status: "configured" };
      },
    });
    const { fn, asked } = answers(true);
    const res = await applyPlan([mk("a"), mk("b"), mk("c")], { tty: true, yes: false, out: collector().out, confirmFn: fn });
    expect(asked).toEqual([{ question: "Proceed?", defaultYes: true }]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(res.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
  });

  it("declining Proceed? applies nothing and skips every step as declined", async () => {
    const a = step("a");
    const b = step("b", { sensitive: true });
    const { fn, asked } = answers(false);
    const res = await applyPlan([a, b], { tty: true, yes: false, out: collector().out, confirmFn: fn });
    expect(asked.length).toBe(1);
    expect(a.ran() + b.ran()).toBe(0);
    expect(res).toEqual([
      { id: "a", label: "Step a", status: "skipped", detail: "declined" },
      { id: "b", label: "Step b", status: "skipped", detail: "declined" },
    ]);
  });

  it("a sensitive step gets its own prompt showing the exact entry, default yes", async () => {
    const c = collector();
    const s = step("hook", { sensitive: true, label: "Add the SessionStart hook", preview: '{\n  "command": "jubarteai hook"\n}' });
    const { fn, asked } = answers(true, true);
    const res = await applyPlan([step("a"), s], { tty: true, yes: false, out: c.out, confirmFn: fn });
    expect(asked).toEqual([
      { question: "Proceed?", defaultYes: true },
      { question: 'Apply "Add the SessionStart hook"?', defaultYes: true },
    ]);
    expect(c.text()).toContain('      {\n        "command": "jubarteai hook"\n      }\n');
    expect(s.ran()).toBe(1);
    expect(res[1]?.status).toBe("configured");
  });

  it("declining one sensitive step skips only it", async () => {
    const a = step("a");
    const s = step("s", { sensitive: true, flag: "--hooks" });
    const z = step("z");
    const { fn } = answers(true, false);
    const res = await applyPlan([a, s, z], { tty: true, yes: false, out: collector().out, confirmFn: fn });
    expect([a.ran(), s.ran(), z.ran()]).toEqual([1, 0, 1]);
    expect(res.map((r) => r.status)).toEqual(["configured", "skipped", "configured"]);
    expect(res[1]?.detail).toBe("declined");
  });

  it("redacts a key and control characters in a preview", async () => {
    const c = collector();
    const s = step("s", { sensitive: true, preview: 'Authorization: "Bearer jba_SECRETSECRET1"\u001b[2J\tx' });
    const { fn } = answers(true, true);
    await applyPlan([s], { tty: true, yes: false, out: c.out, confirmFn: fn });
    expect(c.text()).not.toContain("jba_SECRETSECRET1");
    expect(c.text()).not.toContain("\u001b");
    expect(c.text()).toContain("[redacted]");
  });

  it("a cancelled prompt rejects and later steps never run", async () => {
    const a = step("a");
    const s = step("s", { sensitive: true });
    const z = step("z");
    const cancel: Confirm = vi.fn(async (q: string) => {
      if (q === "Proceed?") return true;
      throw new CliError("Cancelled.", ExitCode.SERVER_ERROR, "cancelled");
    });
    await expect(applyPlan([a, s, z], { tty: true, yes: false, out: collector().out, confirmFn: cancel })).rejects.toBeInstanceOf(CliError);
    expect([a.ran(), s.ran(), z.ran()]).toEqual([1, 0, 0]);
  });

  it("uses the real confirm by default: Proceed? [Y/n] on the terminal, Enter accepts", async () => {
    const input = new PassThrough();
    let shown = "";
    const output = new PassThrough();
    output.on("data", (c: Buffer) => {
      shown += c.toString("utf8");
    });
    setTtyOpenerForTests(() => ({ input, output, close: () => undefined }));
    input.write("\n");
    const a = step("a");
    const res = await applyPlan([a], { tty: true, yes: false, out: collector().out });
    expect(shown).toContain("Proceed? [Y/n] ");
    expect(a.ran()).toBe(1);
    expect(res[0]?.status).toBe("configured");
  });
});

describe("applyPlan: no TTY", () => {
  it("runs non-sensitive steps without asking and skips sensitive ones with the default flag", async () => {
    const a = step("a");
    const s = step("s", { sensitive: true });
    const res = await applyPlan([a, s], { tty: false, yes: false, out: collector().out, confirmFn: neverAsked });
    expect(a.ran()).toBe(1);
    expect(s.ran()).toBe(0);
    expect(res[1]).toEqual({ id: "s", label: "Step s", status: "skipped", detail: "needs confirmation", flag: "--yes" });
  });

  it("a sensitive step's own flag is the one reported", async () => {
    const res = await applyPlan([step("s", { sensitive: true, flag: "--install-hooks" })], { tty: false, yes: false, out: collector().out, confirmFn: neverAsked });
    expect(res[0]?.flag).toBe("--install-hooks");
  });
});

describe("applyPlan: --yes", () => {
  for (const tty of [true, false]) {
    it(`runs every step with no prompt (tty: ${tty})`, async () => {
      const steps = [step("a"), step("s", { sensitive: true, preview: "entry" }), step("z")];
      const res = await applyPlan(steps, { tty, yes: true, out: collector().out, confirmFn: neverAsked });
      expect(steps.map((s) => s.ran())).toEqual([1, 1, 1]);
      expect(res.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
    });
  }
});

describe("applyPlan: steps that fail", () => {
  it("a throwing step is failed with a fixed detail and the rest still run", async () => {
    const boom = step("boom", {
      async apply() {
        throw new Error("secret jba_LEAKLEAKLEAK in /home/me/.cursor/mcp.json");
      },
    });
    const after = step("after");
    const res = await applyPlan([boom, after], { tty: false, yes: true, out: collector().out, confirmFn: neverAsked });
    expect(res[0]).toEqual({ id: "boom", label: "Step boom", status: "failed", detail: "unexpected error" });
    expect(after.ran()).toBe(1);
    expect(JSON.stringify(res)).not.toContain("LEAKLEAK");
  });

  it("a guard refusal names its reason, never the path", async () => {
    const s = step("s", {
      async apply() {
        throw new SafeEditError("Refusing to write /home/me/secret-dir/mcp.json: it is a symbolic link", "symlink");
      },
    });
    const res = await applyPlan([s], { tty: false, yes: true, out: collector().out, confirmFn: neverAsked });
    expect(res[0]?.detail).toBe("could not write (symlink)");
  });

  it("a Node error names its code, never its message", async () => {
    const s = step("s", {
      async apply() {
        throw Object.assign(new Error("EACCES: permission denied, open '/home/me/jba_KEYKEYKEY1/x'"), { code: "EACCES" });
      },
    });
    const res = await applyPlan([s], { tty: false, yes: true, out: collector().out, confirmFn: neverAsked });
    expect(res[0]?.detail).toBe("could not write (EACCES)");
  });

  it("an odd error code is not trusted as text", async () => {
    const s = step("s", {
      async apply() {
        throw Object.assign(new Error("x"), { code: "has spaces and a /path" });
      },
    });
    const res = await applyPlan([s], { tty: false, yes: true, out: collector().out, confirmFn: neverAsked });
    expect(res[0]?.detail).toBe("unexpected error");
  });

  it("a step that returns failed keeps its own detail and flag; id and label come from the step", async () => {
    const s = step("s", {
      async apply() {
        return { id: "other", label: "Other", status: "failed", detail: "the file has comments", flag: "--force" };
      },
    });
    const res = await applyPlan([s], { tty: false, yes: true, out: collector().out, confirmFn: neverAsked });
    expect(res[0]).toEqual({ id: "s", label: "Step s", status: "failed", detail: "the file has comments", flag: "--force" });
  });

  it("a step that returns already configured is passed through", async () => {
    const res = await applyPlan([step("s", {}, "already configured")], { tty: false, yes: false, out: collector().out, confirmFn: neverAsked });
    expect(res[0]?.status).toBe("already configured");
  });
});

describe("summarize", () => {
  const r = (status: StepResult["status"], over: Partial<StepResult> = {}): StepResult => ({ id: "x", label: "Cursor MCP", status, ...over });

  it("one line per step in the pinned shapes", () => {
    expect(
      summarize([
        r("configured"),
        r("already configured", { label: "Skill" }),
        r("skipped", { label: "Hook", detail: "needs confirmation", flag: "--yes" }),
        r("failed", { label: "Codex MCP", detail: "could not write (symlink)" }),
      ]),
    ).toEqual([
      "Cursor MCP: configured",
      "Skill: already configured",
      "Hook: skipped (needs confirmation; rerun with --yes)",
      "Codex MCP: failed: could not write (symlink)",
    ]);
  });

  it("skipped and failed without every part", () => {
    expect(summarize([r("skipped"), r("skipped", { detail: "declined" }), r("skipped", { flag: "--yes" }), r("failed")])).toEqual([
      "Cursor MCP: skipped",
      "Cursor MCP: skipped (declined)",
      "Cursor MCP: skipped (rerun with --yes)",
      "Cursor MCP: failed",
    ]);
  });

  it("never prints a key or a control character", () => {
    const [line] = summarize([r("failed", { label: "A\u001b[31m jba_ABCDEFGH", detail: "bad\u0007 jbw_ABCDEFGH" })]);
    expect(line).not.toMatch(/jb[aw]_ABCDEFGH/);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
  });

  it("is empty for no results", () => {
    expect(summarize([])).toEqual([]);
  });
});
