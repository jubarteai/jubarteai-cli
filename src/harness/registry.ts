// Every harness adapter, in the order of spec §9.
import type { HarnessId } from "../session/harness-env.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { copilotCliAdapter } from "./copilot-cli.js";
import { cursorAdapter } from "./cursor.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import { opencodeAdapter } from "./opencode.js";
import type { HarnessAdapter } from "./types.js";
import { vscodeAdapter } from "./vscode.js";
import { windsurfAdapter } from "./windsurf.js";
import { zedAdapter } from "./zed.js";

export const ADAPTERS: readonly HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  vscodeAdapter,
  windsurfAdapter,
  zedAdapter,
  geminiCliAdapter,
  opencodeAdapter,
  copilotCliAdapter,
];

/** The adapter for `id`. Throws for an id with no adapter (HarnessId and ADAPTERS are kept in step by a test). */
export function adapterFor(id: HarnessId): HarnessAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (adapter === undefined) throw new RangeError(`no adapter for harness ${id}`);
  return adapter;
}
