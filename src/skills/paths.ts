// Path rules for a downloaded skill. The server validates the same rules; the CLI re-checks every path it
// is about to write, because what it writes is whatever the server's manifest names.
import { posix, win32, isAbsolute, join, relative, resolve, sep } from "node:path";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PATH = 512;
const MAX_SEGMENT = 255;
const MAX_DEPTH = 16;

/** A skill name is also a folder name: lowercase letters, digits and single hyphens. */
export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** True for a relative, forward-slash path with no way out of its folder. */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH) return false;
  if (path.includes("\0") || path.includes("\\") || path.includes(":") || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return false;
  // Zero-width, bidi, BOM and tag characters make a path read as a different name than it is.
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u.test(path)) return false;
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return false;
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) return false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.length > MAX_SEGMENT || /[. ]$/.test(segment)) return false;
    if (WINDOWS_RESERVED.test(segment.split(".")[0] ?? segment)) return false;
  }
  return true;
}

/** `base/rel`, or null when the result would leave `base` (defence in depth after isSafeRelativePath). */
export function joinInside(base: string, rel: string): string | null {
  if (!isSafeRelativePath(rel)) return null;
  const target = resolve(join(base, ...rel.split("/")));
  const back = relative(resolve(base), target);
  if (back === "" || back.startsWith("..") || isAbsolute(back) || back.split(sep).includes("..")) return null;
  return target;
}
