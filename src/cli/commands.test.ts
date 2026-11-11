import { describe, expect, it } from "vitest";

import { COMMANDS } from "./commands.js";

describe("COMMANDS", () => {
  it("is an array whose entries (when later tasks add them) have unique names and a valid group", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(["account", "tools", "setup", "internal"]).toContain(command.group);
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
