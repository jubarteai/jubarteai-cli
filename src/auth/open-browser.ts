import { spawn } from "node:child_process";

import { childEnv } from "../process-env.js";

// Opens the authorize page in the user's browser. `spawn` with an argument array and no shell, so
// nothing in the URL can be interpreted by a command line (a `&` in a query string included), and the
// child never inherits JUBARTEAI_TOKEN (childEnv).

/** How long a launcher that exits non-zero right away still counts as a failure. */
const QUICK_FAILURE_WINDOW_MS = 1500;

function launcher(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // rundll32 is an executable, so the URL stays one argument: cmd.exe's `start` would reparse `&`.
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

/** Only an http(s) URL is ever handed to the system opener (it would otherwise open any scheme or file). */
function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** True when a launcher started and did not fail straight away; false when the caller should print the URL instead. */
export function openBrowser(url: string): Promise<boolean> {
  if (!isWebUrl(url)) return Promise.resolve(false);
  const { command, args } = launcher(process.platform, url);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(opened);
    };
    try {
      const child = spawn(command, args, {
        env: childEnv(),
        stdio: "ignore",
        detached: true,
        shell: false,
        windowsHide: true,
      });
      child.once("error", () => settle(false));
      child.once("exit", (code) => settle(code === 0));
      child.once("spawn", () => {
        child.unref();
        timer = setTimeout(() => settle(true), QUICK_FAILURE_WINDOW_MS);
        timer.unref();
      });
    } catch {
      settle(false);
    }
  });
}
