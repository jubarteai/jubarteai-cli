// Turns a vitest JSON report into GitHub notice annotations listing every failed test, a few long annotations instead
// of one per failure: Actions shows at most 10 error annotations per step, and annotations (unlike job logs) can be read
// through the API without admin rights. CI runs it only when the tests failed.
// Usage: node scripts/ci-failure-digest.mjs <vitest-report.json>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_ANNOTATIONS = 10; // notices per step that Actions keeps
const CHUNK = 3500; // characters per annotation message

/** One line per failure: `file > test: first line of the error`. */
export function failureLines(report, root = "") {
  const lines = [];
  const rel = (file) => (root !== "" && file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]+/, "") : file).replaceAll("\\", "/");
  for (const file of report.testResults ?? []) {
    const failed = (file.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failed) {
      const first = String(test.failureMessages?.[0] ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
      lines.push(`${rel(file.name)} > ${test.fullName ?? test.title}: ${first.trim().slice(0, 300)}`);
    }
    // A file that failed before any test ran (an import error, a crash in a hook) has no failed assertion.
    if (failed.length === 0 && file.status === "failed") {
      const first = String(file.message ?? "").split("\n").find((line) => line.trim() !== "") ?? "failed";
      lines.push(`${rel(file.name)}: ${first.trim().slice(0, 300)}`);
    }
  }
  return lines;
}

/** Workflow-command escaping for a message: %, CR and LF. */
const escape = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function annotations(lines) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current !== "" && current.length + line.length + 1 > CHUNK) {
      chunks.push(current);
      current = "";
    }
    current += (current === "" ? "" : "\n") + line;
  }
  if (current !== "") chunks.push(current);
  const kept = chunks.slice(0, MAX_ANNOTATIONS);
  return kept.map((chunk, i) => `::notice title=Failed tests (${i + 1}/${kept.length}, ${lines.length} in all)::${escape(chunk)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.log(`::notice title=Failed tests::no readable vitest report at ${file}`);
    process.exit(0);
  }
  const lines = failureLines(report, process.cwd());
  for (const line of annotations(lines)) console.log(line);
}
