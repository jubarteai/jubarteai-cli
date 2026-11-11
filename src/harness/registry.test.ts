import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "../session/harness-env.js";
import { ADAPTERS, adapterFor } from "./registry.js";

describe("the adapter registry", () => {
  it("has one adapter per harness id, in the order of spec §9", () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(["claude-code", "codex", "cursor", "vscode", "windsurf", "zed", "gemini-cli", "opencode", "copilot-cli"]);
    expect(ADAPTERS.map((a) => a.id)).toEqual([...HARNESS_IDS]);
  });

  it("adapterFor returns the adapter with that id", () => {
    for (const id of HARNESS_IDS) expect(adapterFor(id).id).toBe(id);
  });

  it("adapterFor throws for an id nobody implements", () => {
    expect(() => adapterFor("nope" as never)).toThrow(RangeError);
  });

  it("every adapter implements the whole interface with a label and fixed shapes", () => {
    for (const a of ADAPTERS) {
      expect(a.label.length).toBeGreaterThan(0);
      for (const fn of [a.detect, a.permission, a.hooks, a.inspect, a.mcpCleanup]) expect(typeof fn).toBe("function");
      expect(typeof a.promptInjection).toBe("boolean");
      expect(a.skillAgent === null || typeof a.skillAgent === "string").toBe(true);
      expect(a.sessionVar === null || /^[A-Z][A-Z0-9_]+$/.test(a.sessionVar)).toBe(true);
    }
  });

  it("only Cursor, VS Code and Copilot CLI lack per-prompt injection among the verified ones (spec §9 notes)", () => {
    const without = ADAPTERS.filter((a) => !a.promptInjection).map((a) => a.id);
    for (const id of ["cursor", "vscode", "copilot-cli"] as const) expect(without).toContain(id);
    for (const id of ["claude-code", "codex", "gemini-cli"] as const) expect(without).not.toContain(id);
  });

  it("the skills agent ids are the ones skills@1.7.4 knows (P2 §1)", () => {
    expect(adapterFor("claude-code").skillAgent).toBe("claude-code");
    expect(adapterFor("codex").skillAgent).toBe("codex");
    expect(adapterFor("copilot-cli").skillAgent).toBe("github-copilot");
    expect(adapterFor("vscode").skillAgent).toBe("github-copilot");
  });
});
