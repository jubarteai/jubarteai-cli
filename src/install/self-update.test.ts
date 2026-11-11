// Tests for the CLI's own update: the registry lookup (fetch is stubbed, never the network), the version
// comparison, `npm install -g` and the hand-over to the new binary (stub npm / jubarteai on a private PATH that
// record their argv and whether they saw the key).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_INSTALL_TIMEOUT_MS,
  CLI_REGISTRY_LATEST_URL,
  CLI_REGISTRY_TIMEOUT_MS,
  fetchLatestVersion,
  installCliVersion,
  isNewer,
  isSemver,
  reexecCli,
} from "./self-update.js";

vi.setConfig({ testTimeout: 30_000 });

const FAKE_TOKEN = "jba_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const posix = process.platform !== "win32";

describe("isNewer / isSemver", () => {
  it.each([
    ["0.2.0", "0.1.0", true],
    ["0.1.1", "0.1.0", true],
    ["1.0.0", "0.99.99", true],
    ["0.10.0", "0.9.0", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.1.0", "0.1.0-rc.1", true],
    ["0.1.0-rc.2", "0.1.0-rc.1", true],
    ["0.1.0-rc.10", "0.1.0-rc.9", true],
    ["0.1.0-rc.1", "0.1.0", false],
    ["0.1.0-beta", "0.1.0-alpha", true],
    ["0.1.0-alpha.1", "0.1.0-alpha", true],
    ["0.1.0-1", "0.1.0-alpha", false],
    ["0.1.0+build.2", "0.1.0+build.1", false],
    ["0.1.0", "0.0.0-dev", true],
    ["99999999999999999999.0.0", "1.0.0", true],
  ])("isNewer(%s, %s) is %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });

  it.each(["", "latest", "1.2", "v1.2.3", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3 ; rm -rf ~"])(
    "a non-semver value (%j) is never newer, on either side",
    (value) => {
      expect(isNewer(value, "0.0.1")).toBe(false);
      expect(isNewer("9.9.9", value)).toBe(false);
    },
  );

  it("isSemver accepts versions and refuses anything else", () => {
    expect(isSemver("1.2.3")).toBe(true);
    expect(isSemver("1.2.3-rc.1+sha.abc")).toBe(true);
    expect(isSemver("1.2.3;x")).toBe(false);
    expect(isSemver("jubarteai@1.2.3")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (body: string, status = 200): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })),
    );
  };

  it("returns the registry's latest version, asked anonymously with GET, no redirects, a 5 s default timeout", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ name: "jubarteai", version: "1.4.2" })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion()).toBe("1.4.2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CLI_REGISTRY_LATEST_URL);
    expect(CLI_REGISTRY_LATEST_URL).toBe("https://registry.npmjs.org/jubarteai/latest");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain("authorization");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(CLI_REGISTRY_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    ["a non-200 answer", "{\"version\":\"1.0.0\"}", 404],
    ["a 500", "oops", 500],
    ["a body that isn't JSON", "<html>", 200],
    ["JSON without a version", "{\"name\":\"jubarteai\"}", 200],
    ["a version that isn't semver", "{\"version\":\"1.0; rm -rf /\"}", 200],
    ["a numeric version", "{\"version\":1}", 200],
    ["a JSON array", "[]", 200],
  ])("returns null for %s", async (_name, body, status) => {
    respond(body, status);
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("returns null for an oversized body", async () => {
    respond(JSON.stringify({ version: "1.0.0", pad: "x".repeat(2 * 1024 * 1024) }));
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("returns null when offline (fetch rejects), never throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(fetchLatestVersion()).resolves.toBeNull();
  });

  it("returns null when the registry doesn't answer within timeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
          }),
      ),
    );
    const started = Date.now();
    expect(await fetchLatestVersion({ timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns null when the caller's signal aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal?.aborted === true) reject(new DOMException("aborted", "AbortError"));
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    expect(await fetchLatestVersion({ signal: controller.signal })).toBeNull();
  });
});

describe.skipIf(!posix)("installCliVersion and reexecCli", () => {
  const ENV_KEYS = ["PATH", "JUBARTEAI_TOKEN", "HOME", "NODE_OPTIONS"] as const;
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  let root: string;
  let bin: string;

  const STUB = (exitCode: number, stderr = ""): string => `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const me = path.basename(process.argv[1]);
const sawToken = "JUBARTEAI_TOKEN" in process.env || Object.values(process.env).some((v) => String(v).includes("jba_FAKE"));
const nodeOptions = [process.env.NODE_OPTIONS, process.env.npm_config_node_options];
fs.appendFileSync(path.join(__dirname, me + ".log"), JSON.stringify({ argv: process.argv.slice(2), cwd: fs.realpathSync(process.cwd()), nodeOptions, sawToken }) + "\\n");
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${exitCode});
`;

  const stub = (name: string, exitCode: number, stderr = ""): void => {
    const file = join(bin, name);
    writeFileSync(file, STUB(exitCode, stderr));
    chmodSync(file, 0o755);
  };

  type Call = { argv: string[]; cwd: string; nodeOptions: Array<string | null>; sawToken: boolean };
  const calls = (name: string): Call[] => {
    const file = join(bin, `${name}.log`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Call);
  };

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    root = realpathSync(mkdtempSync(join(tmpdir(), "jba-selfupdate-")));
    bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "home"));
    process.env.PATH = bin;
    process.env.HOME = join(root, "home");
    process.env.JUBARTEAI_TOKEN = FAKE_TOKEN;
  });

  afterEach(() => {
    const recorded = ["npm", "jubarteai"].flatMap((name) => calls(name));
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    for (const call of recorded) {
      expect(call.sawToken).toBe(false);
      expect(call.argv.join(" ")).not.toContain("jba_");
    }
  });

  it("runs `npm install -g jubarteai@<v>` from HOME (no project .npmrc) with node options off and a 180 s limit", async () => {
    stub("npm", 0);
    process.env.NODE_OPTIONS = "--require /tmp/evil.js";
    expect(await installCliVersion("1.4.2")).toEqual({ ok: true });
    const recorded = calls("npm");
    expect(recorded.map((c) => c.argv)).toEqual([["install", "-g", "jubarteai@1.4.2"]]);
    expect(recorded[0]?.cwd).toBe(join(root, "home"));
    expect(recorded[0]?.nodeOptions).toEqual(["", ""]);
    expect(CLI_INSTALL_TIMEOUT_MS).toBe(180_000);
  });

  it("recognises npm's permission error (EACCES) so the caller can print the --prefix hint", async () => {
    stub("npm", 243, "npm error code EACCES\nnpm error syscall mkdir\n");
    expect(await installCliVersion("1.4.2")).toEqual({ ok: false, eacces: true, timedOut: false, notFound: false });
  });

  it("reports any other npm failure without the permission flag", async () => {
    stub("npm", 1, "npm error code E404\n");
    expect(await installCliVersion("1.4.2")).toEqual({ ok: false, eacces: false, timedOut: false, notFound: false });
  });

  it("reports a missing npm", async () => {
    expect(await installCliVersion("1.4.2")).toEqual({ ok: false, eacces: false, timedOut: false, notFound: true });
  });

  it("never runs npm for a version that isn't semver", async () => {
    stub("npm", 0);
    expect((await installCliVersion("1.0.0 --registry=http://evil")).ok).toBe(false);
    expect(calls("npm")).toEqual([]);
  });

  it("re-execs the jubarteai on PATH with the given arguments and passes its exit code back", async () => {
    stub("jubarteai", 7);
    expect(await reexecCli(["update", "--no-self-update", "--yes"])).toEqual({ started: true, code: 7 });
    expect(calls("jubarteai").map((c) => c.argv)).toEqual([["update", "--no-self-update", "--yes"]]);
  });

  it("says so when there is no jubarteai on PATH", async () => {
    expect(await reexecCli(["update", "--no-self-update"])).toEqual({ started: false, reason: "not-found" });
  });
});
