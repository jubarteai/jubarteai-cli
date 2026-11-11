export const ExitCode = {
  OK: 0,
  SERVER_ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  NO_SEAT: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An expected failure. The message is fixed user-facing copy: it is printed to
 * stderr as is (after secret redaction), so never build it from a response
 * body, a header or a key.
 */
export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly code?: string;

  constructor(message: string, exitCode: ExitCodeValue, code?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    if (code !== undefined) this.code = code;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, ExitCode.USAGE, "usage");
    this.name = "UsageError";
  }
}
