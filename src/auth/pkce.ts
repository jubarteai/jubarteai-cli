import { createHash, randomBytes } from "node:crypto";

// PKCE (RFC 7636, S256) for the browser login: spec section 7.1.

const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

/** A fresh verifier (32 random bytes, base64url, 43 chars) and its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

/** The anti-CSRF `state` the callback must echo: 16 random bytes, base64url (22 chars). */
export function createState(): string {
  return randomBytes(STATE_BYTES).toString("base64url");
}
