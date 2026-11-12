import { join } from "node:path";

import type { StoredSeat } from "../auth/credentials.js";
import { digestsEqual, keyDigest } from "../auth/key-digest.js";
import { API_KEY_RE } from "../auth/token-exchange.js";
import { INIT_COPY, codexActsAs } from "../install/init-copy.js";
import { safeForDisplay } from "../output.js";
import { readConfigText } from "../safe-edit/json-edit.js";
import type { PlanStep, StepResult } from "../safe-edit/plan.js";
import { TomlConflictError, editTomlFile, getTomlTable, readTomlKey, setTomlKey } from "../safe-edit/toml-edit.js";
import { codexHome, isUnderHome, shownPath } from "./mcp-cleanup.js";

// The jubarteai entry in Codex's user-level config (`~/.codex/config.toml`, `[mcp_servers.jubarteai]`): what init's D5
// fallback writes. One module owns reading it (the url and the bearer key, in every spelling Codex accepts), asking
// whose key it is (by SHA-256 digest, never printing a key or a digest) and rewriting the key, so `init`, `login` and
// `doctor` agree about what an entry holds and which entries can be refreshed.

export const CODEX_MCP_TABLE = "mcp_servers.jubarteai";
export const CODEX_UPDATE_STEP_ID = "codex:mcp-update";
const CODEX_HEADERS_TABLE = `${CODEX_MCP_TABLE}.http_headers`;
const CODEX_CONFIG_MODE = 0o600;
const DISPLAY_MAX = 200;

/**
 * `http_headers = { "Authorization" = "Bearer <key>" }` on one line (how init and install.sh write it): the header name
 * quoted either way or bare, the value in either kind of string. Group 1 is everything before the value's opening quote,
 * group 2 the key of a double-quoted value, group 3 the key of a single-quoted one.
 */
const INLINE_BEARER = /(^[ \t]*http_headers[ \t]*=[ \t]*\{[^\n]*?(?:"authorization"|'authorization'|\bauthorization)[ \t]*=[ \t]*)(?:"Bearer[ \t]+([^"\\\s]+)"|'Bearer[ \t]+([^'\s]+)')/im;

type BearerLocation =
  | { kind: "inline"; bearer: string; from: number; to: number; head: string }
  | { kind: "table"; bearer: string; key: string };

/** Where the entry's bearer key sits: in an inline `http_headers = { … }` or in a `[mcp_servers.jubarteai.http_headers]` table. */
function locateBearer(text: string, body: string): BearerLocation | null {
  const inline = INLINE_BEARER.exec(body);
  const value = inline?.[2] ?? inline?.[3];
  if (inline !== null && value !== undefined) {
    return { kind: "inline", bearer: value, from: inline.index, to: inline.index + inline[0].length, head: inline[1] ?? "" };
  }
  for (const key of ["Authorization", "authorization"]) {
    const header = readTomlKey(text, CODEX_HEADERS_TABLE, key);
    const match = typeof header === "string" ? /^Bearer\s+(\S+)$/.exec(header) : null;
    if (match?.[1] !== undefined) return { kind: "table", bearer: match[1], key };
  }
  return null;
}

/** The user-level Codex config file. */
export function codexUserFile(home: string, env: NodeJS.ProcessEnv): string {
  return join(codexHome(home, env), "config.toml");
}

export type CodexEntry = { url: string | null; bearer: string | null };

/**
 * The jubarteai entry of the user-level Codex config: null when there is no readable file or no such table; otherwise its
 * url and bearer key (each null when absent or written in a form that can't be read). Never throws.
 */
export function readCodexEntry(file: string): CodexEntry | null {
  let text: string;
  try {
    const read = readConfigText(file);
    if (read.status !== "ok") return null;
    text = read.text;
  } catch {
    return null;
  }
  try {
    const table = getTomlTable(text, CODEX_MCP_TABLE);
    if (table === null) return null;
    const url = readTomlKey(text, CODEX_MCP_TABLE, "url");
    return { url: typeof url === "string" ? url : null, bearer: locateBearer(text, table.body)?.bearer ?? null };
  } catch {
    // A table TOML can't be read the way we read it: an entry whose url and key are unknown.
    return { url: null, bearer: null };
  }
}

/** The origin of a url, or null when it isn't one. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The stored seat whose key is `bearer` (compared by digest, at the same origin), or undefined when it is none of them. */
export function seatForBearer(seats: Record<string, StoredSeat>, origin: string, bearer: string): { seatId: string; seat: StoredSeat } | undefined {
  const wanted = originOf(origin);
  if (wanted === null) return undefined;
  const digest = keyDigest(bearer);
  for (const [seatId, seat] of Object.entries(seats)) {
    if (originOf(seat.origin) === wanted && digestsEqual(keyDigest(seat.token), digest)) return { seatId, seat };
  }
  return undefined;
}

/** Whether a key read from Codex's entry is `key` (digest comparison). */
export function bearerIs(bearer: string, key: string): boolean {
  return digestsEqual(keyDigest(bearer), keyDigest(key));
}

/** The workspace as the user knows it (its name, else its slug), safe to print. */
export function workspaceLabel(seat: StoredSeat): string {
  return safeForDisplay(seat.company.name !== "" ? seat.company.name : seat.company.slug, DISPLAY_MAX);
}

/**
 * A Codex entry whose key is no longer one this machine can use (a re-login revoked the old CLI key): the step that writes
 * the new one, behind its own prompt. The key is rewritten in whichever header form the entry uses (an inline
 * `http_headers`, double- or single-quoted, or a `[mcp_servers.jubarteai.http_headers]` table); a form it can't read is
 * reported as skipped, not touched. Only the entry whose url is exactly `url` is ever rewritten (re-checked at apply time).
 */
export function codexUpdateStep(where: { home: string; env: NodeJS.ProcessEnv }, seat: StoredSeat, url: string): PlanStep {
  const file = codexUserFile(where.home, where.env);
  const shown = shownPath(file, where.home);
  const token = seat.token;
  const withinHome = isUnderHome(file, where.home);
  const label = INIT_COPY.codexUpdateLabel;
  const id = CODEX_UPDATE_STEP_ID;
  return {
    id,
    label,
    files: [file],
    sensitive: true,
    preview: `${shown}:\n[${CODEX_MCP_TABLE}]\nhttp_headers = { "Authorization" = "Bearer <your key>" }\n${codexActsAs(safeForDisplay(seat.user.email, DISPLAY_MAX), workspaceLabel(seat))}`,
    flag: "--yes",
    async apply(): Promise<StepResult> {
      if (!API_KEY_RE.test(token)) return { id, label, status: "failed", detail: INIT_COPY.codexKeyShape };
      let unreadable = false;
      try {
        const result = editTomlFile(
          file,
          (text) => {
            const table = getTomlTable(text, CODEX_MCP_TABLE);
            if (table === null || readTomlKey(text, CODEX_MCP_TABLE, "url") !== url) return { text, changed: false };
            const found = locateBearer(text, table.body);
            if (found === null) {
              unreadable = true;
              return { text, changed: false };
            }
            const value = `Bearer ${token}`;
            if (found.kind === "table") return setTomlKey(text, CODEX_HEADERS_TABLE, found.key, value);
            const bodyStart = table.end - table.body.length;
            const next = table.body.slice(0, found.from) + found.head + JSON.stringify(value) + table.body.slice(found.to);
            return { text: text.slice(0, bodyStart) + next + text.slice(table.end), changed: next !== table.body };
          },
          { createIfMissing: false, mode: CODEX_CONFIG_MODE, withinHome },
        );
        if (unreadable) return { id, label, status: "skipped", detail: INIT_COPY.codexUnreadableReason };
        if (result.status === "refused") return { id, label, status: "failed", detail: `could not write (${result.reason ?? "refused"})` };
        return { id, label, status: result.status === "changed" ? "configured" : "already configured" };
      } catch (error) {
        if (error instanceof TomlConflictError) return { id, label, status: "skipped", detail: INIT_COPY.codexTableInline };
        throw error;
      }
    },
  };
}
