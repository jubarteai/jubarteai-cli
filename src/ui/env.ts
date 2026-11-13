// How a human-facing command should look on a stream. Decided once per stream from the environment, so every
// renderer asks the same question and machine output (tool commands, --json, hooks) never builds a Ui at all.

export type ColorTier = 0 | 4 | 8 | 24;
export type UiMode = { rich: boolean; color: ColorTier; unicode: boolean; animate: boolean; columns: number; verbose: boolean };

type StreamLike = { isTTY?: boolean; columns?: number; getColorDepth?: (env?: NodeJS.ProcessEnv) => number };

const DEFAULT_COLUMNS = 80;

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** FORCE_COLOR as Node reads it: unset → undefined; "" / "true" → 1; "false" / "0" → 0; "1".."3" as is. */
function forceColorLevel(value: string | undefined): 0 | 1 | 2 | 3 | undefined {
  if (value === undefined) return undefined;
  if (value === "" || value === "true") return 1;
  if (value === "false" || value === "0") return 0;
  if (value === "1") return 1;
  if (value === "2") return 2;
  return 3;
}

function utf8Locale(env: NodeJS.ProcessEnv): boolean {
  const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(nonEmpty) ?? "";
  return /utf-?8/i.test(locale);
}

function unicodeSupported(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return nonEmpty(env["WT_SESSION"]) || env["TERM_PROGRAM"] === "vscode" || env["ConEmuANSI"] === "ON";
  return utf8Locale(env);
}

const TIER_FOR_LEVEL: Readonly<Record<1 | 2 | 3, ColorTier>> = { 1: 4, 2: 8, 3: 24 };

/**
 * The look for `stream`, by this precedence: `--plain`; `JUBARTEAI_UI=plain|rich`; a non-empty `NO_COLOR` (read
 * here, not left to the runtime, so Node 22's empty-value quirk doesn't matter); `TERM=dumb`; a stream that isn't
 * a terminal (plain, unless `FORCE_COLOR` ≥ 1 asks for colours, which still never animates); else rich, with the
 * colour depth the terminal reports and `FORCE_COLOR=0` turning colour off.
 */
export function detectUiMode(
  target: object,
  opts: { plain?: boolean; verbose?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): UiMode {
  const stream = target as StreamLike;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isTTY = stream.isTTY === true;
  const verbose = opts.verbose === true;
  const force = forceColorLevel(env["FORCE_COLOR"]);
  const override = env["JUBARTEAI_UI"];

  let rich: boolean;
  if (opts.plain === true) rich = false;
  else if (override === "plain") rich = false;
  else if (override === "rich") rich = true;
  else if (nonEmpty(env["NO_COLOR"])) rich = false;
  else if (env["TERM"] === "dumb") rich = false;
  else if (!isTTY) rich = force !== undefined && force >= 1;
  else rich = true;

  let color: ColorTier = 0;
  if (rich && force !== 0) {
    if (force !== undefined) color = TIER_FOR_LEVEL[force];
    else if (typeof stream.getColorDepth === "function") {
      const depth = stream.getColorDepth(env);
      color = depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 0;
    } else color = 4;
  }
  const columns = typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : DEFAULT_COLUMNS;
  return { rich, color, unicode: unicodeSupported(env, platform), animate: rich && isTTY && !verbose, columns, verbose };
}
