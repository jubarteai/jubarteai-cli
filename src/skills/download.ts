// Downloads one skill file from a short-lived signed Storage URL and verifies it. The URL is another origin
// than the app's, so: no credentials are sent, redirects are refused, the scheme must be https (http only when
// both the URL and the app origin are loopback — local development), and the bytes must match the manifest's
// size and sha256 before anything is written.
import { createHash } from "node:crypto";
import { LOOPBACK_HOSTS, SKILLS_DOWNLOAD_TIMEOUT_MS, cliVersion } from "../constants.js";

export class DownloadError extends Error {
  constructor(readonly code: "bad_url" | "http" | "size" | "digest" | "network") {
    super(code);
    this.name = "DownloadError";
  }
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname) || LOOPBACK_HOSTS.includes(`[${hostname}]`);
}

export type DownloadOptions = {
  size: number;
  sha256: string;
  appOrigin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function downloadVerified(rawUrl: string, opts: DownloadOptions): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DownloadError("bad_url");
  }
  let appHost: string;
  try {
    appHost = new URL(opts.appOrigin).hostname;
  } catch {
    throw new DownloadError("bad_url");
  }
  const secure = url.protocol === "https:";
  const devLoopback = url.protocol === "http:" && isLoopback(url.hostname) && isLoopback(appHost);
  if ((!secure && !devLoopback) || url.username !== "" || url.password !== "") throw new DownloadError("bad_url");

  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      redirect: "error",
      headers: { "User-Agent": `jubarteai-cli/${cliVersion()}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SKILLS_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new DownloadError("network");
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadError("http");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Count while streaming: a server that lies about the size can't make us buffer more than the manifest said.
      if (total > opts.size) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError("size");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError("network");
  }
  if (total !== opts.size) throw new DownloadError("size");
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== opts.sha256) throw new DownloadError("digest");
  return bytes;
}
