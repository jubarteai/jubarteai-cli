// Installing and removing skill folders. A folder is ours only when it holds a valid ownership marker;
// anything else with the same name is a clash and is never touched. Never follows a symlink.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILLS_MARKER_FILE, SKILLS_TMP_PREFIX } from "../constants.js";
import { isSafeRelativePath, isValidSkillName, joinInside } from "./paths.js";

export type SkillMarker = {
  v: 1;
  workspace_id: string | null;
  name: string;
  revision_id: string;
  digest: string;
  synced_at: string;
};

export type SkillFile = { path: string; bytes: Buffer; executable: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The marker of a managed skill folder, or null (missing, unreadable, malformed, or the folder is a symlink). */
export function readMarker(dir: string): SkillMarker | null {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const markerPath = join(dir, SKILLS_MARKER_FILE);
    const mst = lstatSync(markerPath);
    if (!mst.isFile() || mst.size > 4096) return null;
    const raw: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!isRecord(raw) || raw["v"] !== 1) return null;
    if (typeof raw["name"] !== "string" || typeof raw["revision_id"] !== "string" || typeof raw["digest"] !== "string") return null;
    return {
      v: 1,
      workspace_id: typeof raw["workspace_id"] === "string" ? raw["workspace_id"] : null,
      name: raw["name"],
      revision_id: raw["revision_id"],
      digest: raw["digest"],
      synced_at: typeof raw["synced_at"] === "string" ? raw["synced_at"] : "",
    };
  } catch {
    return null;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export type InstallResult = "installed" | "clash";

/**
 * Stages `files` beside the destination and swaps the folder in with renames, so a crash leaves either the
 * previous folder or the new one (plus a temp folder the next run cleans). Returns "clash" without writing
 * anything when `<targetDir>/<name>` exists and isn't ours.
 */
export function installSkill(targetDir: string, name: string, files: readonly SkillFile[], marker: Omit<SkillMarker, "name">): InstallResult {
  if (!isValidSkillName(name)) throw new Error("invalid_name");
  if (isSymlink(targetDir)) throw new Error("unsafe_target");
  const dest = join(targetDir, name);
  let existing = false;
  try {
    lstatSync(dest);
    existing = true;
  } catch {
    // does not exist
  }
  if (existing && readMarker(dest) === null) return "clash";

  mkdirSync(targetDir, { recursive: true });
  const tmp = join(targetDir, `${SKILLS_TMP_PREFIX}${name}-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp);
  try {
    for (const file of files) {
      if (!isSafeRelativePath(file.path) || file.path === SKILLS_MARKER_FILE) throw new Error("unsafe_path");
      const target = joinInside(tmp, file.path);
      if (target === null) throw new Error("unsafe_path");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
      if (file.executable) chmodSync(target, 0o755);
    }
    writeFileSync(join(tmp, SKILLS_MARKER_FILE), `${JSON.stringify({ ...marker, name })}\n`, { mode: 0o644 });
    if (existing) {
      const old = `${tmp}-old`;
      renameSync(dest, old);
      try {
        renameSync(tmp, dest);
      } catch (error) {
        renameSync(old, dest);
        throw error;
      }
      rmSync(old, { recursive: true, force: true });
    } else {
      renameSync(tmp, dest);
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return "installed";
}

/** Removes a managed folder. Refuses (returns false) a folder without our marker. */
export function removeManaged(targetDir: string, name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const dest = join(targetDir, name);
  if (readMarker(dest) === null) return false;
  rmSync(dest, { recursive: true, force: true });
  return true;
}

/** The managed folders of a target dir: name → marker. */
export function listManaged(targetDir: string): Map<string, SkillMarker> {
  const out = new Map<string, SkillMarker>();
  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!isValidSkillName(entry)) continue;
    const marker = readMarker(join(targetDir, entry));
    if (marker !== null && marker.name === entry) out.set(entry, marker);
  }
  return out;
}

/** Unmanaged folders (anything a sync would clash with) of a target dir, by name. */
export function listUnmanaged(targetDir: string): string[] {
  try {
    return readdirSync(targetDir).filter((e) => isValidSkillName(e) && readMarker(join(targetDir, e)) === null);
  } catch {
    return [];
  }
}

/** Deletes temp folders a crashed sync left behind. */
export function cleanTemps(targetDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(SKILLS_TMP_PREFIX)) rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
}

export function dirExists(path: string): boolean {
  return existsSync(path);
}
