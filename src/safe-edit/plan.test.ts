// applyPlan is the single gate for sensitive writes (invariant I6). Scenarios ported from the app's install.sh /
// update.sh behaviour (record_step, the final summary, --yes / no-TTY handling), now with one approval for the plan
// (a grouped checklist or one Yes / No / Show question) in place of a prompt per sensitive step.
//
// ported: a step that fails is reported as failed and the run goes on with the next one
// ported: each step ends as configured | already configured | skipped | failed, and the summary prints one line per step
// ported: --yes runs every step without asking; without a TTY and without --yes nothing sensitive is applied
// ported: run with no TTY (curl | bash): hooks and permission files are skipped and named with the flag that applies them
// ported: a config it can't write is reported as failed (exit 1) and left as it was
// ported: the key never appears in a summary line or a preview
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeStream, fakeTerminal } from "../../test/helpers/ui-streams.js";
import type { FakeTerminal } from "../../test/helpers/ui-streams.js";
import { CliError, ExitCode } from "../errors.js";
import { MACHINE_GROUP, DECLINED, NEEDS_PERSON, NOT_SELECTED, applyPlan, harnessGroup, repoGroup, summarize } from "./plan.js";
import type { ApplyOptions, PlanStep, StepResult } from "./plan.js";
import { rowKey } from "./approval.js";
import { createUi } from "../ui/index.js";
import type { ChecklistGroup, ChecklistResult } from "../ui/checklist.js";

let term: FakeTerminal | null = null;
afterEach(() => {
  term?.restore();
  term = null;
  vi.unstubAllEnvs();
});

function harness() {
  const out = fakeStream();
  const ui = createUi(out, { plain: true, env: { LANG: "en_US.UTF-8" } });
  return { out, ui, timeline: ui.timeline() };
}

function step(id: string, over: Partial<PlanStep> = {}, status: StepResult["status"] = "configured"): PlanStep & { ran: () => number } {
  let ran = 0;
  return {
    id,
    label: `Step ${id}`,
    group: MACHINE_GROUP,
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

type Seen = { groups: ChecklistGroup[]; details: (checked: ReadonlySet<string>) => string[] };

/** An `approve` seam that records what it was shown and answers with `pick(groups)` (all rows checked by default). */
function approver(pick?: (groups: ChecklistGroup[]) => ChecklistResult): { approve: NonNullable<ApplyOptions["approve"]>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    approve: async (groups, details) => {
      seen.push({ groups, details });
      return pick !== undefined ? pick(groups) : { kind: "apply", checked: new Set(groups.flatMap((g) => g.rows.map((r) => r.key))) };
    },
  };
}

const opts = (h: ReturnType<typeof harness>, over: Partial<ApplyOptions> = {}): ApplyOptions => ({
  tty: false,
  yes: false,
  ui: h.ui,
  timeline: h.timeline,
  approval: "checklist",
  title: "Choose what to set up",
  agentSession: null,
  ...over,
});

describe("applyPlan: the plan and its output", () => {
  it("does nothing for an empty plan", async () => {
    const h = harness();
    expect(await applyPlan([], opts(h))).toEqual([]);
    expect(h.out.text()).toBe("");
  });

  it("streams one timeline row per step as it finishes", async () => {
    const h = harness();
    await applyPlan([step("a", { group: harnessGroup("claude-code") }), step("b", { group: repoGroup("/r") })], opts(h, { yes: true }));
    expect(h.out.text()).toBe("[ok]   Claude Code · Step a: configured\n[ok]   Repo · Step b: configured\n");
  });

  it("strips control characters and secrets from what it prints", async () => {
    const h = harness();
    await applyPlan([step("a", { label: "Add \u001b[31mred\u001b[0m jba_ABCDEF123456" })], opts(h, { yes: true }));
    expect(h.out.text()).not.toContain("\u001b");
    expect(h.out.text()).not.toContain("jba_ABCDEF123456");
    expect(h.out.text()).toContain("[redacted]");
  });

  it("a step that finished says what it did after its literal status", async () => {
    const h = harness();
    await applyPlan([step("a", { async apply() { return { id: "a", label: "Skill", status: "configured", detail: "updated 1.2 -> 1.3" }; } })], opts(h, { yes: true }));
    expect(h.out.text()).toContain("configured — updated 1.2 -> 1.3");
  });

  it("a failed step's log tail is shown under its row", async () => {
    const h = harness();
    await applyPlan([step("a", { async apply() { return { id: "a", label: "Skill", status: "failed", detail: "npx error", log: ["boom one", "boom two"] }; } })], opts(h, { yes: true }));
    expect(h.out.text()).toContain("failed: npx error");
    expect(h.out.text()).toContain("        boom one");
  });
});

describe("applyPlan: duplicate steps", () => {
  it("steps sharing an id are rendered and run once, first occurrence wins, order kept", async () => {
    const h = harness();
    const first = step("copilot:hooks", { sensitive: true, label: "First", group: harnessGroup("vscode") });
    const second = step("copilot:hooks", { sensitive: true, label: "Second", group: harnessGroup("copilot-cli") });
    const other = step("b");
    const a = approver();
    const res = await applyPlan([first, other, second], opts(h, { tty: true, approve: a.approve }));
    expect(first.ran()).toBe(1);
    expect(second.ran()).toBe(0);
    expect(res.map((r) => r.id)).toEqual(["copilot:hooks", "b"]);
    expect(a.seen[0]?.groups.flatMap((g) => g.rows.map((r) => r.label))).toEqual(["First", "Step b"]);
  });
});

describe("applyPlan: step kind", () => {
  it("an info step is run and summarized exactly like a change step; the checklist offers no row for it", async () => {
    const run = async (kind: PlanStep["kind"]): Promise<{ lines: string[]; ran: number }> => {
      const h = harness();
      const s = step("a", kind === undefined ? {} : { kind }, "already configured");
      const res = await applyPlan([s], opts(h));
      return { lines: summarize(res), ran: s.ran() };
    };
    const info = await run("info");
    expect(info.ran).toBe(1);
    expect(info.lines).toEqual(["Step a: already configured"]);
    expect(await run("change")).toEqual(info);
    expect(await run(undefined)).toEqual(info);
    const h = harness();
    const a = approver();
    await applyPlan([step("i", { kind: "info" }), step("c")], opts(h, { tty: true, approve: a.approve }));
    expect(a.seen[0]?.groups.flatMap((g) => g.rows.map((r) => r.label))).toEqual(["Step c"]);
  });
});

describe("applyPlan: on a person's terminal", () => {
  it("shows ONE checklist with every row checked and runs the checked rows in order", async () => {
    const order: string[] = [];
    const mk = (id: string, sensitive: boolean, group: PlanStep["group"]): PlanStep =>
      step(id, { sensitive, group, async apply() { order.push(id); return { id, label: `Step ${id}`, status: "configured" }; } });
    const h = harness();
    const a = approver();
    const res = await applyPlan(
      [mk("claude:hooks", true, harnessGroup("claude-code")), mk("codex:hooks", true, harnessGroup("codex")), mk("agents-md", false, repoGroup("/r"))],
      opts(h, { tty: true, approve: a.approve }),
    );
    expect(a.seen).toHaveLength(1);
    expect(a.seen[0]?.groups.map((g) => [g.title, g.rows.every((r) => r.checked)])).toEqual([["Claude Code", true], ["Codex", true], ["Repo", true]]);
    expect(order).toEqual(["claude:hooks", "codex:hooks", "agents-md"]);
    expect(res.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
  });

  it("no 'Apply …?' prompt exists anywhere: a checked sensitive step runs with no further question", async () => {
    term = fakeTerminal();
    const h = harness();
    const s = step("s", { sensitive: true });
    const a = approver();
    await applyPlan([s], opts(h, { tty: true, approve: a.approve }));
    expect(term.shown()).toBe("");
    expect(s.ran()).toBe(1);
  });

  it("an unchecked row is skipped as not selected and its step never runs", async () => {
    const h = harness();
    const a = step("a");
    const b = step("b", { sensitive: true });
    const res = await applyPlan(
      [a, b],
      opts(h, { tty: true, approve: approver((groups) => ({ kind: "apply", checked: new Set(groups.flatMap((g) => g.rows).filter((r) => r.label === "Step a").map((r) => r.key)) })).approve }),
    );
    expect([a.ran(), b.ran()]).toEqual([1, 0]);
    expect(res[1]).toEqual({ id: "b", label: "Step b", status: "skipped", detail: NOT_SELECTED });
  });

  it("a step serving several harnesses runs narrowed to the ones still checked, and not at all when none is", async () => {
    const h = harness();
    const narrowed: string[][] = [];
    const skill = step("skill-install", {
      group: harnessGroup("claude-code"),
      alsoGroups: ["codex", "cursor"],
      narrow: (keep) => {
        narrowed.push([...keep].sort());
        return keep.size === 0 ? null : step("skill-install", { label: `Install skill for ${[...keep].join(", ")}` });
      },
    });
    const result = await applyPlan(
      [skill],
      opts(h, {
        tty: true,
        approve: approver((groups) => ({ kind: "apply", checked: new Set(groups.filter((g) => g.title !== "Codex").flatMap((g) => g.rows.map((r) => r.key))) })).approve,
      }),
    );
    expect(narrowed).toEqual([["claude-code", "cursor"]]);
    expect(result[0]?.label).toMatch(/^Install skill for /);
    expect(result[0]?.status).toBe("configured");

    const none = await applyPlan([skill], opts(harness(), { tty: true, approve: approver(() => ({ kind: "apply", checked: new Set([rowKey(step("other"), MACHINE_GROUP)]) })).approve }));
    expect(none[0]).toMatchObject({ status: "skipped", detail: NOT_SELECTED });
  });

  it("declined applies nothing, skips every step as declined and closes with Aborted.", async () => {
    const h = harness();
    const a = step("a");
    const b = step("b", { sensitive: true });
    const res = await applyPlan([a, b], opts(h, { tty: true, approve: approver(() => ({ kind: "declined" })).approve }));
    expect(a.ran() + b.ran()).toBe(0);
    expect(res).toEqual([
      { id: "a", label: "Step a", status: "skipped", detail: DECLINED },
      { id: "b", label: "Step b", status: "skipped", detail: DECLINED },
    ]);
    expect(h.out.text()).toBe("Aborted.\n");
  });

  it("the exact changes behind `d` are the checked steps' previews, redacted, with control characters replaced", async () => {
    const h = harness();
    const s = step("s", { sensitive: true, label: "Add the hook", preview: 'Authorization: "Bearer jba_SECRETSECRET1"\u001b[2J\tx\n{ "command": "jubarteai hook" }' });
    const a = approver();
    await applyPlan([s, step("t", { files: [join(homedir(), ".claude", "settings.json")] })], opts(h, { tty: true, approve: a.approve }));
    const seen = a.seen[0] as Seen;
    const all = new Set(seen.groups.flatMap((g) => g.rows.map((r) => r.key)));
    const text = seen.details(all).join("\n");
    expect(text).not.toContain("jba_SECRETSECRET1");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("[redacted]");
    expect(text).toContain('{ "command": "jubarteai hook" }');
    expect(text).toContain("~/.claude/settings.json");
    expect(seen.details(new Set()).join("")).toBe("");
  });

  it("--show-changes prints the exact entries before asking", async () => {
    const h = harness();
    const order: string[] = [];
    await applyPlan([step("s", { sensitive: true, preview: "ENTRY-TEXT" })], {
      ...opts(h, { tty: true, showChanges: true }),
      approve: async (groups) => {
        order.push(h.out.text().includes("ENTRY-TEXT") ? "shown-first" : "asked-first");
        return { kind: "apply", checked: new Set(groups.flatMap((g) => g.rows.map((r) => r.key))) };
      },
    });
    expect(order).toEqual(["shown-first"]);
  });

  it("confirm mode asks one Yes / No / Show question and applies everything on yes, nothing on no", async () => {
    const answer = async (typed: string) => {
      term = fakeTerminal();
      const h = harness();
      const s = step("s");
      const pending = applyPlan([s], opts(h, { tty: true, approval: "confirm", title: "Proceed?" }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(term.shown()).toBe("Proceed? [Y/n/d] ");
      term.type(typed);
      const res = await pending;
      term.restore();
      term = null;
      return { res, ran: s.ran() };
    };
    expect((await answer("\n")).ran).toBe(1);
    const no = await answer("n\n");
    expect(no.ran).toBe(0);
    expect(no.res[0]?.detail).toBe(DECLINED);
    const show = await answer("d\ny\n");
    expect(show.ran).toBe(1);
  });

  it("a cancelled checklist rejects before anything ran", async () => {
    const h = harness();
    const a = step("a");
    await expect(
      applyPlan([a], {
        ...opts(h, { tty: true }),
        approve: async () => {
          throw new CliError("Cancelled.", ExitCode.SERVER_ERROR, "cancelled");
        },
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(a.ran()).toBe(0);
  });
});

describe("applyPlan: no TTY", () => {
  it("runs non-sensitive steps without asking and skips sensitive ones with the default flag", async () => {
    const h = harness();
    const a = step("a");
    const s = step("s", { sensitive: true });
    const res = await applyPlan([a, s], opts(h));
    expect(a.ran()).toBe(1);
    expect(s.ran()).toBe(0);
    expect(res[1]).toEqual({ id: "s", label: "Step s", status: "skipped", detail: "needs confirmation", flag: "--yes" });
    expect(h.out.text()).toContain("skipped (needs confirmation; rerun with --yes)");
  });

  it("a sensitive step's own flag is the one reported", async () => {
    const res = await applyPlan([step("s", { sensitive: true, flag: "--install-hooks" })], opts(harness()));
    expect(res[0]?.flag).toBe("--install-hooks");
  });
});

describe("applyPlan: --yes", () => {
  for (const tty of [true, false]) {
    it(`runs every step with no question (tty: ${tty})`, async () => {
      const steps = [step("a"), step("s", { sensitive: true, preview: "entry" }), step("z")];
      const res = await applyPlan(steps, opts(harness(), { tty, yes: true, approve: async () => { throw new Error("must not ask"); } }));
      expect(steps.map((s) => s.ran())).toEqual([1, 1, 1]);
      expect(res.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
    });
  }
});

describe("applyPlan: inside an agent's shell (R-M1)", () => {
  const mustNotAsk: ApplyOptions["approve"] = async () => {
    throw new Error("an agent's terminal must never be asked");
  };

  it("--yes without a TTY runs the non-sensitive steps and skips the sensitive ones with no flag to retry", async () => {
    const a = step("a");
    const s = step("s", { sensitive: true });
    const res = await applyPlan([a, s], opts(harness(), { yes: true, agentSession: "CLAUDECODE" }));
    expect(a.ran()).toBe(1);
    expect(s.ran()).toBe(0);
    expect(res[1]).toEqual({ id: "s", label: "Step s", status: "skipped", detail: NEEDS_PERSON });
    expect(summarize(res)[1]).not.toContain("rerun with");
  });

  it("without --yes the sensitive step is skipped the same way (no --yes hint for the agent to follow)", async () => {
    const res = await applyPlan([step("s", { sensitive: true })], opts(harness(), { agentSession: "CODEX_THREAD_ID" }));
    expect(res[0]).toEqual({ id: "s", label: "Step s", status: "skipped", detail: NEEDS_PERSON });
  });

  it("with a terminal no checklist or question is shown and the sensitive step is skipped, whatever --yes says: an IDE agent's terminal is a real PTY", async () => {
    for (const yes of [true, false]) {
      term = fakeTerminal();
      const a = step("a");
      const s = step("s", { sensitive: true, preview: "entry" });
      // A scripted person who would press Enter, space and y on anything asked.
      term.type("\n \ny\n");
      const res = await applyPlan([a, s], opts(harness(), { tty: true, yes, agentSession: "CURSOR_AGENT", approve: mustNotAsk }));
      expect(term.shown()).toBe("");
      expect(res[1]).toEqual({ id: "s", label: "Step s", status: "skipped", detail: NEEDS_PERSON });
      expect([a.ran(), s.ran()]).toEqual([1, 0]);
      term.restore();
      term = null;
    }
  });

  it("detects the session from the environment when the caller doesn't say", async () => {
    const s = step("s", { sensitive: true });
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "abc");
    const rest: Partial<ApplyOptions> = opts(harness(), { yes: true });
    delete rest.agentSession;
    const res = await applyPlan([s], rest as ApplyOptions);
    expect(s.ran()).toBe(0);
    expect(res[0]?.detail).toBe(NEEDS_PERSON);
  });

  it("agentSession: null keeps --yes as it was", async () => {
    const s = step("s", { sensitive: true });
    vi.stubEnv("CLAUDECODE", "1");
    await applyPlan([s], opts(harness(), { yes: true, agentSession: null }));
    expect(s.ran()).toBe(1);
  });
});

describe("applyPlan: steps that fail", () => {
  const run = (s: PlanStep) => applyPlan([s], opts(harness(), { yes: true }));

  it("a throwing step is failed with a fixed detail and the rest still run", async () => {
    const boom = step("boom", {
      async apply() {
        throw new Error("secret jba_LEAKLEAKLEAK in /home/me/.cursor/mcp.json");
      },
    });
    const after = step("after");
    const res = await applyPlan([boom, after], opts(harness(), { yes: true }));
    expect(res[0]).toEqual({ id: "boom", label: "Step boom", status: "failed", detail: "unexpected error" });
    expect(after.ran()).toBe(1);
    expect(JSON.stringify(res)).not.toContain("LEAKLEAK");
  });

  it("a guard refusal names its reason, never the path", async () => {
    const res = await run(
      step("s", {
        async apply() {
          const { SafeEditError } = await import("./atomic-write.js");
          throw new SafeEditError("Refusing to write /home/me/secret-dir/mcp.json: it is a symbolic link", "symlink");
        },
      }),
    );
    expect(res[0]?.detail).toBe("could not write (symlink)");
  });

  it("a Node error names its code, never its message", async () => {
    const res = await run(
      step("s", {
        async apply() {
          throw Object.assign(new Error("EACCES: permission denied, open '/home/me/jba_KEYKEYKEY1/x'"), { code: "EACCES" });
        },
      }),
    );
    expect(res[0]?.detail).toBe("could not write (EACCES)");
  });

  it("an odd error code is not trusted as text", async () => {
    const res = await run(
      step("s", {
        async apply() {
          throw Object.assign(new Error("x"), { code: "has spaces and a /path" });
        },
      }),
    );
    expect(res[0]?.detail).toBe("unexpected error");
  });

  it("a step that returns failed keeps its own detail and flag; id and label come from the step", async () => {
    const res = await run(
      step("s", {
        async apply() {
          return { id: "other", label: "Other", status: "failed", detail: "the file has comments", flag: "--force" };
        },
      }),
    );
    expect(res[0]).toEqual({ id: "s", label: "Step s", status: "failed", detail: "the file has comments", flag: "--force" });
  });

  it("a step that returns already configured is passed through", async () => {
    const res = await applyPlan([step("s", {}, "already configured")], opts(harness()));
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

describe("no per-step prompt remains", () => {
  it("the source has no 'Apply \"…\"?' question", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./plan.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Apply "/);
  });
});
