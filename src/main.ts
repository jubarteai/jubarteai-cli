import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `jubarteai - command-line interface for JubarteAI

Usage:
  jubarteai [options]

Options:
  --version   Print the version
  --help      Print this help
`;

function readVersion(): string {
  const manifest = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  throw new Error("package.json has no version");
}

export async function main(argv: string[]): Promise<number> {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  process.stderr.write(`Unknown argument: ${first}\nRun "jubarteai --help" for usage.\n`);
  return 2;
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
