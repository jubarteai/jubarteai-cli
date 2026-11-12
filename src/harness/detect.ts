// Which harnesses are installed here (spec §9 "Detect": the binary on PATH, or the harness' own directory).
import { which } from "../install/run.js";
import { homeDir } from "../paths.js";
import { ADAPTERS } from "./registry.js";
import type { DetectEnv, HarnessAdapter } from "./types.js";

/** The real machine: the user's home, this process' environment, PATH lookup without a shell. */
export function defaultDetectEnv(): DetectEnv {
  return {
    home: homeDir(),
    env: process.env,
    platform: process.platform,
    which: (cmd) => which(cmd, process.env),
  };
}

/**
 * The adapters whose harness is present, in registry order. `env` overrides parts of the real machine (tests, or a
 * caller that already resolved some of it). An adapter whose detection throws counts as not present.
 */
export async function detectHarnesses(env: Partial<DetectEnv> = {}): Promise<HarnessAdapter[]> {
  const full: DetectEnv = { ...defaultDetectEnv(), ...env };
  const present = await Promise.all(
    ADAPTERS.map(async (adapter) => {
      try {
        return await adapter.detect(full);
      } catch {
        return false;
      }
    }),
  );
  return ADAPTERS.filter((_, index) => present[index] === true);
}
