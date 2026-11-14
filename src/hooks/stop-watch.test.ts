import { describe, expect, it } from "vitest";

import { hasRunningWatcher, isWatcherTask, parseBackgroundTasks, stopReminderOutput } from "./stop-watch.js";

const AGENT = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const task = (command: string, status: string | null = "running") => ({ type: "shell", status, command });

describe("parseBackgroundTasks", () => {
  it("keeps type, status and command, and drops everything else", () => {
    expect(parseBackgroundTasks([{ id: "x", type: "shell", status: "running", description: "d", command: "sleep 1", extra: { a: 1 } }])).toEqual([
      { type: "shell", status: "running", command: "sleep 1" },
    ]);
  });

  it.each([[undefined], [null], ["tasks"], [{}], [5]])("reads %j as no tasks", (value) => {
    expect(parseBackgroundTasks(value)).toEqual([]);
  });

  it("skips entries without a command string and entries past the bounds", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ type: "shell", status: "running", command: `c${i}` }));
    expect(parseBackgroundTasks([null, 7, "x", { type: "shell" }, { command: 5 }, ...many])).toHaveLength(45);
    expect(parseBackgroundTasks([{ command: "x".repeat(1001) }, { command: "x".repeat(1000) }])).toHaveLength(1);
  });

  it("takes a missing type or status as unknown, not as a match", () => {
    expect(parseBackgroundTasks([{ command: "jubarteai inbox --watch" }])).toEqual([{ type: null, status: null, command: "jubarteai inbox --watch" }]);
  });
});

describe("isWatcherTask", () => {
  it.each([
    ["the documented command", `jubarteai inbox --agent ${AGENT} --watch --session`],
    ["without --session", `jubarteai inbox --agent ${AGENT} --watch`],
    ["flags in another order", `jubarteai inbox --watch --minutes 30 --agent ${AGENT}`],
    ["no --agent (the session's own agent)", "jubarteai inbox --watch --session"],
    ["--agent=<id>", `jubarteai inbox --agent=${AGENT} --watch`],
    ["a node-run bin", `"/usr/local/bin/node" "/opt/lib/jubarteai/bin/jubarteai.js" inbox --watch --session`],
    ["a Windows shim", `jubarteai.cmd inbox --agent ${AGENT} --watch`],
    ["an unknown status", `jubarteai inbox --agent ${AGENT} --watch`],
  ])("matches %s", (_label, command) => {
    expect(isWatcherTask(task(command, _label === "an unknown status" ? null : "running"), AGENT)).toBe(true);
  });

  it.each([
    ["a plain inbox check", `jubarteai inbox --agent ${AGENT}`],
    ["a wait", `jubarteai inbox --agent ${AGENT} --wait 30`],
    ["another command", "npm run dev"],
    ["a watch of another tool", "tail -f log --watch"],
    ["another agent's watcher", `jubarteai inbox --agent ${OTHER} --watch --session`],
    ["--watch in a later command of the line", `jubarteai inbox --agent ${AGENT}; echo --watch`],
    ["a pipeline that only mentions it", `echo jubarteai | grep inbox && ls --watch`],
  ])("does not match %s", (_label, command) => {
    expect(isWatcherTask(task(command), AGENT)).toBe(false);
  });

  it("does not match a task that is no longer running", () => {
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      expect(isWatcherTask(task(`jubarteai inbox --agent ${AGENT} --watch --session`, status), AGENT)).toBe(false);
    }
  });

  it("compares agent ids case-insensitively", () => {
    expect(isWatcherTask(task(`jubarteai inbox --agent ${AGENT.toUpperCase()} --watch`), AGENT)).toBe(true);
  });
});

describe("hasRunningWatcher", () => {
  it("is true when any listed task is the watcher", () => {
    expect(hasRunningWatcher([task("sleep 5"), task(`jubarteai inbox --agent ${AGENT} --watch --session`)], AGENT)).toBe(true);
    expect(hasRunningWatcher([task("sleep 5")], AGENT)).toBe(false);
    expect(hasRunningWatcher([], AGENT)).toBe(false);
  });
});

describe("stopReminderOutput", () => {
  it("is one JSON line that blocks the stop with a reason naming the agent and the command", () => {
    const out = stopReminderOutput(AGENT);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd().includes("\n")).toBe(false);
    const body = JSON.parse(out) as { decision: string; reason: string };
    expect(body.decision).toBe("block");
    expect(body.reason).toContain(`jubarteai inbox --agent ${AGENT} --watch --session`);
    expect(body.reason).toContain("run_in_background: true");
  });

  it("prints nothing for an id that isn't an agent id (nothing from a file or a peer is ever put in the line)", () => {
    for (const bad of ["", "x", "$(touch /tmp/x)", `${AGENT}; rm -rf /`, "../../etc"]) expect(stopReminderOutput(bad)).toBe("");
  });
});
