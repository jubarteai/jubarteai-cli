import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fakeStream, fakeTerminal } from "../../test/helpers/ui-streams.js";
import { DECLINED, MACHINE_GROUP, NOT_SELECTED, applyPlan, summarize } from "../safe-edit/plan.js";
import { stripAnsi } from "../ui/display.js";
import { createUi } from "../ui/index.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import {
  INIT_COPY,
  accountChoiceLabel,
  bindingStepLabel,
  flagSkipDetail,
  linkConverted,
  linkPrevious,
  linkReport,
  noLoginForWorkspace,
  repoUsesWorkspace,
  useAccountQuestion,
} from "./init-copy.js";

const source = readFileSync(new URL("./init-copy.ts", import.meta.url), "utf8");

describe("INIT_COPY", () => {
  it("pins the restart line the email quotes", () => {
    expect(INIT_COPY.restart).toBe("Restart your editor or agent so it picks up the changes.");
  });

  it("holds plain, fixed lines: no interpolation, no placeholders, no secrets", () => {
    const entries = Object.entries(INIT_COPY);
    expect(entries.length).toBeGreaterThan(10);
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe("string");
      expect(value, key).not.toMatch(/\$\{|undefined|\[object|jb[acw]_[A-Za-z0-9]/);
      expect(value.trim(), key).toBe(value);
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it("appears verbatim in the source file (the app's email test reads that file)", () => {
    for (const [key, value] of Object.entries(INIT_COPY)) {
      expect(source.includes(JSON.stringify(value)), key).toBe(true);
    }
  });

  it("matches what the plan runner really prints (a change there must reach the email through here)", async () => {
    const step = (id: string, status: StepResult["status"]): PlanStep => ({
      id,
      label: `Step ${id}`,
      group: MACHINE_GROUP,
      files: [],
      sensitive: false,
      apply: async () => ({ id, label: `Step ${id}`, status }),
    });
    const out = fakeStream();
    const ui = createUi(out, { plain: true, platform: "linux", env: { LANG: "en_US.UTF-8" } });
    const results = await applyPlan([step("a", "configured"), step("b", "already configured"), step("c", "failed"), { ...step("d", "configured"), sensitive: true }], {
      tty: false,
      yes: false,
      ui,
      timeline: ui.timeline(),
      approval: "checklist",
      title: INIT_COPY.checklistTitle,
      agentSession: null,
    });
    const lines = summarize(results).join("\n");
    expect(lines).toContain(`Step a: ${INIT_COPY.statusConfigured}`);
    expect(lines).toContain(`Step b: ${INIT_COPY.statusAlreadyConfigured}`);
    expect(lines).toContain(`Step c: ${INIT_COPY.statusFailed}`);
    expect(lines).toContain(`Step d: ${INIT_COPY.statusSkipped}`);
    // The timeline rows the person reads carry the same statuses.
    expect(out.text()).toContain(`: ${INIT_COPY.statusConfigured}`);
    expect(out.text()).toContain(`: ${INIT_COPY.statusAlreadyConfigured}`);
    expect(out.text()).toContain(`: ${INIT_COPY.statusFailed}`);
    expect(out.text()).toContain(`: ${INIT_COPY.statusSkipped}`);
  });

  it("the checklist a real run shows carries the title the email quotes, on a terminal and as a line prompt", async () => {
    for (const plain of [true, false]) {
      const term = fakeTerminal();
      try {
        const stream = fakeStream({ tty: true, columns: 100, depth: 24 });
        const ui = createUi(stream, { ...(plain ? { plain: true } : {}), platform: "linux", env: { LANG: "en_US.UTF-8" } });
        const pending = applyPlan(
          [{ id: "a", label: "Step a", group: MACHINE_GROUP, files: [], sensitive: false, apply: async () => ({ id: "a", label: "Step a", status: "configured" }) } satisfies PlanStep],
          { tty: true, yes: false, ui, timeline: ui.timeline(), approval: "checklist", title: INIT_COPY.checklistTitle, agentSession: null },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stripAnsi(term.shown())).toContain(INIT_COPY.checklistTitle);
        term.type("\r");
        await pending;
      } finally {
        term.restore();
      }
    }
  });

  it("the per-step answers are the words the plan runner uses", () => {
    expect(INIT_COPY.notSelected).toBe(NOT_SELECTED);
    expect(INIT_COPY.declined).toBe(DECLINED);
  });
});

describe("interpolated lines", () => {
  it("fill in the values and nothing else", () => {
    expect(useAccountQuestion("ada@example.com", "Acme")).toBe("Use ada@example.com — Acme?");
    expect(accountChoiceLabel("ada@example.com", "Acme")).toBe("ada@example.com — Acme");
    expect(bindingStepLabel("acme")).toBe("Bind this repo to workspace acme");
    expect(flagSkipDetail("--keep-mcp")).toBe("turned off by --keep-mcp");
    expect(noLoginForWorkspace("acme")).toBe("No saved login for workspace acme. Run: jubarteai login --workspace acme");
    expect(repoUsesWorkspace("acme")).toBe("This repo uses workspace acme. Signing in to it.");
    expect(linkReport("acme", "ada@example.com", "private")).toBe("This repo is bound to workspace acme as ada@example.com (private binding).");
    expect(linkConverted("shared")).toBe("Switched the binding to the shared form.");
    expect(linkPrevious("old", "shared")).toBe("Before: workspace old (shared binding).");
  });
});
