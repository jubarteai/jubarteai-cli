import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { applyPlan, summarize } from "../safe-edit/plan.js";
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
  usingAccount,
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
      files: [],
      sensitive: false,
      apply: async () => ({ id, label: `Step ${id}`, status }),
    });
    const out = new PassThrough();
    let text = "";
    out.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const results = await applyPlan([step("a", "configured"), step("b", "already configured"), step("c", "failed"), { ...step("d", "configured"), sensitive: true }], {
      tty: false,
      yes: false,
      out,
    });
    const lines = summarize(results).join("\n");
    expect(lines).toContain(`Step a: ${INIT_COPY.statusConfigured}`);
    expect(lines).toContain(`Step b: ${INIT_COPY.statusAlreadyConfigured}`);
    expect(lines).toContain(`Step c: ${INIT_COPY.statusFailed}`);
    expect(lines).toContain(`Step d: ${INIT_COPY.statusSkipped}`);
    expect(text).toContain("This will make these changes:");
    // the Proceed prompt, with its hint, as the confirm helper writes it
    const prompts: string[] = [];
    await applyPlan([step("e", "configured")], {
      tty: true,
      yes: false,
      out,
      confirmFn: async (question, opts) => {
        prompts.push(`${question} ${opts.defaultYes ? "[Y/n]" : "[y/N]"}`);
        return true;
      },
    });
    expect(prompts).toEqual([INIT_COPY.proceedPrompt]);
  });

  it("builds the share question from the same words as its prompt", () => {
    expect(INIT_COPY.shareBindingPrompt).toBe(`${INIT_COPY.shareBindingQuestion} [y/N]`);
  });
});

describe("interpolated lines", () => {
  it("fill in the values and nothing else", () => {
    expect(useAccountQuestion("ada@example.com", "Acme")).toBe("Use ada@example.com — Acme?");
    expect(accountChoiceLabel("ada@example.com", "Acme")).toBe("ada@example.com — Acme");
    expect(bindingStepLabel("acme")).toBe("Bind this repo to workspace acme");
    expect(flagSkipDetail("--keep-mcp")).toBe("turned off by --keep-mcp");
    expect(usingAccount("ada@example.com", "Acme")).toBe("Using ada@example.com — Acme");
    expect(noLoginForWorkspace("acme")).toBe("No saved login for workspace acme. Run: jubarteai login --workspace acme");
    expect(repoUsesWorkspace("acme")).toBe("This repo uses workspace acme. Signing in to it.");
    expect(linkReport("acme", "ada@example.com", "private")).toBe("This repo is bound to workspace acme as ada@example.com (private binding).");
    expect(linkConverted("shared")).toBe("Switched the binding to the shared form.");
    expect(linkPrevious("old", "shared")).toBe("Before: workspace old (shared binding).");
  });
});
