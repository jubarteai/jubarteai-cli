// The Copilot preToolUse guard through the built binary, the way ~/.copilot/hooks/jubarteai.json runs it (spec §6.3,
// I6): a payload on stdin, one JSON object on stdout, exit 0. The unit tests inject a small read cap; this runs the
// production one, GUARD_INPUT_MAX_BYTES, in a real process, and checks the guard needs no login, no binding and no
// network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GUARD_INPUT_MAX_BYTES } from "../../src/constants.js";
import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fake: FakeServer;
let box: Sandbox;

beforeEach(async () => {
  fake = await startFakeServer();
  box = createSandbox();
});

afterEach(async () => {
  await fake.close();
  box.cleanup();
});

/** Copilot CLI's payload: camelCase, `toolArgs` the JSON string the runtime sends. */
const copilot = (command: string): string => JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/r", toolName: "bash", toolArgs: JSON.stringify({ command, description: "x" }) });
/** VS Code's: snake_case, the tool input an object. */
const vscode = (command: string): string => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "run_in_terminal", tool_input: { command } });

const denyFor = (command: string) => ({ permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(new RegExp(`^jubarteai ${command} changes the saved account`)) });
const TOO_LARGE = { permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^This tool call is too large/) };

async function guard(stdin: string, opts: { cwd?: string } = {}): Promise<unknown> {
  const result = await box.run(["hook", "pre-tool-use", "--harness", "vscode"], { stdin, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

describe("jubarteai hook pre-tool-use, a real process", () => {
  test("denies a person command in either harness's shape, and answers {} for an agent command, with nobody signed in", async () => {
    expect(await guard(copilot('jubarteai inbox && jubarteai "login" --with-token'))).toEqual(denyFor("login"));
    expect(await guard(vscode("npm exec jubarteai --loglevel silent update"))).toEqual(denyFor("update"));
    expect(await guard(copilot("jubarteai search-knowledge --query x --agent 11111111-1111-4111-8111-111111111111"))).toEqual({});
    expect(await guard("not json")).toEqual({});
    expect(await guard("")).toEqual({});
  });

  test("is the same outside a git repository, and makes no request even when a login exists", async () => {
    expect((await box.signInWithKey(fake)).code).toBe(0);
    const before = fake.requests.length;
    expect(await guard(copilot("jubarteai logout"), { cwd: box.outside })).toEqual(denyFor("logout"));
    expect(await guard(copilot("jubarteai link --share-binding"))).toEqual(denyFor("link"));
    expect(fake.requests.length).toBe(before);
  });

  test("the production read cap: a payload at the cap is read whole and the scan finds the command; one byte over is the too-large deny", async () => {
    const tail = "; jubarteai init";
    // VS Code's shape at exactly GUARD_INPUT_MAX_BYTES: read whole (no overflow), scanned, denied by the scan.
    const vsAt = (pad: number): string => vscode(`echo ${"x".repeat(pad)}${tail}`);
    const atCap = vsAt(GUARD_INPUT_MAX_BYTES - Buffer.byteLength(vsAt(0)));
    expect(Buffer.byteLength(atCap)).toBe(GUARD_INPUT_MAX_BYTES);
    expect(await guard(atCap)).toEqual(denyFor("init"));

    // Copilot's shape charges its toolArgs string and the command inside it, each nearly the whole payload, against a
    // budget of twice the cap, so the fixed per-value costs tip the last ~230 bytes below the cap into the too-large
    // deny (it errs toward a deny). 1 KiB under the cap is scanned.
    const cpAt = (pad: number): string => copilot(`echo ${"x".repeat(pad)}${tail}`);
    const nearCap = cpAt(GUARD_INPUT_MAX_BYTES - 1024 - Buffer.byteLength(cpAt(0)));
    expect(Buffer.byteLength(nearCap)).toBe(GUARD_INPUT_MAX_BYTES - 1024);
    expect(await guard(nearCap)).toEqual(denyFor("init"));

    // One byte over the cap: the guard stops reading and refuses, whatever the payload holds (here, nothing to refuse).
    // VS Code's shape is the read cap's proof (its control just under the cap, below, is no decision). Copilot's shape
    // is refused here too, but by the cap or the scan budget, whichever comes first, so it doesn't prove the cap alone.
    for (const wrap of [vscode, copilot]) {
      const innocent = wrap(`echo ${"x".repeat(GUARD_INPUT_MAX_BYTES - Buffer.byteLength(wrap("echo ")) + 1)}`);
      expect(Buffer.byteLength(innocent)).toBe(GUARD_INPUT_MAX_BYTES + 1);
      expect(await guard(innocent)).toEqual(TOO_LARGE);
    }
    // The same innocent VS Code command just under the cap is no decision: the refusal above is the read cap's.
    const under = vscode(`echo ${"x".repeat(GUARD_INPUT_MAX_BYTES - Buffer.byteLength(vscode("echo ")) - 1)}`);
    expect(await guard(under)).toEqual({});
  });
});
