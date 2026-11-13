import { AGENT_SESSION_VARS } from "../src/agent-session.js";

// The suites often run inside a coding agent's shell, whose variables would make the CLI refuse account changes and
// ignore --yes for sensitive steps (R-M1). Every test starts outside an agent session; a test that needs one sets the
// variable itself. Child processes spawned by the integration tests inherit this cleaned environment.
for (const name of AGENT_SESSION_VARS) delete process.env[name];

// Per-user folders must follow the home a test sandboxes. On Windows configDir() (and the VS Code, Zed and MCP-cleanup
// lookups) read %APPDATA% before the home, and on Linux $XDG_CONFIG_HOME, so a test that sets only HOME/USERPROFILE
// would read and write the real profile's files (credentials.json among them) and leak them into the next test. Without
// these variables every lookup falls back to <home>/AppData/Roaming or <home>/.config; a test that needs one sets it.
for (const name of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"]) delete process.env[name];

// Windows: os.homedir() reads %USERPROFILE% and ignores HOME, but the suites sandbox the home by setting HOME (the
// POSIX contract the CLI's own code follows through homeDir()). Mirror a HOME write into USERPROFILE so the code under
// test and the test agree on one home; deleting HOME puts the runner's own USERPROFILE back. POSIX is untouched.
if (process.platform === "win32") {
  const original = process.env;
  const runnerProfile = original["USERPROFILE"];
  process.env = new Proxy(original, {
    set(target, key, value) {
      target[key as string] = value as string;
      if (key === "HOME") target["USERPROFILE"] = value as string;
      return true;
    },
    deleteProperty(target, key) {
      delete target[key as string];
      if (key === "HOME") {
        if (runnerProfile === undefined) delete target["USERPROFILE"];
        else target["USERPROFILE"] = runnerProfile;
      }
      return true;
    },
  });
}
