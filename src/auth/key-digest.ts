import { createHash, timingSafeEqual } from "node:crypto";

// Keys are compared by SHA-256 digest, never as text, so a comparison can't leak one through a timing difference and
// no code path needs to hold two keys side by side to ask "is this the same key". A digest is as secret as the key:
// it is never printed, logged or stored.

/** SHA-256 of a key, as bytes. */
export function keyDigest(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** Whether two digests are equal (constant time). */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether two keys are the same key, compared by digest. */
export function sameKey(a: string, b: string): boolean {
  return digestsEqual(keyDigest(a), keyDigest(b));
}
