// A stand-in for the external programs `jubarteai init` and `update` start (npx, npm, claude, codex).
// It appends one JSON line per call to $STUB_LOG (argv, cwd and the whole environment, so a test can
// prove the key never reaches a child process) and answers the few questions the CLI asks.
// Usage (from the wrapper scripts the harness writes): node stub.mjs <name> [args...]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const [name, ...argv] = process.argv.slice(2);

const log = process.env.STUB_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ name, argv, cwd: process.cwd(), env: process.env })}\n`);

// Where `npx skills add -a <agent>` puts the skill (project scope: under cwd; -g: under the home folder).
const SKILL_DIRS = {
  "claude-code": ".claude/skills",
  windsurf: ".windsurf/skills",
};

function skillsAdd(args) {
  const global = args.includes("-g");
  const base = global ? homedir() : process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-a") continue;
    const dir = join(base, SKILL_DIRS[args[i + 1]] ?? ".agents/skills", "jubarteai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: jubarteai\n---\nstub skill\n");
  }
}

switch (name) {
  case "npx":
    if (argv.some((a) => a.startsWith("skills@")) && argv.includes("add")) skillsAdd(argv);
    break;
  case "npm":
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "registry") process.stdout.write("https://registry.npmjs.org/\n");
    break;
  case "claude":
    if (argv.includes("--version")) process.stdout.write("2.1.300 (Claude Code)\n");
    else if (argv[0] === "plugin" && argv[1] === "list") process.stdout.write("[]\n");
    break;
  case "codex":
    if (argv.includes("--version")) process.stdout.write("codex-cli 0.170.0\n");
    break;
  default:
    break;
}
