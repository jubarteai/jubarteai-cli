// I6: an adapter never writes a file itself. Every change is a PlanStep that goes through the safe-edit layer, so no
// non-test file in src/harness/ may import a node:fs API that writes (reads are fine).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITE_API = /^(?:writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|mkdtemp|copyFile|cp|symlink|link|chmod|chown|truncate|ftruncate|createWriteStream|write|writev)(?:Sync)?$/;
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

type Offence = { file: string; what: string };

/** The write APIs a source text pulls from node:fs, by named import, namespace/default binding, or require. */
export function fsWriteUses(file: string, source: string): Offence[] {
  const offences: Offence[] = [];
  const namespaces: string[] = [];
  const importRe = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(importRe)) {
    if (m[1] !== undefined || !FS_MODULES.has(m[3] as string)) continue;
    const clause = m[2] as string;
    const named = /\{([^}]*)\}/.exec(clause);
    if (named !== null) {
      for (const part of (named[1] as string).split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
        if (WRITE_API.test(name)) offences.push({ file, what: `imports ${name}` });
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    for (const token of rest.split(/\s+/)) {
      const ns = /^\*\s*as$/.test(token) ? "" : token.replace(/^\*$/, "");
      if (ns !== "" && ns !== "as") namespaces.push(ns);
    }
  }
  for (const m of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (FS_MODULES.has(m[2] as string)) namespaces.push(m[1] as string);
  }
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!FS_MODULES.has(m[2] as string)) continue;
    for (const part of (m[1] as string).split(",")) {
      const name = part.trim().split(":")[0]?.trim() ?? "";
      if (WRITE_API.test(name)) offences.push({ file, what: `requires ${name}` });
    }
  }
  for (const ns of namespaces) {
    for (const m of source.matchAll(new RegExp(`\\b${ns}\\.(?:promises\\.)?(\\w+)`, "g"))) {
      if (WRITE_API.test(m[1] as string)) offences.push({ file, what: `${ns}.${m[1] as string}` });
    }
  }
  return offences;
}

describe("src/harness never writes files directly (I6)", () => {
  const sources = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("finds the adapter sources it is meant to police", () => {
    expect(sources).toEqual(expect.arrayContaining(["claude-code.ts", "codex.ts", "mcp-cleanup.ts", "registry.ts", "detect.ts"]));
  });

  it.each(sources)("%s imports no node:fs write API", (file) => {
    expect(fsWriteUses(file, readFileSync(join(HERE, file), "utf8"))).toEqual([]);
  });

  describe("the detector itself", () => {
    it("catches named imports, namespace use and require", () => {
      expect(fsWriteUses("a.ts", `import { readFileSync, writeFileSync } from "node:fs";`)).toEqual([{ file: "a.ts", what: "imports writeFileSync" }]);
      expect(fsWriteUses("a.ts", `import * as fs from "node:fs";\nfs.mkdirSync(p);`)).toEqual([{ file: "a.ts", what: "fs.mkdirSync" }]);
      expect(fsWriteUses("a.ts", `import fs from "fs";\nawait fs.promises.rm(p);`)).toEqual([{ file: "a.ts", what: "fs.rm" }]);
      expect(fsWriteUses("a.ts", `import { rename as mv } from "node:fs/promises";`)).toEqual([{ file: "a.ts", what: "imports rename" }]);
      expect(fsWriteUses("a.ts", `const { unlinkSync } = require("fs");`)).toEqual([{ file: "a.ts", what: "requires unlinkSync" }]);
    });

    it("lets reads through", () => {
      expect(fsWriteUses("a.ts", `import * as fs from "node:fs";\nimport { existsSync, readFileSync, statSync } from "node:fs";\nfs.readdirSync(p); fs.existsSync(p);`)).toEqual([]);
    });
  });
});
