import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanStep } from "../safe-edit/plan.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import type { InitCtx, ManualInstructions } from "./types.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-gemini-")));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const settings = (): string => join(home, ".gemini", "settings.json");
const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(settings(), "utf8")) as Record<string, unknown>;

function put(text: string): void {
  mkdirSync(dirname(settings()), { recursive: true });
  writeFileSync(settings(), text, { mode: 0o600 });
}

function ctx(over: Partial<InitCtx> = {}): InitCtx {
  return { home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai", ...over };
}

function isStep(value: unknown): value is PlanStep {
  return typeof value === "object" && value !== null && "apply" in value;
}

function isManual(value: unknown): value is ManualInstructions {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "manual";
}

async function permissionStep(over: Partial<InitCtx> = {}): Promise<PlanStep> {
  const step = await geminiCliAdapter.permission(ctx(over));
  if (!isStep(step)) throw new Error("expected a step");
  return step;
}

async function hookStep(over: Partial<InitCtx> = {}): Promise<PlanStep> {
  const steps = await geminiCliAdapter.hooks(ctx(over));
  if (!Array.isArray(steps) || steps.length !== 1 || !isStep(steps[0])) throw new Error("expected one step");
  return steps[0];
}

describe("geminiCliAdapter facts", () => {
  it("states the verified spec cells", () => {
    expect(geminiCliAdapter.id).toBe("gemini-cli");
    expect(geminiCliAdapter.skillAgent).toBe("gemini-cli");
    expect(geminiCliAdapter.sessionVar).toBeNull();
    expect(geminiCliAdapter.promptInjection).toBe(true);
  });

  it("has no MCP entries to clean (install.sh never wrote one)", async () => {
    expect(await geminiCliAdapter.mcpCleanup({ home, projectRoot: null, platform: "linux" })).toEqual([]);
  });
});

describe("detect", () => {
  const base = { home: "/nonexistent-home", env: {} as NodeJS.ProcessEnv, platform: "linux" as const };

  it("finds the gemini binary", async () => {
    expect(await geminiCliAdapter.detect({ ...base, which: (c) => (c === "gemini" ? "/bin/gemini" : null) })).toBe(true);
  });

  it("finds ~/.gemini", async () => {
    mkdirSync(join(home, ".gemini"));
    expect(await geminiCliAdapter.detect({ ...base, home, which: () => null })).toBe(true);
  });

  it("finds neither", async () => {
    expect(await geminiCliAdapter.detect({ ...base, home, which: () => null })).toBe(false);
  });
});

describe("permission", () => {
  it("creates settings.json with the allow entry, and a second apply changes nothing", async () => {
    const step = await permissionStep();
    expect(step.sensitive).toBe(true);
    expect(step.files).toEqual([settings()]);
    expect((await step.apply()).status).toBe("configured");
    expect(readSettings()).toEqual({ tools: { allowed: ["run_shell_command(jubarteai)"] } });
    expect(statSync(settings()).mode & 0o777).toBe(0o600);
    const before = readFileSync(settings(), "utf8");
    expect((await step.apply()).status).toBe("already configured");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("merges into the existing list and keeps every other key", async () => {
    put(JSON.stringify({ theme: "dark", tools: { allowed: ["run_shell_command(git)"], exclude: ["x"] }, mcpServers: { a: { command: "x" } } }, null, 4));
    expect((await (await permissionStep()).apply()).status).toBe("configured");
    expect(readSettings()).toEqual({
      theme: "dark",
      tools: { allowed: ["run_shell_command(git)", "run_shell_command(jubarteai)"], exclude: ["x"] },
      mcpServers: { a: { command: "x" } },
    });
  });

  it("adds `allowed` to an existing tools object", async () => {
    put(JSON.stringify({ tools: { sandbox: true } }));
    expect((await (await permissionStep()).apply()).status).toBe("configured");
    expect(readSettings()).toEqual({ tools: { sandbox: true, allowed: ["run_shell_command(jubarteai)"] } });
  });

  it("skips, leaving the file alone, when tools.allowed is not a list", async () => {
    const text = JSON.stringify({ tools: { allowed: "run_shell_command(git)" } });
    put(text);
    const result = await (await permissionStep()).apply();
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("tools.allowed");
    expect(readFileSync(settings(), "utf8")).toBe(text);
  });

  it("prints instructions for a settings file with comments and never rewrites it", async () => {
    const text = '{\n  // my settings\n  "theme": "dark"\n}\n';
    put(text);
    const out = await geminiCliAdapter.permission(ctx());
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.harness).toBe("gemini-cli");
    expect(out.lines.join("\n")).toContain("run_shell_command(jubarteai)");
    expect(out.lines.join("\n")).toContain(settings());
    expect(readFileSync(settings(), "utf8")).toBe(text);
  });
});

describe("hooks", () => {
  const COMMANDS = {
    SessionStart: "jubarteai hook session-start --harness gemini-cli",
    BeforeAgent: "jubarteai hook user-prompt-submit --harness gemini-cli",
    SessionEnd: "jubarteai hook session-end --harness gemini-cli",
  } as const;

  type Group = { matcher: string; hooks: Array<{ name: string; type: string; command: string; timeout: number }> };

  it("writes the three events with millisecond timeouts, idempotently", async () => {
    const step = await hookStep();
    expect(step.sensitive).toBe(true);
    expect((await step.apply()).status).toBe("configured");
    const hooks = readSettings()["hooks"] as Record<string, Group[]>;
    expect(Object.keys(hooks).sort()).toEqual(["BeforeAgent", "SessionEnd", "SessionStart"]);
    for (const [event, command] of Object.entries(COMMANDS)) {
      const groups = hooks[event] ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0]?.matcher).toBe("");
      expect(groups[0]?.hooks[0]).toMatchObject({ name: "jubarteai", type: "command", command });
    }
    expect(hooks["SessionStart"]?.[0]?.hooks[0]?.timeout).toBe(8000);
    expect(hooks["BeforeAgent"]?.[0]?.hooks[0]?.timeout).toBe(8000);
    expect(hooks["SessionEnd"]?.[0]?.hooks[0]?.timeout).toBe(1000);
    const before = readFileSync(settings(), "utf8");
    expect((await step.apply()).status).toBe("already configured");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("keeps the user's own hooks and other keys, and fills in only the missing event", async () => {
    put(
      JSON.stringify({
        model: "x",
        hooks: {
          SessionStart: [{ matcher: "startup", hooks: [{ name: "mine", type: "command", command: "echo hi", timeout: 100 }] }],
          BeforeTool: [{ matcher: "", hooks: [{ type: "command", command: "audit" }] }],
        },
      }),
    );
    await (await hookStep()).apply();
    const doc = readSettings();
    const hooks = doc["hooks"] as Record<string, Group[]>;
    expect(doc["model"]).toBe("x");
    expect(hooks["BeforeTool"]).toHaveLength(1);
    expect(hooks["SessionStart"]).toHaveLength(2);
    expect(hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe("echo hi");
    expect(hooks["SessionStart"]?.[1]?.hooks[0]?.command).toBe(COMMANDS.SessionStart);
  });

  it("completes a partial install without duplicating what is there", async () => {
    put(JSON.stringify({ hooks: { SessionEnd: [{ matcher: "", hooks: [{ name: "jubarteai", type: "command", command: COMMANDS.SessionEnd, timeout: 1000 }] }] } }));
    expect((await geminiCliAdapter.inspect(ctx())).hooks).toBe("partial");
    await (await hookStep()).apply();
    const hooks = readSettings()["hooks"] as Record<string, Group[]>;
    expect(hooks["SessionEnd"]).toHaveLength(1);
    expect(hooks["SessionStart"]).toHaveLength(1);
    expect((await geminiCliAdapter.inspect(ctx())).hooks).toBe("configured");
  });

  it("honours a custom command name", async () => {
    await (await hookStep({ cliCommand: "ja" })).apply();
    const hooks = readSettings()["hooks"] as Record<string, Group[]>;
    expect(hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe("ja hook session-start --harness gemini-cli");
  });

  it("runs ctx.hookCommand while the allow entry keeps the bare name, and a re-run with another program path updates in place", async () => {
    const program = (node: string): string => `"${node}" "/opt/jubarteai/bin/jubarteai.js"`;
    await (await hookStep({ hookCommand: program("/old/node") })).apply();
    const permission = await geminiCliAdapter.permission(ctx({ hookCommand: program("/old/node") }));
    if (permission === null || !("apply" in permission)) throw new Error("expected a step");
    await permission.apply();
    expect((readSettings()["tools"] as Record<string, unknown>)["allowed"]).toEqual(["run_shell_command(jubarteai)"]);
    expect((await geminiCliAdapter.inspect(ctx({ hookCommand: program("/new/node") }))).hooks).toBe("partial");
    const step = await hookStep({ hookCommand: program("/new/node") });
    expect(step.sensitive).toBe(true);
    expect((await step.apply()).status).toBe("configured");
    const hooks = readSettings()["hooks"] as Record<string, Group[]>;
    for (const [event, command] of Object.entries(COMMANDS)) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]?.[0]?.hooks).toHaveLength(1);
      expect(hooks[event]?.[0]?.hooks[0]?.command).toBe(command.replace(/^jubarteai/, program("/new/node")));
    }
    expect((await geminiCliAdapter.inspect(ctx({ hookCommand: program("/new/node") }))).hooks).toBe("configured");
  });

  it("skips when hooks has an unexpected shape, leaving the file untouched", async () => {
    const text = JSON.stringify({ hooks: { SessionStart: "nope" } });
    put(text);
    const result = await (await hookStep()).apply();
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("hooks.SessionStart");
    expect(readFileSync(settings(), "utf8")).toBe(text);
  });

  it("prints the entries on Windows, where the hook shell is unverified", async () => {
    const out = await geminiCliAdapter.hooks(ctx({ platform: "win32" }));
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.reason).toContain("Windows");
    expect(out.lines.join("\n")).toContain("jubarteai hook session-start --harness gemini-cli");
  });

  it("prints instructions for a settings file with comments", async () => {
    put('{\n  /* c */\n}\n');
    expect(isManual(await geminiCliAdapter.hooks(ctx()))).toBe(true);
  });
});

describe("already configured", () => {
  it("returns non-sensitive steps once the entries are in place, so a re-run never prompts or skips", async () => {
    const first = await permissionStep();
    expect(first.sensitive).toBe(true);
    await first.apply();
    const hooksFirst = await hookStep();
    expect(hooksFirst.sensitive).toBe(true);
    await hooksFirst.apply();
    const permission = await permissionStep();
    const hooks = await hookStep();
    expect(permission.sensitive).toBe(false);
    expect(hooks.sensitive).toBe(false);
    expect((await permission.apply()).status).toBe("already configured");
    expect((await hooks.apply()).status).toBe("already configured");
  });

  it("stays sensitive while a hook is missing", async () => {
    put(JSON.stringify({ hooks: { SessionEnd: [{ matcher: "", hooks: [{ name: "jubarteai", type: "command", command: "jubarteai hook session-end --harness gemini-cli", timeout: 1000 }] }] } }));
    expect((await hookStep()).sensitive).toBe(true);
  });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable settings file", () => {
  it("is printed instructions everywhere, never a throw", async () => {
    put("{}");
    chmodSync(settings(), 0o000);
    try {
      for (const out of [await geminiCliAdapter.permission(ctx()), await geminiCliAdapter.hooks(ctx())]) {
        expect(isManual(out)).toBe(true);
        if (isManual(out)) expect(out.lines.join("\n")).toContain(`Couldn't read ${settings()}: fix its permissions`);
      }
      const state = await geminiCliAdapter.inspect(ctx());
      expect(state.permission).toBe("manual");
      expect(state.hooks).toBe("manual");
      expect(state.notes.join(" ")).toContain("fix its permissions");
    } finally {
      chmodSync(settings(), 0o600);
    }
  });
});

describe("inspect", () => {
  it("reports missing on an empty home, configured after both steps, and writes nothing itself", async () => {
    expect(await geminiCliAdapter.inspect(ctx())).toEqual({ permission: "missing", hooks: "missing", mcpEntries: [], notes: [] });
    expect(() => statSync(settings())).toThrow();
    await (await permissionStep()).apply();
    await (await hookStep()).apply();
    expect(await geminiCliAdapter.inspect(ctx())).toEqual({ permission: "configured", hooks: "configured", mcpEntries: [], notes: [] });
  });

  it("reports manual for a settings file it cannot parse", async () => {
    put("{ // x\n}");
    const state = await geminiCliAdapter.inspect(ctx());
    expect(state.permission).toBe("manual");
    expect(state.hooks).toBe("manual");
  });

  it("notes when the user turned hooks off", async () => {
    put(JSON.stringify({ hooksConfig: { enabled: false } }));
    expect((await geminiCliAdapter.inspect(ctx())).notes).toHaveLength(1);
  });
});

describe("invariant I6", () => {
  it("imports no node:fs write API", () => {
    const source = readFileSync(join(import.meta.dirname, "gemini-cli.ts"), "utf8");
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) expect(["existsSync", "readFileSync", "statSync"]).toContain(name);
    expect(source).not.toMatch(/from\s*"node:fs\/promises"|import\s*\*\s*as\s*\w+\s*from\s*"node:fs"/);
  });
});
