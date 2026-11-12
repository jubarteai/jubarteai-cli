import { describe, expect, it } from "vitest";

import { AGENT_SESSION_VARS, agentSessionRefusal, agentSessionVar, refuseInAgentSession } from "./agent-session.js";
import { ExitCode, UsageError } from "./errors.js";

describe("agentSessionVar", () => {
  it("names the first agent variable that is set", () => {
    expect(agentSessionVar({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(agentSessionVar({ CODEX_THREAD_ID: "t-1" })).toBe("CODEX_THREAD_ID");
    for (const name of AGENT_SESSION_VARS) expect(agentSessionVar({ [name]: "yes" })).toBe(name);
  });

  it("is null with none of them, or with blank, 0 or false values", () => {
    expect(agentSessionVar({ PATH: "/bin" })).toBeNull();
    expect(agentSessionVar({ CLAUDECODE: "", OPENCODE: "0", GEMINI_CLI: "false", AI_AGENT: "  " })).toBeNull();
  });

  it("a terminal on stdin doesn't clear it: IDE agents run commands in a real pseudo-terminal (R-M1 round 2)", () => {
    const stdin = process.stdin as { isTTY?: boolean };
    const was = stdin.isTTY;
    stdin.isTTY = true;
    try {
      expect(agentSessionVar({ CURSOR_AGENT: "1" })).toBe("CURSOR_AGENT");
      expect(() => refuseInAgentSession("link", { CLAUDECODE: "1" })).toThrow(UsageError);
    } finally {
      stdin.isTTY = was;
    }
  });
});

describe("refuseInAgentSession", () => {
  it("throws a fixed usage error inside an agent session and nothing outside one", () => {
    expect(() => refuseInAgentSession("link", { CLAUDECODE: "1" })).toThrow(UsageError);
    expect(() => refuseInAgentSession("link", {})).not.toThrow();
    const error = agentSessionRefusal("login --with-token");
    expect(error.exitCode).toBe(ExitCode.USAGE);
    expect(error.message).toBe(
      "jubarteai login --with-token changes your JubarteAI account or this repo's workspace, so it needs you, not an agent. Run it yourself in a terminal.",
    );
  });
});
