import { describe, expect, it } from "vitest";

import { CliError, ExitCode, UsageError } from "./errors.js";

describe("errors", () => {
  it("pins the exit codes the spec names", () => {
    expect(ExitCode).toEqual({ OK: 0, SERVER_ERROR: 1, USAGE: 2, AUTH: 3, NETWORK: 4, NO_SEAT: 5 });
  });

  it("carries the exit code, message and optional code", () => {
    const error = new CliError("nope", ExitCode.AUTH, "invalid_api_key");
    expect(error).toBeInstanceOf(Error);
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("invalid_api_key");
    expect(error.message).toBe("nope");
    expect(new CliError("x", ExitCode.NETWORK).code).toBeUndefined();
  });

  it("UsageError is a CliError with exit 2", () => {
    const error = new UsageError("bad flag");
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(2);
    expect(error.name).toBe("UsageError");
  });
});
