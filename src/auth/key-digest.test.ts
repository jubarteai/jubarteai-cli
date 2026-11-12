import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { digestsEqual, keyDigest, sameKey } from "./key-digest.js";

// Keys are compared by digest only (login's replaces check, Codex's entry, the re-login notice): equal keys must match,
// any difference must not, and digests of different lengths must answer false rather than throw (timingSafeEqual
// throws on a length mismatch, which would surface as an "unexpected error" in the middle of a login).

const KEY = "jba_DIGESTDIGESTDIGESTDIGEST01";

describe("key digests", () => {
  it("keyDigest is the SHA-256 of the key's UTF-8 bytes", () => {
    expect(keyDigest(KEY).equals(createHash("sha256").update(KEY, "utf8").digest())).toBe(true);
    expect(keyDigest(KEY)).toHaveLength(32);
  });

  it("sameKey is true only for the same key, case and every character included", () => {
    expect(sameKey(KEY, `${KEY}`)).toBe(true);
    for (const other of [`${KEY}x`, KEY.slice(0, -1), KEY.toLowerCase(), ` ${KEY}`, ""]) {
      expect(sameKey(KEY, other), JSON.stringify(other)).toBe(false);
    }
  });

  it("digestsEqual answers false for digests of different lengths instead of throwing", () => {
    const digest = keyDigest(KEY);
    expect(() => digestsEqual(digest, digest.subarray(0, 16))).not.toThrow();
    expect(digestsEqual(digest, digest.subarray(0, 16))).toBe(false);
    expect(digestsEqual(digest, Buffer.alloc(0))).toBe(false);
    expect(digestsEqual(digest, Buffer.from(digest))).toBe(true);
  });
});
