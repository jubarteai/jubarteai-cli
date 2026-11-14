import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBinding } from "../binding/binding.js";
import { routeWith } from "../cli/router.js";
import { resetEnvTokenForTests } from "../process-env.js";
import { readState, statePath } from "../skills/state.js";
import { readMarker } from "../skills/writer.js";
import { AGENT_A, FAKE_KEY, deadOrigin, startFakeServer } from "../../test/helpers/fake-mcp-server.js";
import type { FakeServer } from "../../test/helpers/fake-mcp-server.js";
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

// The foreground sync through the real command, against a fake MCP server (list_skills / get_skill) and a
// loopback file server standing in for the signed Storage URLs (http is accepted only because both are loopback).
describe("skills sync (foreground)", () => {
  const SKILL_MD = Buffer.from("---\nname: alpha\ndescription: d\n---\nbody\n");
  const DIGEST = "a".repeat(64);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const SKIP_LINE = ".claude/skills is a symlink, so company skills are not synced there. Replace the link with a real folder to sync them.";

  let mcp: FakeServer;
  let filesOrigin: string;
  const closers: Array<() => Promise<void>> = [];

  async function startServers(listFails = false): Promise<void> {
    const files = http.createServer((req, res) => {
      if (req.url === "/alpha/SKILL.md") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(SKILL_MD);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
    filesOrigin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
    closers.push(() => new Promise<void>((resolve) => files.close(() => resolve())));
    mcp = await startFakeServer({
      tool: (name) => {
        if (listFails) return { messages: [], error: "Something went wrong on our side." };
        if (name === "list_skills") return { messages: [], result: { skills_revision: 4, skills: [{ name: "alpha", revision_id: "rev-alpha", digest: DIGEST }] } };
        return {
          messages: [],
          result: {
            name: "alpha",
            revision_id: "rev-alpha",
            digest: DIGEST,
            files: [{ path: "SKILL.md", size: SKILL_MD.length, sha256: sha(SKILL_MD), executable: false, url: `${filesOrigin}/alpha/SKILL.md` }],
          },
        };
      },
    });
    const server = mcp;
    closers.push(() => server.close());
    useServer(mcp.origin);
  }

  function useServer(origin: string): void {
    process.env.JUBARTEAI_URL = origin;
    process.env.JUBARTEAI_TOKEN = FAKE_KEY;
    resetEnvTokenForTests();
  }

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  itPosix("prints the skip line on stderr, lists skipped_targets, and syncs the folder that is not a link", async () => {
    await startServers();
    const outside = join(sandbox, "shared-skills");
    mkdirSync(outside);
    mkdirSync(join(repo, ".claude"));
    symlinkSync(outside, join(repo, ".claude/skills"));

    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.code).toBe(0);
    expect(result.err).toBe(`${SKIP_LINE}\n`);
    const body = JSON.parse(result.out).result;
    expect(body).toMatchObject({ status: "synced", added: ["alpha"], skills: 1, revision: 4, skipped_targets: [".claude/skills"] });
    expect(readFileSync(join(repo, ".agents/skills/alpha/SKILL.md"))).toEqual(SKILL_MD);
    expect(readMarker(join(repo, ".agents/skills/alpha"))).toMatchObject({ name: "alpha", digest: DIGEST, workspace_id: "company-acme" });
    expect(readdirSync(outside)).toEqual([]);
  });

  itPosix("names every skipped folder in one line", async () => {
    await startServers();
    for (const dir of [".claude", ".agents"]) {
      const outside = join(sandbox, `shared-${dir.slice(1)}`);
      mkdirSync(outside);
      symlinkSync(outside, join(repo, dir));
    }
    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.err).toBe(".agents/skills, .claude/skills are symlinks, so company skills are not synced there. Replace the link with a real folder to sync them.\n");
    expect(JSON.parse(result.out).result.skipped_targets).toEqual([".agents/skills", ".claude/skills"]);
  });

  it("a plain repo: both folders are written, no skipped_targets key and nothing on stderr", async () => {
    await startServers();
    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const body = JSON.parse(result.out).result;
    expect(body).not.toHaveProperty("skipped_targets");
    expect(body.added).toEqual(["alpha"]);
    for (const t of [".claude/skills", ".agents/skills"]) expect(readFileSync(join(repo, t, "alpha/SKILL.md"))).toEqual(SKILL_MD);
    expect(mcp.toolCalls().map((c) => c.name)).toEqual(["list_skills", "get_skill"]);
    expect(mcp.toolCalls()[1]?.arguments).toMatchObject({ agent_id: AGENT_A, name: "alpha", manifest: true });
    expect(body.notice).toMatch(/New company skills folder created/);
  });

  it("--quiet prints nothing on success", async () => {
    await startServers();
    const result = await run(["skills", "sync", "--quiet", "--agent", AGENT_A]);
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(repo, ".claude/skills/alpha/SKILL.md"))).toBe(true);
  });

  itPosix("--background prints nothing, not even the skip line", async () => {
    await startServers();
    const outside = join(sandbox, "shared-skills");
    mkdirSync(outside);
    mkdirSync(join(repo, ".claude"));
    symlinkSync(outside, join(repo, ".claude/skills"));
    const result = await run(["skills", "sync", "--background", "--agent", AGENT_A]);
    expect(result).toEqual({ code: 0, out: "", err: "" });
  });

  it("a server error exits 4 with the retry line and keeps what is on disk", async () => {
    await startServers();
    expect((await run(["skills", "sync", "--quiet", "--agent", AGENT_A])).code).toBe(0);
    await startServers(true);
    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.code).toBe(4);
    expect(result.err).toContain("Company skills couldn't be synced right now. Nothing was removed; try again later.");
    expect(JSON.parse(result.out).result.status).toBe("failed");
    expect(readMarker(join(repo, ".claude/skills/alpha"))).not.toBeNull();
  });

  it("an unreachable server exits 4 too", async () => {
    useServer(await deadOrigin());
    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.code).toBe(4);
    expect(result.err).toContain("Company skills couldn't be synced right now.");
  });

  it("refuses outside a bound repository", async () => {
    await startServers();
    rmSync(join(repo, ".jubarteai"), { recursive: true, force: true });
    const result = await run(["skills", "sync", "--agent", AGENT_A]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("This folder isn't in a repository bound to a workspace. Run: jubarteai link");
    expect(mcp.requests).toHaveLength(0);
  });
});

describe("skills clean", () => {
  it("--yes removes only the synced folders, the exclude block and the sync state", async () => {
    const SKILL_MD = Buffer.from("---\nname: alpha\ndescription: d\n---\nbody\n");
    const files = http.createServer((_req, res) => res.end(SKILL_MD));
    await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
    const filesOrigin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
    const mcp = await startFakeServer({
      tool: (name) =>
        name === "list_skills"
          ? { messages: [], result: { skills_revision: 1, skills: [{ name: "alpha", revision_id: "r", digest: "b".repeat(64) }] } }
          : {
              messages: [],
              result: {
                name: "alpha",
                revision_id: "r",
                digest: "b".repeat(64),
                files: [{ path: "SKILL.md", size: SKILL_MD.length, sha256: createHash("sha256").update(SKILL_MD).digest("hex"), executable: false, url: `${filesOrigin}/x` }],
              },
            },
    });
    try {
      process.env.JUBARTEAI_URL = mcp.origin;
      process.env.JUBARTEAI_TOKEN = FAKE_KEY;
      resetEnvTokenForTests();
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude/skills/mine"), { recursive: true });
      writeFileSync(join(repo, ".claude/skills/mine/SKILL.md"), "mine");
      expect((await run(["skills", "sync", "--quiet", "--agent", AGENT_A])).code).toBe(0);
      expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain("/.claude/skills/alpha/");
      expect(existsSync(statePath(repo))).toBe(true);

      const result = await run(["skills", "clean", "--yes"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).result.removed.sort()).toEqual([".agents/skills/alpha", ".claude/skills/alpha"]);
      expect(existsSync(join(repo, ".claude/skills/alpha"))).toBe(false);
      expect(existsSync(join(repo, ".agents/skills/alpha"))).toBe(false);
      expect(readFileSync(join(repo, ".claude/skills/mine/SKILL.md"), "utf8")).toBe("mine");
      expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).not.toContain("alpha");
      expect(existsSync(statePath(repo))).toBe(false);
      expect(readState(repo, mcp.origin).revision).toBeNull();
    } finally {
      await mcp.close();
      await new Promise<void>((resolve) => files.close(() => resolve()));
    }
  });

  it("with nothing synced it answers an empty list and touches no folder", async () => {
    mkdirSync(join(repo, ".claude/skills/mine"), { recursive: true });
    const result = await run(["skills", "clean"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result).toEqual({ removed: [] });
    expect(existsSync(join(repo, ".claude/skills/mine"))).toBe(true);
  });
});

describe("skills usage", () => {
  it.each([[["skills"]], [["skills", "nope"]], [["skills", "sync", "extra"]]])("%j is a usage error", async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage: jubarteai skills <sync|status|clean>");
  });
});
