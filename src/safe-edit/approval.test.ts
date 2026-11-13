// What a person approves, built straight from the steps that will run: the checklist's groups and rows, and the exact
// entries behind `d`. Pure functions, so these tests build steps by hand and never touch a file.
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HARNESS_LABELS } from "../harness/labels.js";
import { HARNESS_IDS } from "../session/harness-env.js";
import type { HarnessId } from "../session/harness-env.js";
import { approvalGroups, checkedHarnesses, exactChanges, groupKey, groupTitle, groupsOf, printable, rowKey } from "./approval.js";
import { MACHINE_GROUP, harnessGroup, repoGroup } from "./plan.js";
import type { PlanStep, StepGroup } from "./plan.js";

const HOME = "/home/me";

function step(id: string, group: StepGroup, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    label: `Step ${id}`,
    group,
    files: [`${HOME}/${id}.json`],
    sensitive: false,
    apply: async () => ({ id, label: `Step ${id}`, status: "configured" }),
    ...over,
    // `over` is a Partial of a union (alsoGroups travels with narrow); callers pass them together or not at all.
  } as PlanStep;
}

/** A step one `npx skills add -a … -a …` runs for several harnesses: shown under each of them. */
function shared(id: string, first: HarnessId, others: HarnessId[]): PlanStep {
  const base = step(id, harnessGroup(first));
  return { ...base, alsoGroups: others, narrow: () => base };
}

const allKeys = (steps: PlanStep[]): Set<string> => new Set(approvalGroups(steps, HOME).flatMap((g) => g.rows.map((r) => r.key)));

describe("groupKey and groupTitle", () => {
  it("give every harness its own group, titled by the name people know it by", () => {
    expect(HARNESS_IDS.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const id of HARNESS_IDS) {
      const group = harnessGroup(id);
      expect(groupTitle(group)).toBe(HARNESS_LABELS[id]);
      expect(groupTitle(group)).not.toBe("");
      keys.add(groupKey(group));
    }
    expect(keys.size).toBe(HARNESS_IDS.length);
  });

  it("key a repo group by its folder, so a worktree and its main checkout are two groups, both titled Repo", () => {
    expect(groupKey(repoGroup("/work/wt"))).not.toBe(groupKey(repoGroup("/work/main")));
    expect(groupKey(repoGroup("/work/wt"))).toBe(groupKey(repoGroup("/work/wt")));
    expect(groupTitle(repoGroup("/work/wt"))).toBe("Repo");
    expect(groupTitle(MACHINE_GROUP)).toBe("This machine");
  });

  it("never collide across kinds", () => {
    const keys = [groupKey(MACHINE_GROUP), groupKey(repoGroup("/r")), groupKey(harnessGroup("codex"))];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("approvalGroups", () => {
  it("orders harnesses first, then repos, then this machine, whatever order the steps come in", () => {
    const steps = [
      step("logout", MACHINE_GROUP),
      step("binding", repoGroup("/work/main")),
      step("codex-hooks", harnessGroup("codex")),
      step("agents-md", repoGroup("/work/wt")),
      step("claude-hooks", harnessGroup("claude-code")),
    ];
    expect(approvalGroups(steps, HOME).map((g) => [g.title, g.note ?? null])).toEqual([
      ["Codex", null],
      ["Claude Code", null],
      ["Repo", resolve("/work/main")],
      ["Repo", resolve("/work/wt")],
      ["This machine", null],
    ]);
  });

  it("puts every step of a group under one header, every row checked, in step order", () => {
    const steps = [step("a", harnessGroup("cursor")), step("b", MACHINE_GROUP), step("c", harnessGroup("cursor"))];
    const groups = approvalGroups(steps, HOME);
    expect(groups.map((g) => g.rows.map((r) => [r.label, r.checked]))).toEqual([
      [
        ["Step a", true],
        ["Step c", true],
      ],
      [["Step b", true]],
    ]);
  });

  it("gives a step shown under several harnesses one row per harness, each with its own key", () => {
    const skill = shared("skill", "claude-code", ["codex", "cursor"]);
    const groups = approvalGroups([skill], HOME);
    expect(groups.map((g) => g.title)).toEqual(["Claude Code", "Codex", "Cursor"]);
    const keys = groups.map((g) => g.rows[0]?.key);
    expect(keys).toEqual([rowKey(skill, harnessGroup("claude-code")), rowKey(skill, harnessGroup("codex")), rowKey(skill, harnessGroup("cursor"))]);
    expect(new Set(keys).size).toBe(3);
  });

  it("leaves out steps that only report (kind info): nothing to approve, and no empty group for them", () => {
    const steps = [step("finding", harnessGroup("zed"), { kind: "info" }), step("write", MACHINE_GROUP)];
    expect(approvalGroups(steps, HOME).map((g) => g.title)).toEqual(["This machine"]);
    expect(approvalGroups([step("only", MACHINE_GROUP, { kind: "info" })], HOME)).toEqual([]);
  });

  it("shows a repo folder under the home directory with ~, and makes labels safe to print", () => {
    const groups = approvalGroups([step("x", repoGroup(`${HOME}/code/demo`), { label: `Bind jba_SECRETSECRET1\u001b[2J ${"y".repeat(300)}` })], HOME);
    expect(groups[0]?.note).toBe("~/code/demo");
    const label = groups[0]?.rows[0]?.label ?? "";
    expect(label).not.toContain("jba_SECRET");
    expect(label).toContain("[redacted]");
    expect(label).not.toContain("\u001b");
    expect(Array.from(label).length).toBe(200);
  });
});

describe("exactChanges", () => {
  it("prints each checked step once, even when it shows under several harnesses", () => {
    const skill = { ...shared("skill", "claude-code", ["codex"]), preview: "npx skills add -a claude-code -a codex" } as PlanStep;
    expect(exactChanges([skill], allKeys([skill]), HOME)).toEqual(["Step skill", "      npx skills add -a claude-code -a codex"]);
    // Only one of its two rows checked: still printed, once.
    expect(exactChanges([skill], new Set([rowKey(skill, harnessGroup("codex"))]), HOME)).toHaveLength(2);
  });

  it("leaves out unchecked steps and info steps", () => {
    const kept = step("kept", MACHINE_GROUP, { preview: "kept entry" });
    const dropped = step("dropped", MACHINE_GROUP, { preview: "dropped entry" });
    const info = step("info", MACHINE_GROUP, { kind: "info", preview: "info entry" });
    const lines = exactChanges([kept, dropped, info], new Set([rowKey(kept, MACHINE_GROUP), rowKey(info, MACHINE_GROUP)]), HOME);
    expect(lines).toEqual(["Step kept", "      kept entry"]);
    expect(exactChanges([kept], new Set(), HOME)).toEqual([]);
  });

  it("shows a step's files, home as ~, when it has no preview", () => {
    const s = step("files", MACHINE_GROUP, { files: [`${HOME}/.codex/hooks.json`, "/etc/elsewhere.json"] });
    // A path outside home is printed absolute for this platform ("D:\\etc\\elsewhere.json" on Windows).
    expect(exactChanges([s], allKeys([s]), HOME)).toEqual(["Step files", "      ~/.codex/hooks.json", `      ${resolve("/etc/elsewhere.json")}`]);
  });

  it("indents every line of a multi-line preview and makes each one safe to print", () => {
    const s = step("hook", harnessGroup("claude-code"), { preview: '{\r\n\t"Authorization": "Bearer jba_SECRETSECRET1"\u001b]52;c;x\u0007\n}' });
    expect(exactChanges([s], allKeys([s]), HOME)).toEqual(["Step hook", "      {", '        "Authorization": "Bearer [redacted]"?]52;c;x?', "      }"]);
  });
});

describe("printable", () => {
  it("normalises line ends, flattens tabs, and replaces every other control or format character", () => {
    expect(printable("a\r\nb\rc\td")).toBe("a\nb\nc  d");
    expect(printable("bidi‮flip zero​width sep x para y del\u007f c1\u009b")).toBe("bidi?flip zero?width sep?x para?y del? c1?");
    expect(printable("jbc_LOGINCODE jbw_WATCHTOKEN")).toBe("[redacted] [redacted]");
  });
});

describe("checkedHarnesses and groupsOf", () => {
  it("name the harnesses whose row is still checked, and never a repo or the machine", () => {
    const skill = shared("skill", "claude-code", ["codex", "cursor"]);
    expect(groupsOf(skill).map(groupKey)).toEqual(["harness:claude-code", "harness:codex", "harness:cursor"]);
    const checked = new Set([rowKey(skill, harnessGroup("codex")), rowKey(skill, harnessGroup("cursor"))]);
    expect([...checkedHarnesses(skill, checked)]).toEqual(["codex", "cursor"]);
    expect(checkedHarnesses(skill, new Set()).size).toBe(0);
    const repo = step("agents-md", repoGroup("/r"));
    expect(checkedHarnesses(repo, allKeys([repo])).size).toBe(0);
  });
});
