// Every permission rule the CLI prints (review R-M3), like every rule it writes (R-M1), names agent commands only or
// carries the person-command caveat. A table over ADAPTERS, so a new adapter with a printed rule is held to the same bar.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_RULE_WORDS, PERSON_COMMANDS, PERSON_COMMAND_LIST } from "./agent-commands.js";
import { ADAPTERS } from "./registry.js";
import type { HarnessId } from "../session/harness-env.js";
import type { InitCtx, ManualInstructions } from "./types.js";

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

/** Rules that approve the whole program; printed only beside the caveat. */
const BROAD_RULES: readonly string[] = ["shell(jubarteai:*)", "Shell(jubarteai)", "Bash(jubarteai *)", "PowerShell(jubarteai *)", "run_shell_command(jubarteai)", '"jubarteai *"', '"jubarteai": true', "^jubarteai\\\\b"];

/** The instructions name every person command as left out: the caveat prose, or one rule (deny/ask) per command. */
function namesPersonCommands(text: string): boolean {
  return text.includes(PERSON_COMMAND_LIST) || PERSON_COMMANDS.every((command) => text.includes(`jubarteai ${command}`));
}

describe("printed permission rules", () => {
  it("come from every adapter that prints one", async () => {
    const harnesses = new Set<HarnessId>((await printedPermissions()).map((m) => m.harness));
    for (const id of ["claude-code", "cursor", "vscode", "windsurf", "zed", "gemini-cli", "opencode", "copilot-cli"] as const) expect(harnesses.has(id), id).toBe(true);
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

  it("carry the person-command caveat wherever they talk about allowing or approving", async () => {
    for (const manual of await printedPermissions()) {
      const text = manual.lines.join("\n");
      const broad = BROAD_RULES.filter((rule) => text.includes(rule));
      if (broad.length > 0 || /allow|approve/i.test(text)) expect(namesPersonCommands(text), `${manual.harness}: ${manual.title}`).toBe(true);
    }
  });
});
