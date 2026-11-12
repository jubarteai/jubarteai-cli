// Prints the CHANGELOG.md section for one version ("## 1.0.0" up to the next "## "), for the GitHub Release notes.
// Usage: node scripts/changelog-section.mjs <version> [path/to/CHANGELOG.md]
// Exits 1 (printing nothing) when the version has no section or its section is empty.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The body of the `## <version>` section, trimmed, or null when there is none (or it is empty). */
export function changelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) {
    console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]");
    process.exit(1);
  }
  const section = changelogSection(readFileSync(process.argv[3] ?? "CHANGELOG.md", "utf8"), version);
  if (section === null) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
