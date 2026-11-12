// Must match the FLOORS table inlined in bin/jubarteai.js and package.json
// "engines.node" (node-floor.test.ts compares all three).

export const NODE_FLOORS: Readonly<Record<22 | 24 | 26, string>> = { 22: "22.23.5", 24: "24.22.3", 26: "26.13.1" };

export const ENGINES_RANGE = "^22.23.5 || ^24.22.3 || >=26.13.1";

/** The newest LTS line named in NODE_FLOORS; every even major above it is accepted. */
const LAST_LINE = 26;

function parse(version: string): [number, number, number] {
  const parts = version.replace(/^v/, "").split(".");
  return [Number(parts[0]), Number(parts[1]) || 0, Number(parts[2]) || 0];
}

/** The same rule as bin/jubarteai.js: odd majors and majors below 22 are refused, each LTS line needs its floor. */
export function meetsNodeFloor(version: string): boolean {
  const have = parse(version);
  const major = have[0];
  if (!Number.isInteger(major)) return false;
  if (major % 2 !== 0) return false;
  if (major < 22) return false;
  if (major > LAST_LINE) return true;
  const floor = NODE_FLOORS[major as 22 | 24 | 26];
  const want = parse(floor);
  for (let i = 0; i < 3; i++) {
    const a = have[i] as number;
    const b = want[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}
