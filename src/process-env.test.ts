import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ORIGIN } from "./constants.js";
import { UsageError } from "./errors.js";
import { childEnv, envOrigin, isValidOrigin, normalizeOrigin, resetEnvTokenForTests, takeEnvToken } from "./process-env.js";

const FAKE_KEY = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKE0001";

beforeEach(() => {
  resetEnvTokenForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.JUBARTEAI_TOKEN;
  resetEnvTokenForTests();
});

describe("takeEnvToken", () => {
  it("returns the token and deletes it from process.env", () => {
    vi.stubEnv("JUBARTEAI_TOKEN", `  ${FAKE_KEY}\n`);
    expect(takeEnvToken()).toBe(FAKE_KEY);
    expect(process.env.JUBARTEAI_TOKEN).toBeUndefined();
    expect("JUBARTEAI_TOKEN" in process.env).toBe(false);
    expect(Object.values(childEnv())).not.toContain(FAKE_KEY);
  });

  it("is idempotent: a second call returns the same value although the variable is gone", () => {
    vi.stubEnv("JUBARTEAI_TOKEN", FAKE_KEY);
    expect(takeEnvToken()).toBe(FAKE_KEY);
    expect(takeEnvToken()).toBe(FAKE_KEY);
  });

  it("returns null when unset, and for a blank value (still deleting it)", () => {
    expect(takeEnvToken()).toBeNull();
    vi.stubEnv("JUBARTEAI_TOKEN", "   ");
    expect(takeEnvToken()).toBeNull();
    expect("JUBARTEAI_TOKEN" in process.env).toBe(false);
  });
});

describe("childEnv", () => {
  it("never contains the token even when called before takeEnvToken", () => {
    vi.stubEnv("JUBARTEAI_TOKEN", FAKE_KEY);
    vi.stubEnv("JUBARTEAI_TEST_KEEP", "yes");
    const env = childEnv();
    expect("JUBARTEAI_TOKEN" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
    expect(env.JUBARTEAI_TEST_KEEP).toBe("yes");
  });

  it("adds extra variables but refuses to smuggle the token back in", () => {
    const env = childEnv({ FOO: "bar", JUBARTEAI_TOKEN: FAKE_KEY });
    expect(env.FOO).toBe("bar");
    expect("JUBARTEAI_TOKEN" in env).toBe(false);
  });

  it("returns a copy: editing it leaves process.env alone", () => {
    const env = childEnv({ JUBARTEAI_TEST_COPY: "1" });
    env.PATH = "changed";
    expect(process.env.JUBARTEAI_TEST_COPY).toBeUndefined();
    expect(process.env.PATH).not.toBe("changed");
  });
});

describe("envOrigin", () => {
  it("defaults when unset or blank", () => {
    vi.stubEnv("JUBARTEAI_URL", undefined);
    expect(envOrigin()).toBe(DEFAULT_ORIGIN);
    vi.stubEnv("JUBARTEAI_URL", "  ");
    expect(envOrigin()).toBe(DEFAULT_ORIGIN);
  });

  it.each([
    ["https://x.example", "https://x.example"],
    ["https://x.example/", "https://x.example"],
    ["https://x.example/some/path?q=1#frag", "https://x.example"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://x.example:443", "https://x.example"],
  ])("accepts %s as %s", (value, expected) => {
    vi.stubEnv("JUBARTEAI_URL", value);
    expect(envOrigin()).toBe(expected);
  });

  it.each([
    "http://evil.example",
    "ftp://x.example",
    "javascript:alert(1)",
    "not a url",
    "https://u:p@host.example",
    "https://user@host.example",
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example",
    "//x.example",
    "https://:443",
  ])("rejects %s with a usage error that does not echo it", (value) => {
    vi.stubEnv("JUBARTEAI_URL", value);
    let caught: unknown;
    try {
      envOrigin();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).exitCode).toBe(2);
    expect((caught as UsageError).message).not.toContain(value);
  });
});

describe("isValidOrigin / normalizeOrigin", () => {
  it("agrees with envOrigin's rules", () => {
    expect(isValidOrigin("https://jubarte.ai")).toBe(true);
    expect(isValidOrigin("http://localhost:3000")).toBe(true);
    expect(isValidOrigin("http://jubarte.ai")).toBe(false);
    expect(normalizeOrigin("HTTPS://X.Example/a")).toBe("https://x.example");
    expect(normalizeOrigin("nope")).toBeNull();
  });
});
