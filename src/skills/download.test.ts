import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadVerified } from "./download.js";

const bytes = Buffer.from("hello skill");
const sha = createHash("sha256").update(bytes).digest("hex");
const respond = (body: Buffer | string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const base = { size: bytes.length, sha256: sha, appOrigin: "https://app.test" };

describe("downloadVerified", () => {
  it("returns verified bytes and sends no credentials", async () => {
    let headers: Headers | undefined;
    const f = (async (_u: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      return new Response(bytes);
    }) as unknown as typeof fetch;
    expect((await downloadVerified("https://x.supabase.co/file?token=t", { ...base, fetchImpl: f })).equals(bytes)).toBe(true);
    expect(headers?.has("authorization")).toBe(false);
  });
  it("refuses http outside loopback development and credentials in the url", async () => {
    await expect(downloadVerified("http://x.test/f", { ...base, fetchImpl: respond(bytes) })).rejects.toMatchObject({ code: "bad_url" });
    await expect(downloadVerified("https://u:p@x.test/f", { ...base, fetchImpl: respond(bytes) })).rejects.toMatchObject({ code: "bad_url" });
    await expect(downloadVerified("not a url", { ...base, fetchImpl: respond(bytes) })).rejects.toMatchObject({ code: "bad_url" });
    await expect(downloadVerified("http://127.0.0.1:54321/f", { ...base, appOrigin: "https://app.test", fetchImpl: respond(bytes) })).rejects.toMatchObject({ code: "bad_url" });
    expect((await downloadVerified("http://127.0.0.1:54321/f", { ...base, appOrigin: "http://localhost:3000", fetchImpl: respond(bytes) })).length).toBe(bytes.length);
  });
  it("rejects a wrong size, a wrong digest, an error status and a refused redirect", async () => {
    await expect(downloadVerified("https://x.test/f", { ...base, fetchImpl: respond("a much longer body than declared") })).rejects.toMatchObject({ code: "size" });
    await expect(downloadVerified("https://x.test/f", { ...base, fetchImpl: respond("short") })).rejects.toMatchObject({ code: "size" });
    await expect(downloadVerified("https://x.test/f", { ...base, fetchImpl: respond("hello skilX") })).rejects.toMatchObject({ code: "digest" });
    await expect(downloadVerified("https://x.test/f", { ...base, fetchImpl: respond("x", 404) })).rejects.toMatchObject({ code: "http" });
    const redirecting = (async () => {
      throw new TypeError("redirect");
    }) as unknown as typeof fetch;
    await expect(downloadVerified("https://x.test/f", { ...base, fetchImpl: redirecting })).rejects.toMatchObject({ code: "network" });
  });
});
