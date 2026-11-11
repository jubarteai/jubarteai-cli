// Every permission rule the CLI prints (review R-M3), like every rule it writes (R-M1), never pre-approves a person
// command. Each printed instruction declares its entries in `rules` (review R-S11); the table checks every entry against
// that harness's matching, checks that the lines print no undeclared allow, and that a whole-program rule shows up only
// as a declared entry or in a line that names the person commands. A table over ADAPTERS, so a new adapter with a printed
// rule is held to the same bar. Written rules are checked by each adapter's own tests.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_COMMANDS, AGENT_RULE_WORDS, PERSON_COMMANDS, PERSON_COMMAND_LIST } from "./agent-commands.js";
import { ADAPTERS } from "./registry.js";
import type { HarnessId } from "../session/harness-env.js";
import type { InitCtx, ManualInstructions, PrintedRule } from "./types.js";

let root: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jubarteai-printed-")));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const isManual = (v: unknown): v is ManualInstructions => typeof v === "object" && v !== null && "kind" in v && v.kind === "manual";

function ctx(over: Partial<InitCtx> = {}): InitCtx {
  return { home, env: {}, platform: "linux", which: () => null, projectRoot: null, cliCommand: "jubarteai", ...over };
}

/** A settings file with a comment: every writing adapter refuses it and prints its rule instead. */
function commented(...parts: string[]): void {
  const file = join(home, ...parts);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '// mine\n{ "a": 1 }\n', { mode: 0o600 });
}

/** The printed permission instructions of every adapter, from a bare home and from one where every config has comments. */
async function printedPermissions(): Promise<ManualInstructions[]> {
  const out: ManualInstructions[] = [];
  const collect = async (c: InitCtx): Promise<void> => {
    for (const adapter of ADAPTERS) {
      const result = await adapter.permission(c);
      if (isManual(result)) out.push(result);
    }
  };
  await collect(ctx());
  commented(".claude", "settings.json");
  commented(".config", "Code", "User", "settings.json");
  commented(".config", "zed", "settings.json");
  commented(".gemini", "settings.json");
  await collect(ctx({ which: (c) => (c === "code" ? "/usr/bin/code" : null) }));
  return out;
}

/** Allow rules in the printed syntaxes that name one command: Copilot CLI flags, Gemini entries, OpenCode globs (V1 and V2). */
const ALLOW_RULES: readonly RegExp[] = [
  /--allow-tool='shell\(jubarteai ([^)':]+)\)'/g,
  /run_shell_command\(jubarteai ([^)]+)\)/g,
  /"resource": "jubarteai ([^"*]+)\*"/g,
  /"jubarteai ([^"*]+)\*": "allow"/g,
];

/** Rules or flags that approve the whole program; a printed line may hold one only as a declared entry or beside the caveat. */
const BROAD_RULES: readonly string[] = [
  "shell(jubarteai:*)",
  "shell(jubarteai)",
  "--allow-all-tools",
  "--yolo",
  "Shell(jubarteai)",
  "Bash(jubarteai *)",
  "PowerShell(jubarteai *)",
  "run_shell_command(jubarteai)",
  '"jubarteai *"',
  '"jubarteai": true',
  "^jubarteai\\\\b",
];

/** The instructions name every person command as left out: the caveat prose, or one rule (deny/ask) per command. */
function namesPersonCommands(text: string): boolean {
  return text.includes(PERSON_COMMAND_LIST) || PERSON_COMMANDS.every((command) => text.includes(`jubarteai ${command}`));
}

// ---- each harness's matching, as documented (or, where it isn't, the broadest reading) --------------------------------

/** A shell glob where `*` matches any characters, matched against the whole command line. */
function globMatches(glob: string, line: string): boolean {
  const source = glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(line);
}

/** `line` is the program `program` (first word) run with anything after it. */
const sameProgram = (program: string, line: string): boolean => line.split(/\s+/)[0] === program.split(/[\s:]/)[0];
/** `prefix` followed by the end of the line or a space. */
const wordPrefix = (prefix: string, line: string): boolean => line === prefix || line.startsWith(`${prefix} `);
/** The text inside `Tool(...)`, or null when `entry` isn't that shape. */
const inside = (entry: string, tool: string): string | null => (entry.startsWith(`${tool}(`) && entry.endsWith(")") ? entry.slice(tool.length + 1, -1) : null);

/**
 * Whether a rule entry matches a command line in each harness that prints rules. Copilot CLI and Cursor match a program
 * other than git/gh by its name (GitHub "Configure Copilot CLI"; Cursor's `Shell(<program>)`), Windsurf by plain prefix.
 */
const MATCHERS: Partial<Record<HarnessId, (entry: string, line: string) => boolean>> = {
  "claude-code": (entry, line) => {
    const pattern = inside(entry, "Bash") ?? inside(entry, "PowerShell");
    if (pattern === null) return false;
    // `Bash(x:*)` is Claude Code's older spelling of `Bash(x *)`.
    return globMatches(pattern.replace(/:\*$/, " *"), line) || (pattern.endsWith(" *") && line === pattern.slice(0, -2));
  },
  cursor: (entry, line) => {
    const program = inside(entry, "Shell");
    return program !== null && sameProgram(program, line);
  },
  "copilot-cli": (entry, line) => {
    const rule = inside(entry, "shell");
    return rule !== null && sameProgram(rule, line);
  },
  vscode: (entry, line) => (entry.length > 1 && entry.startsWith("/") && entry.endsWith("/") ? new RegExp(entry.slice(1, -1)).test(line) : wordPrefix(entry, line)),
  zed: (entry, line) => new RegExp(entry).test(line),
  "gemini-cli": (entry, line) => {
    const command = inside(entry, "run_shell_command");
    return entry === "run_shell_command" || (command !== null && wordPrefix(command, line));
  },
  opencode: (entry, line) => globMatches(entry, line),
  windsurf: (entry, line) => line.startsWith(entry),
};

/**
 * Harnesses whose documented ask/deny entries hold back a command an allow entry matches: Claude Code (ask beats allow,
 * matched on the command text) and VS Code (a false entry wins over any true one). Anywhere else an allow entry must
 * not match a person command on its own, since a deny there is a hope, not a guarantee (review R-M4).
 */
const HOLD_BACK_VERIFIED: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude-code", "vscode"]);

/** Command lines an agent runs: every agent command with arguments, and the lone info flags. */
const AGENT_LINES: readonly string[] = [...AGENT_COMMANDS.map((command) => `jubarteai ${command} --agent x`), "jubarteai --help", "jubarteai --version"];
/** Command lines no rule may pre-approve: each person command bare, with flags and with an argument. */
const PERSON_LINES: readonly string[] = PERSON_COMMANDS.flatMap((command) => [`jubarteai ${command}`, `jubarteai ${command} --yes`, `jubarteai ${command} --with-token`, `jubarteai ${command} x`]);

/** Approved: some allow entry matches and no ask or deny entry does (ask and deny beat allow in every harness here). */
function approves(match: (entry: string, line: string) => boolean, rules: readonly PrintedRule[], line: string): boolean {
  return rules.some((r) => r.effect === "allow" && match(r.entry, line)) && !rules.some((r) => r.effect !== "allow" && match(r.entry, line));
}

/** The entry as printed: verbatim, or JSON-escaped inside a printed JSON snippet. */
function printedIn(text: string, entry: string): boolean {
  return text.includes(entry) || text.includes(JSON.stringify(entry).slice(1, -1));
}

describe("printed permission rules", () => {
  it("come from every adapter that prints one", async () => {
    const harnesses = new Set<HarnessId>((await printedPermissions()).map((m) => m.harness));
    for (const id of ["claude-code", "cursor", "vscode", "windsurf", "zed", "gemini-cli", "opencode", "copilot-cli"] as const) expect(harnesses.has(id), id).toBe(true);
  });

  it("declare every entry they tell the person to add, each one printed in the lines", async () => {
    for (const manual of await printedPermissions()) {
      const label = `${manual.harness}: ${manual.title}`;
      expect(manual.rules, label).toBeDefined();
      const text = manual.lines.join("\n");
      for (const rule of manual.rules ?? []) expect(printedIn(text, rule.entry), `${label}: ${rule.entry}`).toBe(true);
      // An allow rule visible in the lines is a declared one, so the structured check below sees it.
      for (const pattern of ALLOW_RULES) {
        for (const match of text.matchAll(pattern)) {
          const declared = (manual.rules ?? []).some((rule) => rule.effect === "allow" && match[0].includes(rule.entry));
          expect(declared, `${label}: undeclared ${match[0]}`).toBe(true);
        }
      }
    }
  });

  it("never pre-approve a person command under each harness's matching, by allow entries alone where a deny is unverified", async () => {
    for (const manual of await printedPermissions()) {
      const rules = manual.rules ?? [];
      if (rules.length === 0) continue;
      const match = MATCHERS[manual.harness];
      if (match === undefined) throw new Error(`no matcher for ${manual.harness}: add one before printing rules for it`);
      const counted = HOLD_BACK_VERIFIED.has(manual.harness) ? rules : rules.filter((rule) => rule.effect === "allow");
      for (const line of PERSON_LINES) expect(approves(match, counted, line), `${manual.harness}: ${line}`).toBe(false);
    }
  });

  it("make every allow entry approve some agent command, and every ask or deny entry hold back some person command", async () => {
    for (const manual of await printedPermissions()) {
      const rules = manual.rules ?? [];
      const match = MATCHERS[manual.harness];
      if (match === undefined) continue;
      for (const rule of rules) {
        if (rule.effect === "allow") expect(AGENT_LINES.some((line) => approves(match, [rule, ...rules.filter((r) => r.effect !== "allow")], line)), `${manual.harness}: ${rule.entry}`).toBe(true);
        else expect(PERSON_LINES.some((line) => match(rule.entry, line)), `${manual.harness}: ${rule.entry}`).toBe(true);
      }
    }
  });

  it("name agent commands only in every allow rule", async () => {
    for (const manual of await printedPermissions()) {
      const text = manual.lines.join("\n");
      for (const pattern of ALLOW_RULES) {
        for (const match of text.matchAll(pattern)) {
          const word = (match[1] ?? "").split(/\s/)[0] ?? "";
          expect(AGENT_RULE_WORDS, `${manual.harness}: ${match[0]}`).toContain(word);
        }
      }
    }
  });

  it("show a whole-program rule only as a declared entry or in a line that names the person commands", async () => {
    for (const manual of await printedPermissions()) {
      const declared = (manual.rules ?? []).map((rule) => rule.entry);
      for (const line of manual.lines) {
        for (const broad of BROAD_RULES.filter((rule) => line.includes(rule))) {
          const asEntry = declared.some((entry) => entry.includes(broad.replace(/^"|"$/g, "")));
          expect(asEntry || line.includes(PERSON_COMMAND_LIST), `${manual.harness}: ${broad} in "${line}"`).toBe(true);
        }
      }
    }
  });

  it("carry the person-command caveat wherever they talk about allowing or approving", async () => {
    for (const manual of await printedPermissions()) {
      const text = manual.lines.join("\n");
      if (/allow|approve/i.test(text)) expect(namesPersonCommands(text), `${manual.harness}: ${manual.title}`).toBe(true);
    }
  });
});
