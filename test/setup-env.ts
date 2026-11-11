import { AGENT_SESSION_VARS } from "../src/agent-session.js";

// The suites often run inside a coding agent's shell, whose variables would make the CLI refuse account changes and
// ignore --yes for sensitive steps (R-M1). Every test starts outside an agent session; a test that needs one sets the
// variable itself. Child processes spawned by the integration tests inherit this cleaned environment.
for (const name of AGENT_SESSION_VARS) delete process.env[name];
