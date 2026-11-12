import { describe, expect, it } from "vitest";

import { GUARD_INPUT_MAX_BYTES, GUARD_SCAN_BUDGET, GUARD_SCAN_MAX_DEPTH, GUARD_SCAN_PARSE_COST, GUARD_SCAN_VALUE_COST } from "../constants.js";
import { AGENT_COMMANDS, PERSON_COMMANDS } from "../harness/agent-commands.js";
import { SHELL_TOOL_MATCHER, personCommandIn, toolGuardDecision } from "./tool-guard.js";

/** A Copilot CLI payload: camelCase, `toolArgs` as the JSON string the runtime sends for a shell call. */
const camel = (command: string, toolName = "bash"): string => JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/r", toolName, toolArgs: JSON.stringify({ command, description: "x" }) });
/** The PascalCase `PreToolUse` alias: snake_case, Claude tool name, parsed `tool_input`. */
const snake = (command: string, toolName = "Bash"): string => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: toolName, tool_input: { command } });

const denied = (raw: string): boolean => "permissionDecision" in toolGuardDecision(raw);

/**
 * The guard's own deny for `command`, matched from the reason's start. The too-large refusal also contains
 * "jubarteai login" ("…check for jubarteai login, logout, …"), so a looser `stringContaining("jubarteai login")` passes
 * on a too-large refusal too and can't tell the scan found the command (review round 13 N3).
 */
const denyFor = (command: string): { permissionDecision: "deny"; permissionDecisionReason: unknown } => ({
  permissionDecision: "deny",
  permissionDecisionReason: expect.stringMatching(new RegExp(`^jubarteai ${command} changes the saved account`)),
});

/** The refusal of a payload too large (or too deeply nested) to check. */
const TOO_LARGE_OUT = { permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^This tool call is too large/) };

/** Spellings an agent (or an injected prompt) could use to run a person command. `%s` is the command; a function builds the line. */
const PERSON_FORMS: ReadonlyArray<string | ((command: string) => string)> = [
  "jubarteai %s",
  "jubarteai %s --with-token",
  "echo jba_x | jubarteai %s --with-token",
  "jubarteai inbox && jubarteai %s",
  "jubarteai inbox;jubarteai %s",
  "jubarteai inbox || jubarteai %s",
  "echo $(jubarteai %s)",
  "echo `jubarteai %s`",
  "(jubarteai %s)",
  'jubarteai "%s"',
  "jubarteai '%s' --yes",
  'j"ubarteai" %s',
  "jubarteai \\%s",
  "/usr/local/bin/jubarteai %s",
  '"/opt/node/bin/node" "/opt/jubarteai/bin/jubarteai.js" %s',
  "npx -y jubarteai@latest %s",
  "C:\\Users\\me\\AppData\\Roaming\\npm\\jubarteai.cmd %s",
  "& jubarteai %s",
  "JubarteAI %s",
  "jubarteai --yes %s",
  'bash -c "jubarteai %s"',
  "cd /r\njubarteai %s",
  // A path lookup (review R-S15): the program is followed by `)` or a backtick, not whitespace.
  "$(which jubarteai) %s",
  '"$(command -v jubarteai)" %s --yes',
  "`command -v jubarteai` %s",
  "& (Get-Command jubarteai) %s",
  // bash ANSI-C and locale quoting.
  "jubarteai $'%s'",
  'jubarteai $"%s"',
  // PowerShell's backtick escape inside the word.
  (command) => `jubarteai ${command.slice(0, 1)}\`${command.slice(1)}`,
  (command) => `& jub\`arteai ${command}`,
  "npm exec jubarteai -- %s",
  // npm exec / npm x parse flags after the package name themselves, so a flag with a value or a version range still
  // runs the person command (review R-S17).
  "npm exec jubarteai --loglevel=silent %s",
  "npm exec --yes jubarteai --registry=https://registry.npmjs.org %s",
  "npm x jubarteai --prefer-online=true %s",
  'npx "jubarteai@>=1" %s',
  "npx 'jubarteai@<2' %s",
  "npm exec jubarteai@https://x/y.tgz %s",
  // npm also takes a flag's value from the next word (review R-S18): npm 11 runs `login` for each of these.
  "npm exec jubarteai --loglevel silent %s",
  "npm x jubarteai --cache /tmp/c %s",
  "npm exec jubarteai --loglevel silent --cache /tmp/c %s",
  "npm exec jubarteai --yes -- %s",
  // A package spec or flag value that itself names the package is one word and hides nothing (review R-S19).
  "npx jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz %s",
  "npx --yes jubarteai@file:/tmp/jubarteai-1.0.0.tgz %s",
  "npm exec jubarteai --prefix=../jubarteai-cli %s",
  "npm exec jubarteai --cache=/tmp/my-jubarteai-cache %s",
  "npm exec jubarteai --prefix ../jubarteai-cli %s",
  // Redirection or a brace right after the command word.
  "{ jubarteai %s>/dev/null; }",
  // The package's npm pack tarball runs its one bin, whether named by path, file: spec or registry URL (review R-S2, round 9).
  "npx ./jubarteai-0.1.0.tgz %s",
  "npx file:/tmp/jubarteai-0.1.0.tgz %s",
  "npx --yes https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz %s",
  "npm exec ./JubarteAI-1.2.3-beta.1.tgz -- %s",
  "npx C:\\Users\\me\\jubarteai-0.1.0.tgz %s",
  "npx ./jubarteai-*.tgz %s",
  "npx ./jubarteai*.tgz %s",
  "npm exec ./jubarteai-?.?.?.tgz -- %s",
  '["$(npm exec jubarteai --cache ", " %s)"]',
  '["`npm exec jubarteai --cache ", " %s`"]',
  '["$(npx jubarteai --workspace ", " %s)"]',
  // A redirection between the program and the command (review R-S3, round 9): bash and PowerShell take one anywhere.
  "jubarteai 2>/dev/null %s",
  "jubarteai 2> /dev/null %s",
  "npx jubarteai 2>&1 %s",
  "jubarteai &>/dev/null %s",
  "jubarteai >&2 %s",
  "jubarteai >| out %s",
  "jubarteai <<<x %s",
  "jubarteai *>$null %s",
  "jubarteai *> $null %s",
  "npm exec jubarteai --loglevel silent 2>&1 %s",
];

const render = (form: string | ((command: string) => string), command: string): string => (typeof form === "string" ? form.replace("%s", command) : form(command));

describe("toolGuardDecision: denies every person command, whatever the spelling", () => {
  for (const command of PERSON_COMMANDS) {
    for (const form of PERSON_FORMS) {
      const line = render(form, command);
      it(`${JSON.stringify(line)}`, () => {
        const camelOut = toolGuardDecision(camel(line));
        expect(camelOut).toEqual(denyFor(command));
        expect(denied(snake(line))).toBe(true);
        expect(denied(camel(line, "powershell"))).toBe(true);
      });
    }
  }

  it("a glob or brace earlier in the path, before the final name: denied, since the word still ends in the name (review round 13 N2)", () => {
    // Bash expands each glob to the installed path (when one file matches it), which runs the person command.
    expect(toolGuardDecision(camel("/opt/*/bin/jubarteai login"))).toEqual(denyFor("login"));
    expect(toolGuardDecision(camel("~/.nvm/versions/node/v2?.*/bin/jubarteai logout"))).toEqual(denyFor("logout"));
    expect(toolGuardDecision(camel("/opt/home*/bin/jubarteai.cmd link"))).toEqual(denyFor("link"));
    // Errs safe: bash runs `/usr/local/bin/jubarteai jubarteai login` (command `jubarteai`), but the word ends in the name.
    expect(toolGuardDecision(camel("{/usr/local/bin/,}jubarteai login"))).toEqual(denyFor("login"));
  });

  it("reads toolArgs given as an object as well as a JSON string", () => {
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: { command: "jubarteai login" } }))).toBe(true);
  });

  it("toolArgs as a JSON string, parsed once: padded with whitespace, an array, or naming the shell only by its command", () => {
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: ` \n${JSON.stringify({ command: "jubarteai login" })}\t ` }))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify(["echo hi", "jubarteai logout"]) }))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "someNewShell", toolArgs: JSON.stringify({ command: "jubarteai link" }) }))).toBe(true);
    expect(toolGuardDecision(JSON.stringify({ toolName: "someNewShell", toolArgs: JSON.stringify({ command: "jubarteai inbox" }) }))).toEqual({});
    // The top level is the runtime's wrapper, only parsed: a person command split across its strings is not run by a shell.
    expect(toolGuardDecision(JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ command: "echo $(npm exec jubarteai --cache ", description: " login)" }) }))).toEqual({});
  });

  it("reads object keys and JSON nested in a string, unescaped, and the JSON's raw text too (a shell runs that text)", () => {
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: { command: "echo", "jubarteai login": 1 } }))).toBe(true);
    expect(denied(camel('["echo hi", "jubarteai \\u006cogin"]'))).toBe(true);
    expect(denied(camel(JSON.stringify({ argv: ["sh", "-c", "jubarteai update"] })))).toBe(true);
  });

  it("a tool with another name counts as a shell when its arguments carry a command string", () => {
    expect(denied(JSON.stringify({ toolName: "run_in_terminal", toolArgs: { command: "jubarteai init --yes" } }))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "someNewShell", toolArgs: { command: "jubarteai link" } }))).toBe(true);
  });

  it("finds a command however much padding comes before it (the payload is parsed whole; review R-S14)", () => {
    expect(denied(camel(`echo ${"x".repeat(2 * 1024 * 1024)}; jubarteai login`))).toBe(true);
    expect(denied(JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ description: "y".repeat(2 * 1024 * 1024), command: "jubarteai link" }) }))).toBe(true);
  });

  it("denies a payload the hook read only in part, whatever the part holds", () => {
    expect(toolGuardDecision('{"toolName":"bash","toolArgs":"{\\"command\\":\\"echo hi', true)).toEqual(TOO_LARGE_OUT);
  });
});

describe("toolGuardDecision: linear time (review R-S13)", () => {
  /** Milliseconds `fn` takes. The bounds below are far above linear time and far below the old exponential/quadratic. */
  const time = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it("a run of flag tokens before a failed match, then a later person command: a deny, quickly", () => {
    for (const flag of ["--a", "-a", "--", "-"]) {
      const line = `echo jubarteai ${`${flag} `.repeat(60)}x; jubarteai login`;
      let out: unknown;
      expect(time(() => (out = toolGuardDecision(camel(line)))), flag).toBeLessThan(1_000);
      expect(out, flag).toEqual(denyFor("login"));
    }
  });

  it("a long run of flags with values, then a person command: a deny, quickly (review R-S17)", () => {
    const line = `echo jubarteai ${"--a=b ".repeat(60_000)}x; jubarteai ${"--a=b ".repeat(60_000)}login`;
    let out: unknown;
    expect(time(() => (out = toolGuardDecision(camel(line))))).toBeLessThan(2_000);
    expect(out).toEqual(denyFor("login"));
  });

  describe("JSON nested in a shell argument, level after level (review R-S1, round 9)", () => {
    /** `inner` characters of padding before `tail`, string-encoded as a one-element JSON array `levels` times. */
    const nest = (inner: number, tail: string, levels: number): string => {
      let nested = `echo ${"x".repeat(inner)}; ${tail}`;
      for (let level = 0; level < levels; level += 1) nested = JSON.stringify([nested]);
      return nested;
    };

    it("nine deep: scanned whole and decided quickly, by the scan's own deny", () => {
      // Every level's raw text is scanned as well as the innermost string (review round 10), so the payload costs about
      // eleven times the inner string: 512 KiB keeps it under the scan budget. Ten levels of 1 MiB, the earlier version
      // of this test, was the too-large refusal on both the budget and the depth cap, which the looser
      // stringContaining("jubarteai login") matcher could not tell from a scan deny (review round 13 N3).
      const inner = 512 * 1024;
      expect(11 * inner).toBeLessThan(GUARD_SCAN_BUDGET);
      let out: unknown;
      expect(time(() => (out = toolGuardDecision(camel(nest(inner, "jubarteai login", 9)))))).toBeLessThan(2_000);
      expect(out).toEqual(denyFor("login"));
      // The same nesting with no person command is scanned through to {}: neither refused nor denied.
      expect(toolGuardDecision(camel(nest(inner, "jubarteai inbox", 9)))).toEqual({});
    });

    it("ten deep is past the nesting cap: each string-encoded level is two levels (the string, then the array it parses to)", () => {
      // Copilot's toolArgs object is depth 1 and its command string depth 2, so the ninth level's innermost string sits
      // at depth 20 (GUARD_SCAN_MAX_DEPTH) and a tenth goes past it: refused as too deep to check, small as it is.
      expect(GUARD_SCAN_MAX_DEPTH).toBe(20);
      expect(toolGuardDecision(camel(nest(16, "jubarteai inbox", 9)))).toEqual({});
      expect(toolGuardDecision(camel(nest(16, "jubarteai inbox", 10)))).toEqual(TOO_LARGE_OUT);
    });
  });

  it("a large JSON-shaped command with no person command: its raw text and every string scanned, decided quickly (review R-S3, round 11)", () => {
    // Under the scan budget, so every one of the 80k strings is collected and scanned before the answer, which is {}.
    const items = Array.from({ length: 80_000 }, () => "a b c d e");
    let out: unknown;
    expect(time(() => (out = toolGuardDecision(camel(JSON.stringify(items)))))).toBeLessThan(3_000);
    expect(out).toEqual({});
    // The same array with the command split across its last two strings is denied by the raw text (review R-S1, round 10).
    expect(toolGuardDecision(camel(JSON.stringify([...items, "$(npm exec jubarteai --cache ", " login)"])))).toEqual(denyFor("login"));
  });

  describe("millions of tiny strings: refused as too large to check, quickly, not scanned into the timeout (review R-S1, round 11)", () => {
    /** The largest payload `wrap` builds from `head` plus copies of `item` that stays under the read cap. */
    const fill = (head: unknown[], item: unknown, wrap: (items: unknown[]) => string): string => {
      const base = wrap(head).length;
      const per = wrap([...head, item]).length - base;
      return wrap([...head, ...Array.from({ length: Math.floor((GUARD_INPUT_MAX_BYTES - 1024 - base) / per) }, () => item)]);
    };
    const vscode = (items: unknown[]): string => JSON.stringify({ tool_name: "run_in_terminal", tool_input: { command: JSON.stringify(items) } });
    const argv = (items: unknown[]): string => JSON.stringify({ tool_name: "bash", tool_input: { command: "echo", args: items } });
    const copilot = (items: unknown[]): string => JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ command: JSON.stringify(items) }) });
    const shapes: ReadonlyArray<[string, () => string]> = [
      ["VS Code command, a JSON array of \"[\"", () => fill(["$(jubarteai login)"], "[", vscode)],
      ["the same strings in a separate argument array", () => fill(["$(jubarteai login)"], "[", argv)],
      ["Copilot camelCase, a JSON array of \"[\"", () => fill(["echo"], "[", copilot)],
      ["a plain array of empty strings", () => fill(["echo"], "", argv)],
      ["invalid JSON strings that start and end with a bracket", () => fill(["echo"], "[]]", argv)],
      ["empty arrays", () => fill(["echo"], [], argv)],
    ];
    for (const [name, build] of shapes) {
      it(name, () => {
        const raw = build();
        expect(raw.length).toBeGreaterThan(GUARD_INPUT_MAX_BYTES * 0.99);
        expect(raw.length).toBeLessThan(GUARD_INPUT_MAX_BYTES);
        let out: unknown;
        expect(time(() => (out = toolGuardDecision(raw)))).toBeLessThan(2_000);
        expect(out).toEqual(TOO_LARGE_OUT);
      }, 20_000);
    }

    it("just under the budget, the slowest per-string shape still answers well inside the timeout", () => {
      // As many failed parse attempts as the budget admits, the costliest step per string, and no person command: {}.
      const count = Math.floor((GUARD_SCAN_BUDGET * 0.95) / (GUARD_SCAN_VALUE_COST + "[]]".length + GUARD_SCAN_PARSE_COST));
      const raw = argv(["echo", ...Array.from({ length: count }, () => "[]]")]);
      let out: unknown;
      expect(time(() => (out = toolGuardDecision(raw)))).toBeLessThan(3_000);
      expect(out).toEqual({});
    });
  });

  describe("the slowest content per character at the largest admitted size: decided well inside the timeout (review R-S1, round 12)", () => {
    /** VS Code's shape: the tool input as an object, a JSON-shaped string in it scanned as raw text and parsed strings. */
    const vscode = (input: Record<string, string>): string => JSON.stringify({ tool_name: "run_in_terminal", tool_input: input });
    /** The largest `build(n)` that stays 16 KiB under the read cap (the margin keeps the doubled scan under the budget). */
    const largest = (build: (n: number) => string): string => {
      let lo = 1;
      let hi = GUARD_INPUT_MAX_BYTES;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(build(mid)) > GUARD_INPUT_MAX_BYTES - 16 * 1024) hi = mid - 1;
        else lo = mid;
      }
      return build(lo);
    };
    const cases: ReadonlyArray<[string, () => string, unknown]> = [
      [
        "a decoy key of backticks and separators before the person command: the deny is not delayed into the timeout",
        () => largest((n) => vscode({ explanation: JSON.stringify(["`;".repeat(n)]), command: "jubarteai login" })),
        denyFor("login"),
      ],
      ["backticks and separators after the program, in a JSON-shaped command", () => largest((n) => vscode({ command: JSON.stringify([`jubarteai${"`;".repeat(n)}`]) })), {}],
      // Not a cap regression guard: JSON escapes each backslash twice on the way to the payload, so this content reaches
      // only about half the scan budget at the cap and would pass at 16 MiB too. It times the slowest content per
      // character found (about 235 ns), which the stated bound is built on (review round 13 N3).
      ["backslash-backticks after the program, in a JSON-shaped command (about half the scan budget: the slowest content per character)", () => largest((n) => vscode({ command: JSON.stringify([`jubarteai${"\\`".repeat(n)}`]) })), {}],
    ];
    for (const [name, build, expected] of cases) {
      it(name, () => {
        const raw = build();
        expect(Buffer.byteLength(raw)).toBeGreaterThan(GUARD_INPUT_MAX_BYTES * 0.99);
        let out: unknown;
        expect(time(() => (out = toolGuardDecision(raw)))).toBeLessThan(4_000);
        expect(out).toEqual(expected);
      }, 20_000);
    }
  });

  it("nested JSON past the scan budget is denied as too large to check, without scanning it (review R-S1, round 9)", () => {
    let nested = `echo ${"x".repeat(4 * 1024 * 1024)}`;
    for (let level = 0; level < 10; level += 1) nested = JSON.stringify([nested]);
    let out: unknown;
    expect(time(() => (out = toolGuardDecision(camel(nested))))).toBeLessThan(2_000);
    expect(out).toEqual(TOO_LARGE_OUT);
  });

  it("a three-megabyte single word, then a person command: a deny, not an engine stack overflow that fails open", () => {
    let out: unknown;
    expect(time(() => (out = toolGuardDecision(camel(`jubarteai ${"x".repeat(3 * 1024 * 1024)}>&2; jubarteai login`))))).toBeLessThan(3_000);
    expect(out).toEqual(denyFor("login"));
  });

  it("one long token holding many program names (paths, versions, lookups) stays linear", () => {
    const units = ["--x/jubarteai ", "jubarteai@x/", "/jubarteai/", "--x=jubarteai ", "$(jubarteai)", " jubarteai \t", "--x=/jubarteai ", "jubarteai@>=", "jubarteai --a=b ", "-->jubarteai ", "jubarteai@jubarteai@", "jubarteai --a b ", "jubarteai --a login ", "=jubarteai --a b c ", "jubarteai -- ", "jubarteai@x/jubarteai-1.tgz --a ", "jubarteai --a jubarteai ", "x/jubarteai-cli ", "jubarteai 2> ", "jubarteai 2>&1 ", "jubarteai >| ", "=jubarteai-1=", "jubarteai-1.tgz:", "/jubarteai-1.tgz ", ":jubarteai-1", "1", "jubarteai 1", ">"];
    for (const unit of units) {
      const line = unit.repeat(Math.ceil(400_000 / unit.length));
      expect(time(() => toolGuardDecision(camel(line))), unit).toBeLessThan(2_000);
    }
  });
});

describe("toolGuardDecision: makes no decision otherwise", () => {
  const agentLines = [...AGENT_COMMANDS.map((command) => `jubarteai ${command} --agent 11111111-1111-4111-8111-111111111111`), "jubarteai --help", "jubarteai --version", "jubarteai"];

  for (const line of agentLines) {
    it(`${JSON.stringify(line)} → {}`, () => {
      expect(toolGuardDecision(camel(line))).toEqual({});
      expect(toolGuardDecision(snake(line))).toEqual({});
    });
  }

  it("an agent command after npm's flags, with or without a value or `--` (review R-S18)", () => {
    for (const line of [
      "npm exec jubarteai -- search-knowledge --query update",
      "npm exec jubarteai --yes search-knowledge --query update",
      "npm exec jubarteai --loglevel silent inbox --agent 11111111-1111-4111-8111-111111111111",
      "npx jubarteai@https://registry.npmjs.org/jubarteai/-/jubarteai-1.0.0.tgz inbox",
      "npm exec jubarteai --prefix=../jubarteai-cli -- echo-current-task --title login",
    ]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("other programs and lookalike words", () => {
    for (const line of ["git status", "jubarteai-cli login", "myjubarteai login", "jubarteai loginx", "jubarteai inbox --login", "echo jubarteai", "npm run login", "ls /tmp/my-jubarteai-cache login", "jubarteai; login", "jubarteai | login", "jubarteai@1 inbox && echo login", "jubarteai search-knowledge --query \"how does init work\""]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("lookalike tarballs, an agent command from a tarball, and a redirection before an agent command", () => {
    for (const line of [
      "npx ./jubarteai-cli-0.1.0.tgz login",
      "npx ./my-jubarteai-1.0.0.tgz login",
      "npx ./jubarteai-cli-*.tgz login",
      "npx ./my-jubarteai-*.tgz login",
      "npx ./jubarteai-c*.tgz login",
      "npx ./jubarteai-0.1.0.tgz inbox --agent 11111111-1111-4111-8111-111111111111",
      "tar -tzf jubarteai-0.1.0.tgz | grep login",
      "jubarteai 2>/dev/null inbox",
      "jubarteai inbox 2>&1 | grep login",
      "jubarteai inbox &>/dev/null & echo login",
    ]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("the gaps spec I6 records: a program word built by glob or brace expansion, other than the tarball glob (review R-S3, round 12)", () => {
    // Bash expands each of these to a jubarteai program word before it runs (where the glob matches the installed file),
    // so they do run login; if one starts being denied, update I6.
    for (const line of ["jubarteai* login", "/opt/homebrew/bin/jubarteai* login", "/opt/homebrew/bin/jubartea? login", "~/.local/bin/jub*ai login", "{jubarteai,} login", "{/usr/local/bin/jubarteai,} login", "npx ./*.tgz login", "npx ./jubarte?i-0.1.0.tgz login"]) {
      expect(toolGuardDecision(camel(line)), line).toEqual({});
    }
  });

  it("a brace after the program name is not a gap: bash runs `jubarteai jubarteai login`, whose command is not login (review round 13 N1)", () => {
    // `jubarteai{,}` expands to two words, `jubarteai jubarteai`, so the CLI's command is `jubarteai` (unknown), not login.
    expect(toolGuardDecision(camel("jubarteai{,} login"))).toEqual({});
  });

  it("the scan budget counts a fixed cost per value and per JSON parse attempt, not only characters (review R-S1, round 11)", () => {
    const argv = (items: string[]): string => JSON.stringify({ tool_name: "bash", tool_input: { command: "echo", args: items } });
    // A thousand empty strings: a few characters, but a thousand values.
    expect(toolGuardDecision(argv(Array.from({ length: 1000 }, () => "")))).toEqual({});
    expect(toolGuardDecision(argv(Array.from({ length: 1000 }, () => "")), false, 32_000)).toEqual(TOO_LARGE_OUT);
    // A hundred strings each: the same characters, but "[]]" is a parse attempt and "abc" is not.
    expect(toolGuardDecision(argv(Array.from({ length: 100 }, () => "abc")), false, 20_000)).toEqual({});
    expect(toolGuardDecision(argv(Array.from({ length: 100 }, () => "[]]")), false, 20_000)).toEqual(TOO_LARGE_OUT);
  });

  it("the scan budget and depth: a shell call it can't scan whole is denied, a non-shell one is left alone", () => {
    const nested = JSON.stringify([JSON.stringify(["echo hi"])]);
    expect(toolGuardDecision(camel(nested))).toEqual({});
    expect(toolGuardDecision(camel(nested), false, 40)).toEqual(TOO_LARGE_OUT);
    let deep: unknown = "echo hi";
    for (let level = 0; level < 25; level += 1) deep = [deep];
    expect(toolGuardDecision(JSON.stringify({ toolName: "bash", toolArgs: { command: "echo hi", extra: deep } }))).toEqual(TOO_LARGE_OUT);
    expect(toolGuardDecision(JSON.stringify({ toolName: "view", toolArgs: { path: "x", extra: deep } }))).toEqual({});
  });

  it("a non-shell tool that only mentions a person command (an edit, a new file, a view)", () => {
    expect(toolGuardDecision(JSON.stringify({ toolName: "edit", toolArgs: { path: "README.md", old_str: "a", new_str: "run jubarteai login" } }))).toEqual({});
    expect(toolGuardDecision(JSON.stringify({ toolName: "create", toolArgs: { path: "setup.sh", file_text: "jubarteai init --yes" } }))).toEqual({});
    expect(toolGuardDecision(snake("jubarteai login", "Write").replace('"command"', '"content"'))).toEqual({});
  });

  it("anything it can't read: empty, not JSON, not an object, no tool", () => {
    for (const raw of ["", "not json", "[]", "null", "42", JSON.stringify({ toolArgs: { path: "x" } })]) {
      expect(toolGuardDecision(raw), raw).toEqual({});
    }
    expect(toolGuardDecision("jubarteai login")).toEqual({});
  });

  it("never answers allow, for any line", () => {
    const lines = [...agentLines, ...PERSON_COMMANDS.flatMap((command) => PERSON_FORMS.map((form) => render(form, command)))];
    for (const line of lines) {
      const out = toolGuardDecision(camel(line));
      expect(Object.keys(out).length === 0 || (out as { permissionDecision?: string }).permissionDecision === "deny", line).toBe(true);
    }
  });
});

describe("personCommandIn and the matcher", () => {
  it("names the command it found, lowercased", () => {
    expect(personCommandIn("JUBARTEAI LOGIN")).toBe("login");
    expect(personCommandIn("jubarteai update --check")).toBe("update");
    expect(personCommandIn("jubarteai inbox")).toBeNull();
  });

  it("the entry's matcher names the Copilot runtime's shell tools and is a valid anchored regex", () => {
    const re = new RegExp(`^(?:${SHELL_TOOL_MATCHER})$`);
    expect(re.test("bash")).toBe(true);
    expect(re.test("powershell")).toBe(true);
    expect(re.test("edit")).toBe(false);
  });
});
