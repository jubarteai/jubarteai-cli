import { describe, expect, it } from "vitest";

import { AGENT_SESSION_VARS, agentSessionRefusal, agentSessionVar, refuseInAgentSession } from "./agent-session.js";
import { ExitCode, UsageError } from "./errors.js";

const piped = { isTTY: false };
const terminal = { isTTY: true };

describe("agentSessionVar", () => {
  it("names the first agent variable that is set when stdin is not a terminal", () => {
    expect(agentSessionVar({ CLAUDECODE: "1" }, piped)).toBe("CLAUDECODE");
    expect(agentSessionVar({ CODEX_THREAD_ID: "t-1" }, {})).toBe("CODEX_THREAD_ID");
    for (const name of AGENT_SESSION_VARS) expect(agentSessionVar({ [name]: "yes" }, piped)).toBe(name);
  });

  it("is null with none of them, or with blank, 0 or false values", () => {
    expect(agentSessionVar({ PATH: "/bin" }, piped)).toBeNull();
    expect(agentSessionVar({ CLAUDECODE: "", OPENCODE: "0", GEMINI_CLI: "false", AI_AGENT: "  " }, piped)).toBeNull();
  });

  it("a terminal on stdin means a person typed the command", () => {
    expect(agentSessionVar({ CLAUDECODE: "1" }, terminal)).toBeNull();
  });
});

describe("refuseInAgentSession", () => {
  it("throws a fixed usage error inside an agent session and nothing outside one", () => {
    expect(() => refuseInAgentSession("link", { CLAUDECODE: "1" }, piped)).toThrow(UsageError);
    expect(() => refuseInAgentSession("link", {}, piped)).not.toThrow();
    const error = agentSessionRefusal("login --with-token");
    expect(error.exitCode).toBe(ExitCode.USAGE);
    expect(error.message).toBe(
      "jubarteai login --with-token changes your JubarteAI account or this repo's workspace, so it needs you, not an agent. Run it yourself in a terminal.",
    );
  });
});
