// `jubarteai hook <event> --harness <id>` (spec §6.3): the command `init` registers in each harness's
// hook file. Reads the harness's JSON from stdin, never prompts, never prints a key, and always exits 0
// (I7): whatever goes wrong, the harness carries on.
import type { ParsedArgs } from "../cli/args.js";
import type { CommandContext, CommandDef } from "../cli/commands.js";
import { ARG_INPUT_MAX_BYTES, HOOK_NETWORK_TIMEOUT_MS, HOOK_TOTAL_BUDGET_MS } from "../constants.js";
import { SESSION_END_NETWORK_TIMEOUT_MS, parseHookEvent, runHookEvent } from "../hooks/events.js";
import type { HookRuntime } from "../hooks/events.js";
import { harnessFromHint, parseHookInput } from "../hooks/input.js";
import { callTool } from "../mcp/client.js";

export type HookDeps = {
  call: typeof callTool;
  budgetMs: number;
  networkTimeoutMs: number;
  endTimeoutMs: number;
  env: NodeJS.ProcessEnv;
};

function defaultDeps(): HookDeps {
  return {
    call: callTool,
    budgetMs: HOOK_TOTAL_BUDGET_MS,
    networkTimeoutMs: HOOK_NETWORK_TIMEOUT_MS,
    endTimeoutMs: SESSION_END_NETWORK_TIMEOUT_MS,
    env: process.env,
  };
}

/** All of stdin as text, or "" when it is a terminal, too large, unreadable, or `signal` aborts first. */
function readAllStdin(stream: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> {
  if ((stream as { isTTY?: boolean }).isTTY === true || signal.aborted) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      stream.pause();
      resolve(text);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += bytes.length;
      if (total > ARG_INPUT_MAX_BYTES) finish("");
      else chunks.push(bytes);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (): void => finish("");
    const onAbort = (): void => finish("");
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
      const raw = await readAllStdin(ctx.stdin, controller.signal);
      return runHookEvent(parseHookInput(raw, hint, event, deps.env, ctx.cwd), runtime);
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

export const hookCommand: CommandDef = {
  name: "hook",
  summary: "Run a harness hook (internal; registered by init)",
  group: "internal",
  usage: "hook <session-start|user-prompt-submit|session-end> [--harness <id>]",
  flags: [{ name: "harness", type: "string", description: "The harness that registered the hook (a hint; the detected one wins)" }],
  run: (ctx, args) => runHook(ctx, args),
};
