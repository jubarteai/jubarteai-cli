// A linked worktree shares its main checkout's binding: `link` in main, then the hook and `status` run from the worktree
// through the built binary, the way an agent's worktree session does.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { IS_WINDOWS, createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const posix = IS_WINDOWS ? test.skip : test;
const AGENT_LINE = /Your JubarteAI agent_id is ([0-9a-f-]{36})/;

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
  expect((await box.signInWithKey(fake)).code).toBe(0);
});

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
}

function worktree(origin: string | null): string {
  git(box.repo, "commit", "--allow-empty", "-q", "-m", "init");
  if (origin !== null) git(box.repo, "remote", "add", "origin", origin);
  const tree = join(box.root, "4f6a6395-0000-4000-8000-feature");
  git(box.repo, "worktree", "add", "-q", tree);
  return realpathSync(tree);
}

describe("linked worktrees through the binary", () => {
  posix("the hook in a worktree connects under the main checkout's binding and names the repo from origin", async () => {
    expect((await box.run(["link"])).code).toBe(0);
    const tree = worktree("git@github.com:org/JubarteAI.git");
    const input = JSON.stringify({ session_id: "wt-1", cwd: tree, source: "startup" });
    const started = await box.run(["hook", "session-start", "--harness", "claude-code"], { stdin: input, cwd: tree });
    expect(started.code).toBe(0);
    expect(started.stderr).toBe("");
    expect(AGENT_LINE.exec(started.stdout)?.[1]).toBeDefined();
    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]?.description).toBe("claude-code on jubarteai");
    expect(fake.agents[0]?.seat_id).toBe(fake.identity.seat_id);
  });

  posix("status in the worktree names where the binding came from", async () => {
    expect((await box.run(["link"])).code).toBe(0);
    const tree = worktree(null);
    const text = await box.run(["status"], { cwd: tree });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("from the main checkout");
    const json = JSON.parse((await box.run(["status", "--json"], { cwd: tree })).stdout) as { binding: { inherited_from?: string } };
    expect(json.binding.inherited_from).toBe(tree);
  });

  posix("link run in the worktree writes the main checkout's binding", async () => {
    const tree = worktree(null);
    expect((await box.run(["link"], { cwd: tree })).code).toBe(0);
    expect(box.read(join(box.repo, ".jubarteai", "config.json"))).toContain(fake.identity.company.slug);
    const again = await box.run(["status", "--json"], { cwd: tree });
    expect((JSON.parse(again.stdout) as { binding: { found: boolean } }).binding.found).toBe(true);
  });

  posix("a worktree of an unbound repo stays silent", async () => {
    const tree = worktree(null);
    const input = JSON.stringify({ session_id: "wt-2", cwd: tree, source: "startup" });
    const started = await box.run(["hook", "session-start", "--harness", "claude-code"], { stdin: input, cwd: tree });
    expect(started.code).toBe(0);
    expect(started.stdout).toBe("");
    expect(fake.agents).toHaveLength(0);
  });
});
