import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBinding } from "../binding/binding.js";
import { routeWith } from "../cli/router.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { skillsCommand } from "./skills.js";

const ENV_NAMES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"] as const;
const itPosix = process.platform === "win32" ? it.skip : it;

let sandbox: string;
let repo: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jba-skills-cmd-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.TMPDIR = join(sandbox, "tmp");
  mkdirSync(process.env.TMPDIR);
  for (const name of ["XDG_CONFIG_HOME", "JUBARTEAI_TOKEN", "JUBARTEAI_URL"]) delete process.env[name];
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  writeBinding(repo, { workspace: { id: "company-acme", slug: "acme" }, email: "a@example.com", shared: false });
  resetEnvTokenForTests();
});

afterEach(() => {
  resetEnvTokenForTests();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write: (chunk: Buffer, _e, cb) => ((out += chunk.toString("utf8")), cb()) });
  const stderr = new Writable({ write: (chunk: Buffer, _e, cb) => ((err += chunk.toString("utf8")), cb()) });
  const code = await routeWith([skillsCommand], argv, { stdout, stderr, stdin: new PassThrough(), cwd: repo });
  return { code, out, err };
}

describe("skills status", () => {
  it("lists the synced targets and no skipped ones in a plain repo", async () => {
    const result = await run(["skills", "status"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out).result;
    expect(body.targets).toEqual([".agents/skills", ".claude/skills"]);
    expect(body.skipped_targets).toEqual([]);
  });

  itPosix("names a symlinked skills folder as skipped", async () => {
    const outside = join(sandbox, "shared-skills");
    mkdirSync(outside);
    mkdirSync(join(repo, ".claude"));
    symlinkSync(outside, join(repo, ".claude/skills"));
    const result = await run(["skills", "status"]);
    const body = JSON.parse(result.out).result;
    expect(body.targets).toEqual([".agents/skills"]);
    expect(body.skipped_targets).toEqual([{ target: ".claude/skills", reason: "symlink" }]);
  });
});
