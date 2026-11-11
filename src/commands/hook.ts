// `jubarteai hook <event> --harness <id>` (spec §6.3): the command `init` registers in each harness's
// hook file. Reads the harness's JSON from stdin, never prompts, never prints a key, and always exits 0
// (I7): whatever goes wrong, the harness carries on. `pre-tool-use` is the deny-only guard of the shared Copilot hook
// file (hooks/tool-guard.ts): no network, no session, and always one JSON object on stdout.
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { ARG_INPUT_MAX_BYTES, GUARD_INPUT_MAX_BYTES, HOOK_NETWORK_TIMEOUT_MS, HOOK_TOTAL_BUDGET_MS } from "../constants.js";
import { SESSION_END_NETWORK_TIMEOUT_MS, parseHookEvent, runHookEvent } from "../hooks/events.js";
import type { HookRuntime } from "../hooks/events.js";
import { harnessFromHint, parseHookInput } from "../hooks/input.js";
import { PRE_TOOL_USE, toolGuardDecision } from "../hooks/tool-guard.js";
import { callTool } from "../mcp/client.js";

export type HookDeps = {
  call: typeof callTool;
  budgetMs: number;
  networkTimeoutMs: number;
  endTimeoutMs: number;
  /** The guard's read cap (GUARD_INPUT_MAX_BYTES); a parameter so a test can reach it without 16 MiB of input. */
  guardMaxBytes: number;
  env: NodeJS.ProcessEnv;
};

function defaultDeps(): HookDeps {
  return {
    call: callTool,
    budgetMs: HOOK_TOTAL_BUDGET_MS,
    networkTimeoutMs: HOOK_NETWORK_TIMEOUT_MS,
    endTimeoutMs: SESSION_END_NETWORK_TIMEOUT_MS,
    guardMaxBytes: GUARD_INPUT_MAX_BYTES,
    env: process.env,
  };
}

type StdinRead = { text: string; overflow: boolean };

/**
 * All of stdin as text ("" when it is a terminal, unreadable, or `signal` aborts first). Past `maxBytes` it stops
 * reading and returns what it has with `overflow` set: the session events drop it (cap ARG_INPUT_MAX_BYTES), the guard
 * denies it (cap GUARD_INPUT_MAX_BYTES).
 */
function readAllStdin(stream: NodeJS.ReadableStream, signal: AbortSignal, maxBytes: number): Promise<StdinRead> {
  if ((stream as { isTTY?: boolean }).isTTY === true || signal.aborted) return Promise.resolve({ text: "", overflow: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (read: StdinRead): void => {
      if (settled) return;
      settled = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      stream.pause();
      resolve(read);
    };
    const text = (): string => Buffer.concat(chunks).toString("utf8");
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const room = maxBytes - total;
      total += bytes.length;
      if (total > maxBytes) {
        if (room > 0) chunks.push(bytes.subarray(0, room));
        finish({ text: text(), overflow: true });
      } else chunks.push(bytes);
    };
    const onEnd = (): void => finish({ text: text(), overflow: false });
    const onError = (): void => finish({ text: "", overflow: false });
    const onAbort = (): void => finish({ text: "", overflow: false });
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs the hook and writes at most one chunk to stdout, only once the event has finished. When the
 * overall budget runs out, the work is aborted and nothing is printed. Resolves to 0 in every case.
 */
export async function runHook(ctx: CommandContext, args: ParsedArgs, deps: HookDeps = defaultDeps()): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.budgetMs);
  try {
    if (args.positionals[0] === PRE_TOOL_USE) {
      await runToolGuard(ctx, controller.signal, deps.guardMaxBytes);
      return 0;
    }
    const event = parseHookEvent(args.positionals[0]);
    if (event === null) return 0;
    const hint = harnessFromHint(args.flags["harness"]);
    const runtime: HookRuntime = {
      call: deps.call,
      networkTimeoutMs: deps.networkTimeoutMs,
      endTimeoutMs: deps.endTimeoutMs,
      signal: controller.signal,
    };
    const work = (async (): Promise<string> => {
      const read = await readAllStdin(ctx.stdin, controller.signal, ARG_INPUT_MAX_BYTES);
      return runHookEvent(parseHookInput(read.overflow ? "" : read.text, hint, event, deps.env, ctx.cwd), runtime);
    })().catch(() => "");
    const expired = new Promise<string>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(""), { once: true });
    });
    const out = await Promise.race([work, expired]);
    if (out !== "" && !controller.signal.aborted) ctx.stdout.write(out);
  } catch {
    // A hook never fails the harness, and an exception's message may quote a request: say nothing.
  } finally {
    clearTimeout(timer);
  }
  return 0;
}

/**
 * The guard: always exactly one JSON object on stdout, `{}` (no decision) unless the call runs a person command or is
 * too large to read whole (past `maxBytes`, a deny). A read that the budget cuts short is `{}`: a timeout lets the call
 * through the normal permission flow, as the harness itself does when a hook times out.
 */
async function runToolGuard(ctx: CommandContext, signal: AbortSignal, maxBytes: number): Promise<void> {
  let out = "{}";
  try {
    const read = await readAllStdin(ctx.stdin, signal, maxBytes);
    if (!signal.aborted) out = JSON.stringify(toolGuardDecision(read.text, read.overflow));
  } catch {
    // Never block a call the guard couldn't read.
  }
  ctx.stdout.write(`${out}\n`);
}

export const hookCommand: CommandDef = {
  name: "hook",
  summary: "Run a harness hook (internal; registered by init)",
  group: "internal",
  usage: "hook <session-start|user-prompt-submit|session-end|pre-tool-use> [--harness <id>]",
  flags: [{ name: "harness", type: "string", description: "The harness that registered the hook (a hint; the detected one wins)" }],
  run: (ctx, args) => runHook(ctx, args),
};
