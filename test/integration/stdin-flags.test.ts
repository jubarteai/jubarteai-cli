// A tool flag's value from standard input or a file, through the built binary (spec §5.2: `--<flag>-file <path|->`,
// `--json -`, `--metadata -`). The unit tests inject the stdin reader; this drives the production one, which reads
// file descriptor 0 synchronously, with a real pipe — and checks that a refused value never reaches the server.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ARG_INPUT_MAX_BYTES } from "../../src/constants.js";
import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";
import { createSandbox } from "./harness.js";
import type { Sandbox } from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const AGENT = "aaaaaaaa-0000-4000-8000-00000000000a";
const CREATE = ["create-knowledge", "--agent", AGENT, "--title", "T", "--branches", "main", "--repositories", "acme-app"];

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

describe("a value from standard input", () => {
  test("--description-file - sends stdin's text exactly: lines, non-ASCII and shell-looking text untouched", async () => {
    const body = "First line\n\nSecond — ção ☃ `code` $(not run) \"quoted\"\r\nlast line without newline";
    const result = await box.run([...CREATE, "--description-file", "-"], { stdin: body });
    expect(result.code, result.stderr).toBe(0);
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "create_knowledge", arguments: { title: "T", description: body } });
  });

  test("--metadata - parses stdin as JSON; call --json - takes the whole argument object from stdin", async () => {
    const metadata = await box.run([...CREATE, "--description", "D", "--metadata", "-"], { stdin: '{"status":"in-progress"}\n' });
    expect(metadata.code, metadata.stderr).toBe(0);
    expect(fake.toolCalls().at(-1)?.arguments["metadata"]).toEqual({ status: "in-progress" });

    const call = await box.run(["call", "some_future_tool", "--json", "-"], { stdin: '{"x":[1,2],"y":"ção"}' });
    expect(call.code, call.stderr).toBe(0);
    expect(fake.toolCalls().at(-1)).toMatchObject({ name: "some_future_tool", arguments: { x: [1, 2], y: "ção" } });
  });

  test("an empty stdin is an empty value, sent as is (the server rules on it), not a hang", async () => {
    const result = await box.run([...CREATE, "--description-file", "-"], { stdin: "" });
    expect(result.code, result.stderr).toBe(0);
    expect(fake.toolCalls()).toHaveLength(1);
    expect(fake.toolCalls()[0]?.arguments["description"]).toBe("");
  });

  test("exactly the size limit is read whole; one byte more is refused before any request (exit 2)", async () => {
    const atLimit = "x".repeat(ARG_INPUT_MAX_BYTES);
    const ok = await box.run([...CREATE, "--description-file", "-"], { stdin: atLimit });
    expect(ok.code, ok.stderr).toBe(0);
    expect((fake.toolCalls().at(-1)?.arguments["description"] as string).length).toBe(ARG_INPUT_MAX_BYTES);

    const calls = fake.toolCalls().length;
    const over = await box.run([...CREATE, "--description-file", "-"], { stdin: `${atLimit}y` });
    expect(over.code).toBe(2);
    expect(over.stderr).toContain("Standard input is too large.");
    expect(fake.toolCalls()).toHaveLength(calls);
  });

  test("an oversized stdin that never ends is refused as soon as it passes the limit, not read to the end (exit 2)", async () => {
    // The pipe stays open: a reader that waits for end-of-file before checking the size would never answer.
    const running = box.start([...CREATE, "--description-file", "-"]);
    running.write("x".repeat(2 * ARG_INPUT_MAX_BYTES));
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      running.exit,
      new Promise<"still reading">((resolve) => {
        timer = setTimeout(() => resolve("still reading"), 20_000);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "still reading") running.kill();
    expect(outcome).not.toBe("still reading");
    expect(outcome).toMatchObject({ code: 2 });
    expect(running.stderr()).toContain("Standard input is too large.");
    expect(fake.toolCalls()).toHaveLength(0);
  });

  test("stdin that is not UTF-8 is refused (exit 2) and nothing is sent", async () => {
    const result = await box.run([...CREATE, "--description-file", "-"], { stdin: Uint8Array.from([0x6f, 0x6b, 0xff, 0xfe, 0x0a]) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Standard input is not valid UTF-8 text.");
    expect(fake.toolCalls()).toHaveLength(0);
  });

  test("stdin feeds one flag only: a second `-` is a usage error and nothing is sent", async () => {
    const result = await box.run([...CREATE, "--description-file", "-", "--metadata", "-"], { stdin: '{"status":"done"}' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Standard input can be read for only one flag.");
    expect(fake.toolCalls()).toHaveLength(0);
  });
});

describe("a value from a file", () => {
  test("--description-file <path> sends the file's text; a folder, a missing file or one over the limit is exit 2 with no request", async () => {
    const dir = join(box.root, "inputs");
    mkdirSync(dir, { recursive: true });
    const body = join(dir, "body.md");
    writeFileSync(body, "# Heading\n\nBody ☃\n");
    const ok = await box.run([...CREATE, "--description-file", body]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(fake.toolCalls().at(-1)?.arguments["description"]).toBe("# Heading\n\nBody ☃\n");

    const big = join(dir, "big.md");
    writeFileSync(big, "x".repeat(ARG_INPUT_MAX_BYTES + 1));
    const calls = fake.toolCalls().length;
    for (const [path, message] of [
      [dir, "is not a regular file (given to --description-file)"],
      [join(dir, "missing.md"), "Cannot read"],
      [big, "is too large (given to --description-file)"],
    ] as const) {
      const refused = await box.run([...CREATE, "--description-file", path]);
      expect(refused.code, path).toBe(2);
      expect(refused.stderr, path).toContain(message);
    }
    expect(fake.toolCalls()).toHaveLength(calls);
  });
});
