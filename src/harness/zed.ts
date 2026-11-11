// Zed adapter (spec §9). Verified cells only:
//   - permission: settings.json `agent.tool_permissions.tools.terminal.always_allow` gets `{"pattern":"^jubarteai\\b"}`.
//     Zed's settings.json is JSONC; a file with comments is never rewritten, the exact entry is printed instead.
//   - hooks: Zed documents no hook API, so they are printed instructions (D25).
//   - MCP cleanup: Zed's user settings.json and .zed/settings.json, `context_servers.jubarteai`, through mcp-cleanup.ts (C6a).
// Every write goes through editJsonFile (I6), via the shared helpers in cursor.ts.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PlanStep } from "../safe-edit/plan.js";
import {
  isObject,
  jsonEditStep,
  cleanupScopeOf,
  manual,
  readable,
  type EditOutcome,
  type Obj,
} from "./cursor.js";
import { findMcpEntries, mcpCleanupFor } from "./mcp-cleanup.js";
import type { AdapterState, CleanupScope, DetectEnv, HarnessAdapter, InitCtx, ManualInstructions } from "./types.js";

const HARNESS = "zed" as const;
const LABEL = "Zed";
const ALLOW_PATTERN = "^jubarteai\\b";
const PERMISSION_PATH = ["agent", "tool_permissions", "tools", "terminal"] as const;

function absoluteEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== "" && isAbsolute(value) ? value : null;
}

/** Zed's user settings directory, as mcp-cleanup.ts reads it: ~/.config/zed on macOS, $XDG_CONFIG_HOME/zed (when absolute) on Linux, %APPDATA%\Zed on Windows. */
function zedDir(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") return join(absoluteEnv(env, "APPDATA") ?? join(home, "AppData", "Roaming"), "Zed");
  if (platform === "darwin") return join(home, ".config", "zed");
  return join(absoluteEnv(env, "XDG_CONFIG_HOME") ?? join(home, ".config"), "zed");
}

const settingsPath = (home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => join(zedDir(home, env, platform), "settings.json");

function isRule(entry: unknown): boolean {
  return isObject(entry) && entry["pattern"] === ALLOW_PATTERN;
}

/** The terminal tool's always_allow list as found: absent, a list, or a shape we cannot merge into. */
function alwaysAllow(doc: Obj): unknown[] | "absent" | "bad" {
  let node: unknown = doc;
  for (const key of PERMISSION_PATH) {
    if (node === undefined) return "absent";
    if (!isObject(node)) return "bad";
    node = node[key];
  }
  if (node === undefined) return "absent";
  if (!isObject(node)) return "bad";
  const list = node["always_allow"];
  if (list === undefined) return "absent";
  return Array.isArray(list) ? list : "bad";
}

function addPermission(doc: Obj): EditOutcome {
  const list = alwaysAllow(doc);
  if (list === "bad") return { blocked: "agent.tool_permissions.tools.terminal.always_allow in settings.json is not a list; add the entry by hand" };
  if (list !== "absent") {
    if (list.some(isRule)) return "same";
    list.push({ pattern: ALLOW_PATTERN });
    return "changed";
  }
  let node: Obj = doc;
  for (const key of PERMISSION_PATH) {
    const next = node[key];
    if (isObject(next)) node = next;
    else {
      const created: Obj = {};
      node[key] = created;
      node = created;
    }
  }
  node["always_allow"] = [{ pattern: ALLOW_PATTERN }];
  return "changed";
}

function permissionJson(): string[] {
  return JSON.stringify({ agent: { tool_permissions: { tools: { terminal: { always_allow: [{ pattern: ALLOW_PATTERN }] } } } } }, null, 2).split("\n");
}

export const zedAdapter: HarnessAdapter = {
  id: HARNESS,
  label: LABEL,
  skillAgent: "zed",
  sessionVar: null,
  promptInjection: false,

  async detect(env: DetectEnv): Promise<boolean> {
    return existsSync(zedDir(env.home, env.env, env.platform)) || env.which("zed") !== null;
  },

  async permission(ctx: InitCtx): Promise<PlanStep | ManualInstructions | null> {
    const file = settingsPath(ctx.home, ctx.env, ctx.platform);
    if (readable(file).status === "unwritable") {
      return manual(
        HARNESS,
        "Zed: allow the jubarteai command",
        [`Open ${file} and add:`, ...permissionJson(), "(merge it into the existing agent.tool_permissions setting)"],
        "settings.json has comments or is not plain JSON, so it is not rewritten",
      );
    }
    return jsonEditStep({
      id: `${HARNESS}:permission`,
      label: "Zed: allow the jubarteai command",
      file,
      preview: `  agent.tool_permissions.tools.terminal.always_allow += { "pattern": "${ALLOW_PATTERN.replace(/\\/g, "\\\\")}" }`,
      createIfMissing: true,
      edit: addPermission,
    });
  },

  async hooks(): Promise<PlanStep[] | ManualInstructions | null> {
    return manual(
      HARNESS,
      "Zed: session hooks",
      [
        "Zed has no documented hook API, so the CLI does not register session hooks there.",
        "Run `jubarteai connect` at the start of a session and pass --agent <id> on every jubarteai command; the skill and the AGENTS.md section say the same.",
      ],
      "Zed documents no hook API (D25)",
    );
  },

  async inspect(ctx: InitCtx): Promise<AdapterState> {
    const read = readable(settingsPath(ctx.home, ctx.env, ctx.platform));
    let permission: AdapterState["permission"] = "missing";
    if (read.status === "unwritable") permission = "manual";
    else if (read.status === "ok") {
      const list = alwaysAllow(read.doc);
      if (Array.isArray(list) && list.some(isRule)) permission = "configured";
    }
    return {
      permission,
      hooks: "manual",
      mcpEntries: await findMcpEntries(HARNESS, cleanupScopeOf(ctx)),
      notes: ["Zed has no documented hook API; session hooks are not registered"],
    };
  },

  async mcpCleanup(scope: CleanupScope): Promise<Array<PlanStep | ManualInstructions>> {
    return mcpCleanupFor(HARNESS, scope);
  },
};
