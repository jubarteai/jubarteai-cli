import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanStep } from "../safe-edit/plan.js";
import { PERSON_COMMAND_LIST } from "./agent-commands.js";
import { copilotCliAdapter } from "./copilot-cli.js";
import type { InitCtx, ManualInstructions } from "./types.js";
import { COPILOT_HOOKS_STEP_ID, guardMissingNote, vscodeAdapter } from "./vscode.js";

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-copilot-")));
  home = join(root, "home");
  mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const hooksFile = (base = join(home, ".copilot")): string => join(base, "hooks", "jubarteai.json");
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
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

async function hookStep(over: Partial<InitCtx> = {}): Promise<PlanStep> {
  const steps = await copilotCliAdapter.hooks(ctx(over));
  if (!Array.isArray(steps) || steps.length !== 1 || !isStep(steps[0])) throw new Error("expected one step");
  return steps[0];
}

describe("copilotCliAdapter facts", () => {
  it("states the spec cells", () => {
    expect(copilotCliAdapter.id).toBe("copilot-cli");
    expect(copilotCliAdapter.skillAgent).toBe("github-copilot");
    expect(copilotCliAdapter.sessionVar).toBeNull();
    expect(copilotCliAdapter.promptInjection).toBe(false);
  });

  it("has no MCP entries to clean (install.sh never wrote one)", async () => {
    expect(await copilotCliAdapter.mcpCleanup({ home, projectRoot: null, platform: "linux" })).toEqual([]);
  });
});

describe("detect", () => {
  const base = (): { home: string; env: NodeJS.ProcessEnv; platform: "linux" } => ({ home, env: {}, platform: "linux" });

  it("finds nothing on an empty home", async () => {
    expect(await copilotCliAdapter.detect({ ...base(), which: () => null })).toBe(false);
  });

  it("finds the copilot binary", async () => {
    expect(await copilotCliAdapter.detect({ ...base(), which: (c) => (c === "copilot" ? "/x/copilot" : null) })).toBe(true);
  });

  it("finds ~/.copilot, and $COPILOT_HOME when it is absolute", async () => {
    const custom = join(root, "custom");
    expect(await copilotCliAdapter.detect({ ...base(), env: { COPILOT_HOME: custom }, which: () => null })).toBe(false);
    mkdirSync(custom);
    expect(await copilotCliAdapter.detect({ ...base(), env: { COPILOT_HOME: custom }, which: () => null })).toBe(true);
    expect(await copilotCliAdapter.detect({ ...base(), env: { COPILOT_HOME: "relative" }, which: () => null })).toBe(false);
    mkdirSync(join(home, ".copilot"));
    expect(await copilotCliAdapter.detect({ ...base(), env: { COPILOT_HOME: "relative" }, which: () => null })).toBe(true);
  });
});

describe("permission", () => {
  // GitHub documents first-level subcommand matching for shell rules only for git and gh (review R-M4), so the CLI
  // prints no per-command flag it can't show works, and no deny it would call a guard.
  it("prints a caveat and no allow or deny flags, never a step", async () => {
    const out = await copilotCliAdapter.permission(ctx());
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.harness).toBe("copilot-cli");
    expect(out.reason).toContain("D25");
    expect(out.rules).toEqual([]);
    const text = out.lines.join("\n");
    expect(text).not.toMatch(/^copilot /m);
    expect(text).not.toContain("alias copilot");
    expect(text).not.toContain("--deny-tool");
    expect(text).not.toMatch(/--allow-tool='shell\(jubarteai [a-z-]+\)'/);
  });

  it("says a session or repository approval, shell(jubarteai:*), --allow-all-tools and --yolo also approve the person commands", async () => {
    const out = await copilotCliAdapter.permission(ctx());
    if (!isManual(out)) throw new Error("expected printed instructions");
    expect(out.lines[0]).toContain("for the session or for this repository");
    expect(out.lines[0]).toContain(PERSON_COMMAND_LIST);
    const broad = out.lines.find((line) => line.includes("shell(jubarteai:*)"));
    for (const rule of ["shell(jubarteai)", "--allow-all-tools", "--yolo", PERSON_COMMAND_LIST]) expect(broad, rule).toContain(rule);
    // No sentence suggests a broad approval is safe with some other flag in place.
    expect(out.lines.join("\n")).not.toMatch(/without those/);
  });

  it("names the preToolUse guard as best effort, never as a reason to approve broadly (review R-S12)", async () => {
    const out = await copilotCliAdapter.permission(ctx());
    if (!isManual(out)) throw new Error("expected printed instructions");
    const guard = out.lines.find((line) => line.includes("preToolUse"));
    expect(guard).toContain("approves nothing");
    expect(guard).toContain("best effort");
    expect(out.lines.join("\n")).toContain("approve that one command");
  });
});

describe("hooks (the shared ~/.copilot/hooks/jubarteai.json)", () => {
  it("returns the shared step under the shared id and writes session start, session end and the preToolUse guard", async () => {
    const step = await hookStep();
    expect(step.id).toBe(COPILOT_HOOKS_STEP_ID);
    expect(step.sensitive).toBe(true);
    expect(step.files).toEqual([hooksFile()]);
    expect((await step.apply()).status).toBe("configured");
    const doc = read(hooksFile());
    const hooks = doc["hooks"] as Record<string, Array<{ command: string }>>;
    expect(Object.keys(hooks).sort()).toEqual(["preToolUse", "sessionEnd", "sessionStart"]);
    expect((hooks["preToolUse"]?.[0] as unknown as { bash: string }).bash).toContain("hook pre-tool-use --harness vscode || true");
    expect(hooks["sessionStart"]?.[0]?.command).toContain("hook session-start --harness");
    expect(hooks["sessionEnd"]?.[0]?.command).toContain("hook session-end --harness");
    const before = readFileSync(hooksFile(), "utf8");
    expect((await step.apply()).status).toBe("already configured");
    expect(readFileSync(hooksFile(), "utf8")).toBe(before);
  });

  it("is the same step id and file as VS Code's, so a caller writes it once", async () => {
    const mine = await hookStep();
    const theirs = await vscodeAdapter.hooks(ctx());
    expect(Array.isArray(theirs) && isStep(theirs[0]) ? theirs[0].id : null).toBe(mine.id);
    expect(Array.isArray(theirs) && isStep(theirs[0]) ? theirs[0].files : null).toEqual(mine.files);
  });

  it("follows $COPILOT_HOME", async () => {
    const custom = join(root, "custom");
    const step = await hookStep({ env: { COPILOT_HOME: custom } });
    expect(step.files).toEqual([hooksFile(custom)]);
  });

  it("names the resolved hook file in the printed guard line and doctor's note, $COPILOT_HOME included (review R-N18)", async () => {
    const custom = join(root, "custom");
    const out = await copilotCliAdapter.permission(ctx({ env: { COPILOT_HOME: custom } }));
    if (!isManual(out)) throw new Error("expected printed instructions");
    expect(out.lines.join("\n")).toContain(`preToolUse guard in ${hooksFile(custom)}`);
    expect(out.lines.join("\n")).not.toContain("~/.copilot");
    put(hooksFile(custom), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", command: "jubarteai hook session-start --harness vscode", timeoutSec: 8 }] } }));
    expect((await copilotCliAdapter.inspect(ctx({ env: { COPILOT_HOME: custom } }))).notes).toContain(guardMissingNote(hooksFile(custom)));
  });

  it("prints the entries for a hooks file with comments and never rewrites it", async () => {
    const text = '{\n  // mine\n  "version": 1\n}\n';
    put(hooksFile(), text);
    const out = await copilotCliAdapter.hooks(ctx());
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.harness).toBe("copilot-cli");
    expect(out.lines.join("\n")).toContain("sessionStart");
    expect(readFileSync(hooksFile(), "utf8")).toBe(text);
  });
});

describe("inspect", () => {
  it("is read-only and tracks the shared hook file", async () => {
    expect(await copilotCliAdapter.inspect(ctx())).toMatchObject({ permission: "manual", hooks: "missing", mcpEntries: [] });
    expect(() => readFileSync(hooksFile())).toThrow();
    await (await hookStep()).apply();
    expect((await copilotCliAdapter.inspect(ctx())).hooks).toBe("configured");
  });

  it("reports a partial install and an unparseable file", async () => {
    put(hooksFile(), JSON.stringify({ version: 1, hooks: { sessionEnd: [{ type: "command", command: "jubarteai hook session-end --harness vscode", timeoutSec: 3 }] } }));
    expect((await copilotCliAdapter.inspect(ctx())).hooks).toBe("partial");
    put(hooksFile(), "{ // c\n}");
    expect((await copilotCliAdapter.inspect(ctx())).hooks).toBe("manual");
  });

  it("notes a hook file that has the session hooks but not the guard", async () => {
    put(hooksFile(), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", command: "jubarteai hook session-start --harness vscode", timeoutSec: 8 }] } }));
    expect((await copilotCliAdapter.inspect(ctx())).notes).toContain(guardMissingNote(hooksFile()));
    await (await hookStep()).apply();
    expect((await copilotCliAdapter.inspect(ctx())).notes).not.toContain(guardMissingNote(hooksFile()));
  });

  it("notes that there is no per-prompt injection", async () => {
    expect((await copilotCliAdapter.inspect(ctx())).notes.join(" ")).toContain("per-prompt");
  });
});

describe("invariant I6", () => {
  it("imports no node:fs write API", () => {
    const source = readFileSync(join(import.meta.dirname, "copilot-cli.ts"), "utf8");
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) expect(["existsSync", "readFileSync", "statSync"]).toContain(name);
    expect(source).not.toMatch(/from\s*"node:fs\/promises"|import\s*\*\s*as\s*\w+\s*from\s*"node:fs"/);
  });
});
