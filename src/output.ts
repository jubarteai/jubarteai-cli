/** Matches a JubarteAI key (`jba_`), CLI login code (`jbc_`) or inbox watch token (`jbw_`). */
const SECRET_PATTERN = /jb[acw]_[A-Za-z0-9_-]+/g;

/** Replaces anything that looks like a key, code or watch token. Applied to every message written to stderr. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

const DISPLAY_LIMIT = 40;

/**
 * A user-typed token made safe to put in a message: secrets redacted, then every control
 * character (C0, DEL, C1 U+0080-U+009F), format character (bidi overrides, zero-width) and
 * line/paragraph separator replaced with "?", then cut to `limit` characters.
 */
export function safeForDisplay(raw: string, limit: number = DISPLAY_LIMIT): string {
  return Array.from(redactSecrets(raw).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?"))
    .slice(0, limit)
    .join("");
}

/** One compact JSON line plus a newline, or 2-space indented with `pretty`. */
export function writeJson(out: NodeJS.WritableStream, value: unknown, opts: { pretty: boolean }): void {
  const text = JSON.stringify(value === undefined ? null : value, null, opts.pretty ? 2 : undefined);
  out.write(`${text}\n`);
}

/** The shape every tool command prints on a transport or auth failure, so an agent always parses one shape. */
export function transportErrorEnvelope(code: string, message: string): { messages: []; error: string; code: string } {
  return { messages: [], error: message, code };
}
