import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanStep } from "../safe-edit/plan.js";
import { AGENT_RULE_WORDS } from "./agent-commands.js";
import { opencodeAdapter } from "./opencode.js";
import type { InitCtx, ManualInstructions } from "./types.js";

const POSIX = process.platform !== "win32";

let home: string;
let bin: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let hasStub = false;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-opencode-")));
  home = join(root, "home");
  bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  hasStub = false;
  savedHome = process.env.HOME;
  savedPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  rmSync(dirname(home), { recursive: true, force: true });
});

/** A fake `opencode` that prints `output` for --version and exits with `code`. */
function stubOpencode(output: string, code = 0): void {
  const file = join(bin, "opencode");
  writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${code});\n`);
  chmodSync(file, 0o755);
  hasStub = true;
}

const dir = (): string => join(home, ".config", "opencode");
const jsonc = (): string => join(dir(), "opencode.jsonc");
const json = (): string => join(dir(), "opencode.json");
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
}

function ctx(over: Partial<InitCtx> = {}): InitCtx {
  return { home, env: {}, platform: "linux", which: (c) => (c === "opencode" && hasStub ? join(bin, "opencode") : null), projectRoot: null, cliCommand: "jubarteai", ...over };
}

function isStep(value: unknown): value is PlanStep {
  return typeof value === "object" && value !== null && "apply" in value;
}

function isManual(value: unknown): value is ManualInstructions {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "manual";
}

async function step(): Promise<PlanStep> {
  const out = await opencodeAdapter.permission(ctx());
  if (!isStep(out)) throw new Error(`expected a step, got ${JSON.stringify(out)}`);
  return out;
}

async function manual(): Promise<ManualInstructions> {
  const out = await opencodeAdapter.permission(ctx());
  if (!isManual(out)) throw new Error("expected manual instructions");
  return out;
}

const PATTERNS = AGENT_RULE_WORDS.map((word) => `jubarteai ${word}*`);
const V2_RULES = PATTERNS.map((resource) => ({ action: "shell", resource, effect: "allow" }));
const V1_BASH = Object.fromEntries(PATTERNS.map((pattern) => [pattern, "allow"]));
const LEGACY_V2 = { action: "shell", resource: "jubarteai *", effect: "allow" };

const globToRegex = (glob: string): RegExp => new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** OpenCode's matcher as documented: `*` matches any characters, none included; the last matching rule wins. */
function approves(doc: Record<string, unknown>, line: string): boolean {
  let verdict = false;
  const rules: Array<[string, string]> = [];
  if (Array.isArray(doc["permissions"])) {
    for (const r of doc["permissions"] as Array<Record<string, string>>) if (r["action"] === "shell") rules.push([r["resource"] ?? "", r["effect"] ?? ""]);
  }
  const bash = (doc["permission"] as { bash?: Record<string, string> } | undefined)?.bash;
  if (bash !== undefined) rules.push(...Object.entries(bash));
  for (const [glob, effect] of rules) if (globToRegex(glob).test(line)) verdict = effect === "allow";
  return verdict;
}

const AGENT_LINES = ["jubarteai search-knowledge --query x", "jubarteai connect", "jubarteai inbox --wait 30", "jubarteai status", "jubarteai echo-current-task --title t"];
const PERSON_LINES = [
  "jubarteai login --with-token",
  "jubarteai link --workspace x",
  "jubarteai init --yes",
  "jubarteai update",
  "jubarteai logout",
  "jubarteai --yes init",
  "jubarteai",
];

function expectAgentOnly(doc: Record<string, unknown>): void {
  for (const line of AGENT_LINES) expect(approves(doc, line), line).toBe(true);
  for (const line of PERSON_LINES) expect(approves(doc, line), line).toBe(false);
}

describe.skipIf(!POSIX)("version parsing", () => {
  it.each([
    ["2.1.3", "permissions"],
    ["v1.19.5\n", "permission"],
    ["opencode 2.0.0", "permissions"],
    ["opencode version 1.2.3-beta.1", "permission"],
  ] as const)("reads the major out of %j", async (output, key) => {
    stubOpencode(output);
    const s = await step();
    await s.apply();
    expect(Object.keys(read(s.files[0] ?? ""))).toEqual([key]);
  });
});

describe("opencodeAdapter facts", () => {
  it("states the spec cells", async () => {
    expect(opencodeAdapter.id).toBe("opencode");
    expect(opencodeAdapter.skillAgent).toBe("opencode");
    expect(opencodeAdapter.sessionVar).toBeNull();
    expect(opencodeAdapter.promptInjection).toBe(false);
    expect(await opencodeAdapter.mcpCleanup({ home, projectRoot: null, platform: "linux" })).toEqual([]);
  });

  it("detects the binary, ~/.config/opencode and $XDG_CONFIG_HOME/opencode", async () => {
    const base = { home, env: {}, platform: "linux" as const };
    expect(await opencodeAdapter.detect({ ...base, which: () => null })).toBe(false);
    expect(await opencodeAdapter.detect({ ...base, which: (c) => (c === "opencode" ? "/x/opencode" : null) })).toBe(true);
    mkdirSync(dir(), { recursive: true });
    expect(await opencodeAdapter.detect({ ...base, which: () => null })).toBe(true);
    const xdg = join(dirname(home), "xdg");
    expect(await opencodeAdapter.detect({ ...base, env: { XDG_CONFIG_HOME: xdg }, which: () => null })).toBe(false);
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    expect(await opencodeAdapter.detect({ ...base, env: { XDG_CONFIG_HOME: xdg }, which: () => null })).toBe(true);
  });
});

describe.skipIf(!POSIX)("permission, OpenCode 2.x", () => {
  it("writes one V2 allow rule per agent command to opencode.jsonc, then is a no-op", async () => {
    stubOpencode("2.1.3\n");
    const s = await step();
    expect(s.sensitive).toBe(true);
    expect(s.files).toEqual([jsonc()]);
    expect((await s.apply()).status).toBe("configured");
    expect(read(jsonc())).toEqual({ permissions: V2_RULES });
    expectAgentOnly(read(jsonc()));
    const before = readFileSync(jsonc(), "utf8");
    expect((await s.apply()).status).toBe("already configured");
    expect(readFileSync(jsonc(), "utf8")).toBe(before);
  });

  it("appends after the user's rules and keeps every other key", async () => {
    stubOpencode("v2.0.0");
    put(jsonc(), JSON.stringify({ model: "m", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }] }, null, 2));
    expect((await (await step()).apply()).status).toBe("configured");
    expect(read(jsonc())).toEqual({ model: "m", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }, ...V2_RULES] });
  });

  it("uses an existing opencode.json when there is no opencode.jsonc", async () => {
    stubOpencode("2.1.3");
    put(json(), "{}");
    expect((await step()).files).toEqual([json()]);
  });

  it("never overrides a user rule for the same pattern that does not allow it, and still adds the others", async () => {
    stubOpencode("2.1.3");
    const deny = { action: "shell", resource: "jubarteai connect*", effect: "deny" };
    put(jsonc(), JSON.stringify({ permissions: [deny] }));
    const result = await (await step()).apply();
    expect(result.status).toBe("configured");
    expect(result.detail).toContain("jubarteai connect*");
    const rules = read(jsonc())["permissions"] as Array<Record<string, string>>;
    expect(rules.filter((r) => r["resource"] === "jubarteai connect*")).toEqual([deny]);
    expect(rules).toHaveLength(V2_RULES.length);
    // Nothing left to add: the step is skipped, file untouched.
    const text = readFileSync(jsonc(), "utf8");
    const again = await (await step()).apply();
    expect(again.status).toBe("skipped");
    expect(readFileSync(jsonc(), "utf8")).toBe(text);
  });

  it.skipIf(process.platform === "win32")("reports a refused write as failed even when a conflicting rule was also found (review R-N7)", async () => {
    stubOpencode("2.1.3");
    const deny = { action: "shell", resource: "jubarteai connect*", effect: "deny" };
    put(jsonc(), JSON.stringify({ permissions: [deny] }));
    // A hard-linked config is never rewritten (it would split the link), so the write is refused.
    linkSync(jsonc(), join(dirname(jsonc()), "other-link.jsonc"));
    const text = readFileSync(jsonc(), "utf8");
    const result = await (await step()).apply();
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("could not write");
    expect(readFileSync(jsonc(), "utf8")).toBe(text);
  });

  it("removes the legacy `jubarteai *` allow rule, keeps the user's rules, and is idempotent", async () => {
    stubOpencode("2.1.3");
    const mine = { action: "shell", resource: "git *", effect: "allow" };
    put(jsonc(), JSON.stringify({ permissions: [mine, LEGACY_V2] }));
    expect((await opencodeAdapter.inspect(ctx())).notes.join(" ")).toContain("login, logout, link, init, update and uninstall");
    const s = await step();
    expect(s.sensitive).toBe(true);
    expect(s.preview).toContain('removes the "jubarteai *" allow rule');
    expect((await s.apply()).status).toBe("configured");
    expect(read(jsonc())).toEqual({ permissions: [mine, ...V2_RULES] });
    expectAgentOnly(read(jsonc()));
    const again = await step();
    expect(again.sensitive).toBe(false);
    expect(again.preview).not.toContain("removes");
    expect((await again.apply()).status).toBe("already configured");
    expect((await opencodeAdapter.inspect(ctx())).notes).toEqual([]);
  });

  it("leaves a legacy-pattern rule that denies alone", async () => {
    stubOpencode("2.1.3");
    const deny = { ...LEGACY_V2, effect: "deny" };
    put(jsonc(), JSON.stringify({ permissions: [deny] }));
    await (await step()).apply();
    expect((read(jsonc())["permissions"] as unknown[])[0]).toEqual(deny);
  });

  it("skips when permissions is not a list", async () => {
    stubOpencode("2.1.3");
    const text = JSON.stringify({ permissions: { shell: "allow" } });
    put(jsonc(), text);
    expect((await (await step()).apply()).status).toBe("skipped");
    expect(readFileSync(jsonc(), "utf8")).toBe(text);
  });

  it("prints the exact rule, and writes nothing, when the config has comments", async () => {
    stubOpencode("2.1.3");
    const text = '{\n  // mine\n  "model": "m"\n}\n';
    put(jsonc(), text);
    const out = await manual();
    for (const pattern of PATTERNS) expect(out.lines.join("\n")).toContain(`"resource": "${pattern}"`);
    // The last line is the hint to remove the legacy rule; the rules themselves never include it.
    expect(out.lines.slice(0, -1).join("\n")).not.toContain('"resource": "jubarteai *"');
    expect(out.lines.at(-1)).toContain("remove the rule");
    expect(out.lines.join("\n")).toContain(jsonc());
    expect(readFileSync(jsonc(), "utf8")).toBe(text);
  });
});

describe.skipIf(!POSIX)("permission, OpenCode 1.x", () => {
  it("writes permission.bash to opencode.json, then is a no-op", async () => {
    stubOpencode("1.19.5\n");
    const s = await step();
    expect(s.files).toEqual([json()]);
    expect((await s.apply()).status).toBe("configured");
    expect(read(json())).toEqual({ permission: { bash: V1_BASH } });
    expectAgentOnly(read(json()));
    expect((await s.apply()).status).toBe("already configured");
  });

  it("adds the key to an existing bash map, after the user's keys", async () => {
    stubOpencode("1.19.5");
    put(json(), JSON.stringify({ $schema: "s", permission: { edit: "ask", bash: { "*": "ask", "git *": "allow" } } }));
    await (await step()).apply();
    const doc = read(json());
    expect(doc["$schema"]).toBe("s");
    const permission = doc["permission"] as { edit: string; bash: Record<string, string> };
    expect(permission.edit).toBe("ask");
    expect(Object.keys(permission.bash)).toEqual(["*", "git *", ...PATTERNS]);
  });

  it("treats a blanket `allow` as already configured and any other single value as the user's choice", async () => {
    stubOpencode("1.19.5");
    put(json(), JSON.stringify({ permission: "allow" }));
    expect((await (await step()).apply()).status).toBe("already configured");
    put(json(), JSON.stringify({ permission: { bash: "ask" } }));
    expect((await (await step()).apply()).status).toBe("skipped");
    expect(read(json())).toEqual({ permission: { bash: "ask" } });
  });

  it("never overrides a different value for a key, and still adds the others", async () => {
    stubOpencode("1.19.5");
    put(json(), JSON.stringify({ permission: { bash: { "jubarteai connect*": "ask" } } }));
    const result = await (await step()).apply();
    expect(result.status).toBe("configured");
    expect(result.detail).toContain("jubarteai connect*");
    const bash = (read(json())["permission"] as { bash: Record<string, string> }).bash;
    expect(bash["jubarteai connect*"]).toBe("ask");
    expect(Object.keys(bash)).toHaveLength(PATTERNS.length);
    expect((await (await step()).apply()).status).toBe("skipped");
  });

  it("removes the legacy `jubarteai *` key, keeps the user's keys, and is idempotent", async () => {
    stubOpencode("1.19.5");
    put(json(), JSON.stringify({ permission: { bash: { "git *": "allow", "jubarteai *": "allow" } } }));
    expect((await opencodeAdapter.inspect(ctx())).notes.join(" ")).toContain("login, logout, link, init, update and uninstall");
    const s = await step();
    expect(s.sensitive).toBe(true);
    expect(s.preview).toContain('removes the "jubarteai *" allow rule');
    expect((await s.apply()).status).toBe("configured");
    expect(read(json())).toEqual({ permission: { bash: { "git *": "allow", ...V1_BASH } } });
    expectAgentOnly(read(json()));
    const again = await step();
    expect(again.sensitive).toBe(false);
    expect((await again.apply()).status).toBe("already configured");
  });

  it("prints the V1 rule for a config with comments", async () => {
    stubOpencode("1.19.5");
    put(json(), '{ /* c */ }');
    const out = await manual();
    expect(out.lines.join("\n")).toContain('"bash"');
    expect(out.lines.join("\n")).toContain('"jubarteai connect*": "allow"');
  });
});

describe.skipIf(!POSIX)("permission, unknown version", () => {
  it.each([["garbage"], ["3.0.0"], [""], ["0.1.0"]])("prints both syntaxes for %j and writes nothing", async (output) => {
    stubOpencode(output);
    const out = await manual();
    const text = out.lines.join("\n");
    expect(text).toContain('"permissions"');
    expect(text).toContain('"permission"');
    expect(text).toContain('"jubarteai connect*"');
    expect(text).not.toContain('"jubarteai *": "allow"');
    expect(out.reason).toContain("version");
    expect(() => readFileSync(jsonc())).toThrow();
    expect(() => readFileSync(json())).toThrow();
  });

  it("prints both syntaxes when --version fails", async () => {
    stubOpencode("2.1.3", 1);
    expect(isManual(await opencodeAdapter.permission(ctx()))).toBe(true);
  });

  it("prints both syntaxes when the binary is not on PATH", async () => {
    expect(isManual(await opencodeAdapter.permission(ctx()))).toBe(true);
  });
});

describe.skipIf(!POSIX)("already configured", () => {
  it("is a non-sensitive step in V2 once the rule is there", async () => {
    stubOpencode("2.1.3");
    const first = await step();
    expect(first.sensitive).toBe(true);
    await first.apply();
    const again = await step();
    expect(again.sensitive).toBe(false);
    expect((await again.apply()).status).toBe("already configured");
  });

  it("is a non-sensitive step in V1 once the key is there, and a V1 rule does not satisfy V2", async () => {
    stubOpencode("1.19.5");
    put(json(), JSON.stringify({ permission: { bash: V1_BASH } }));
    expect((await step()).sensitive).toBe(false);
    stubOpencode("2.1.3");
    put(jsonc(), JSON.stringify({ permission: { bash: V1_BASH } }));
    expect((await step()).sensitive).toBe(true);
  });
});

describe.skipIf(!POSIX || process.getuid?.() === 0)("an unreadable config", () => {
  it("is printed instructions, never a throw", async () => {
    stubOpencode("2.1.3");
    put(jsonc(), "{}");
    chmodSync(jsonc(), 0o000);
    try {
      const out = await manual();
      expect(out.lines.join("\n")).toContain(`Couldn't read ${jsonc()}: fix its permissions`);
      const state = await opencodeAdapter.inspect(ctx());
      expect(state.permission).toBe("manual");
      expect(state.notes).toHaveLength(1);
    } finally {
      chmodSync(jsonc(), 0o600);
    }
  });
});

describe("hooks", () => {
  it("is printed instructions, never a step", async () => {
    const out = await opencodeAdapter.hooks(ctx());
    expect(isManual(out)).toBe(true);
    if (!isManual(out)) return;
    expect(out.harness).toBe("opencode");
    expect(out.reason).toContain("D25");
    expect(out.lines.join("\n")).toContain("jubarteai inbox");
  });

  it("its prose names the bare command agents type, never the absolute hook command init resolves", async () => {
    const out = await opencodeAdapter.hooks(ctx({ hookCommand: '"/usr/local/bin/node" "/opt/jubarteai/bin/jubarteai.js"' }));
    if (!isManual(out)) throw new Error("expected instructions");
    const text = out.lines.join("\n");
    expect(text).toContain("`jubarteai connect`");
    expect(text).not.toContain("node");
    expect(text).not.toContain('"');
  });
});

describe.skipIf(!POSIX)("inspect", () => {
  it("is read-only: missing on an empty home, and it never runs opencode", async () => {
    expect(await opencodeAdapter.inspect(ctx())).toEqual({ permission: "missing", hooks: "manual", mcpEntries: [], notes: [] });
    expect(() => readFileSync(jsonc())).toThrow();
  });

  it("sees a rule written in either version's syntax", async () => {
    stubOpencode("2.1.3");
    await (await step()).apply();
    expect((await opencodeAdapter.inspect(ctx())).permission).toBe("configured");
    rmSync(jsonc());
    put(json(), JSON.stringify({ permission: { bash: V1_BASH } }));
    expect((await opencodeAdapter.inspect(ctx())).permission).toBe("configured");
  });

  it("needs every per-command rule: a partial set, or only the legacy rule, is missing", async () => {
    put(jsonc(), JSON.stringify({ permissions: V2_RULES.slice(1) }));
    expect((await opencodeAdapter.inspect(ctx())).permission).toBe("missing");
    put(jsonc(), JSON.stringify({ permissions: [LEGACY_V2] }));
    expect((await opencodeAdapter.inspect(ctx())).permission).toBe("missing");
  });

  it("does not count a deny as configured", async () => {
    put(jsonc(), JSON.stringify({ permissions: V2_RULES.map((r) => ({ ...r, effect: "deny" })) }));
    expect((await opencodeAdapter.inspect(ctx())).permission).toBe("missing");
  });

  it("reports manual for a config with comments and no rule found", async () => {
    put(jsonc(), "{ // c\n}");
    const state = await opencodeAdapter.inspect(ctx());
    expect(state.permission).toBe("manual");
    expect(state.notes).toHaveLength(1);
  });
});

describe("invariant I6", () => {
  it("imports no node:fs write API", () => {
    const source = readFileSync(join(import.meta.dirname, "opencode.ts"), "utf8");
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) expect(["existsSync", "readFileSync", "statSync"]).toContain(name);
    expect(source).not.toMatch(/from\s*"node:fs\/promises"|import\s*\*\s*as\s*\w+\s*from\s*"node:fs"/);
  });
});
