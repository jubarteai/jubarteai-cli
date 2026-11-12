import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jsonRemovalStep, removeFlatHooks, removeFromStringList, removeNestedHooks, sameRule } from "./uninstall.js";
import { removeTomlKey, TomlConflictError } from "../safe-edit/toml-edit.js";
import type { PlanStep } from "../safe-edit/plan.js";

const EVENTS = [
  { name: "SessionStart", arg: "session-start" },
  { name: "SessionEnd", arg: "session-end" },
];
const ours = (arg: string) => ({ type: "command", command: `"/opt/node" "/opt/jubarteai.js" hook ${arg} --harness claude-code`, timeout: 5 });

describe("removeNestedHooks", () => {
  it("removes only our entries, drops the groups, events and hooks key it empties, and keeps the rest", () => {
    const other = { type: "command", command: "echo other" };
    const doc = {
      hooks: {
        SessionStart: [{ hooks: [ours("session-start")] }, { hooks: [other, ours("session-start")] }],
        SessionEnd: [{ hooks: [ours("session-end")] }],
        Stop: [{ hooks: [other] }],
      },
    };
    expect(removeNestedHooks(doc, EVENTS, "claude-code")).toBe(true);
    expect(doc).toEqual({ hooks: { SessionStart: [{ hooks: [other] }], Stop: [{ hooks: [other] }] } });
    expect(removeNestedHooks(doc, EVENTS, "claude-code")).toBe(false);
  });

  it("deletes the hooks key when nothing else is left, recognises a bare older entry, and ignores another harness's", () => {
    const doc = { hooks: { SessionStart: [{ hooks: [{ command: "jubarteai hook session-start" }, { command: "x hook session-start --harness codex" }] }] } };
    expect(removeNestedHooks(doc, EVENTS, "claude-code")).toBe(true);
    expect(doc.hooks.SessionStart[0]?.hooks).toEqual([{ command: "x hook session-start --harness codex" }]);
    const empty = { hooks: { SessionEnd: [{ hooks: [ours("session-end")] }] }, keep: 1 };
    removeNestedHooks(empty, EVENTS, "claude-code");
    expect(empty).toEqual({ keep: 1 });
  });

  it("does nothing for documents without hooks", () => {
    expect(removeNestedHooks({}, EVENTS, "claude-code")).toBe(false);
    expect(removeNestedHooks({ hooks: "x" }, EVENTS, "claude-code")).toBe(false);
  });
});

describe("removeFlatHooks", () => {
  it("removes our flat entries and tidies up", () => {
    const keep = { command: "other hook" };
    const doc = { version: 1, hooks: { sessionStart: [{ command: "jubarteai hook session-start --harness cursor" }, keep], sessionEnd: [{ command: "/x/jubarteai hook session-end --harness cursor" }] } };
    expect(removeFlatHooks(doc, [{ key: "sessionStart", arg: "session-start" }, { key: "sessionEnd", arg: "session-end" }], "cursor")).toBe(true);
    expect(doc).toEqual({ version: 1, hooks: { sessionStart: [keep] } });
  });
});

describe("removeFromStringList", () => {
  it("removes the rules, treating Bash(x *) and Bash(x:*) as the same, and prunes empty containers up the path", () => {
    const doc = { permissions: { allow: ["Bash(jubarteai:*)", "Bash(git status)"], ask: ["Bash(jubarteai init)"] } };
    expect(removeFromStringList(doc, ["permissions", "allow"], ["Bash(jubarteai *)"], sameRule)).toBe(true);
    expect(doc.permissions.allow).toEqual(["Bash(git status)"]);
    expect(removeFromStringList(doc, ["permissions", "ask"], ["Bash(jubarteai init)"], sameRule)).toBe(true);
    expect(doc).toEqual({ permissions: { allow: ["Bash(git status)"] } });
    expect(removeFromStringList(doc, ["permissions", "allow"], ["Bash(git status)"], sameRule)).toBe(true);
    expect(doc).toEqual({});
    expect(removeFromStringList(doc, ["permissions", "allow"], ["x"], sameRule)).toBe(false);
  });
});

describe("removeTomlKey", () => {
  const text = `model = "x"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a"]\nnetwork_access = true # on\n`;
  it("removes a key set to exactly the value, keeping the rest", () => {
    const out = removeTomlKey(text, "sandbox_workspace_write", "network_access", true);
    expect(out.changed).toBe(true);
    expect(out.text).toBe(`model = "x"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a"]\n`);
  });
  it("removes the table when the key was its only content, and leaves a key the person set otherwise", () => {
    const only = `[sandbox_workspace_write]\nnetwork_access = true\n`;
    expect(removeTomlKey(only, "sandbox_workspace_write", "network_access", true).text).toBe("");
    expect(removeTomlKey(`[sandbox_workspace_write]\nnetwork_access = false\n`, "sandbox_workspace_write", "network_access", true).changed).toBe(false);
    expect(removeTomlKey(`model = "x"\n`, "sandbox_workspace_write", "network_access", true).changed).toBe(false);
  });
  it("refuses a table defined inline", () => {
    expect(() => removeTomlKey(`sandbox_workspace_write = { network_access = true }\n`, "sandbox_workspace_write", "network_access", true)).toThrow(TomlConflictError);
  });
});

describe("jsonRemovalStep", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "jba-removal-")));
    // The file guards compare against the real home folder: make the sandbox it.
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(dir, { recursive: true, force: true });
  });
  const spec = (file: string) => ({
    harness: "claude-code" as const,
    id: "claude-code:uninstall-x",
    label: "Remove x",
    file,
    home: dir,
    preview: "p",
    byHand: ["the x entry"],
    edit: (doc: Record<string, unknown>) => removeFromStringList(doc, ["list"], ["x"]),
  });

  it("is null for a missing file or a file with none of ours", () => {
    expect(jsonRemovalStep(spec(join(dir, "none.json")))).toBeNull();
    writeFileSync(join(dir, "a.json"), JSON.stringify({ list: ["y"] }));
    expect(jsonRemovalStep(spec(join(dir, "a.json")))).toBeNull();
  });

  it("is a sensitive step that edits only that entry; a second run is already configured", async () => {
    const file = join(dir, "b.json");
    writeFileSync(file, JSON.stringify({ list: ["x", "y"], other: 1 }));
    const step = jsonRemovalStep(spec(file)) as PlanStep;
    expect(step.sensitive).toBe(true);
    const first = await step.apply();
    expect(first, JSON.stringify(first)).toMatchObject({ status: "configured" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ list: ["y"], other: 1 });
    expect(await step.apply()).toMatchObject({ status: "already configured" });
  });

  it("is printed instructions for a file with comments that mentions jubarteai, and nothing when it doesn't", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, `// jubarteai\n{"list":["x"]}`);
    expect(jsonRemovalStep(spec(file))).toMatchObject({ kind: "manual", harness: "claude-code" });
    writeFileSync(file, `// notes\n{"list":["x"]}`);
    expect(jsonRemovalStep(spec(file))).toBeNull();
  });
});
