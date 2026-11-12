import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createPkce, createState } from "./pkce.js";

describe("createPkce", () => {
  it("makes a 43-char base64url verifier and its S256 challenge", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("is fresh every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPkce().verifier));
    expect(seen.size).toBe(50);
  });

  it("matches the RFC 7636 appendix B vector for the transform", () => {
    // verifier from RFC 7636 appendix B; the expected challenge is the RFC's value.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("createState", () => {
  it("is 22 base64url chars and fresh every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createState()));
    expect(seen.size).toBe(50);
    for (const state of seen) expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
