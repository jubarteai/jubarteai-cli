// "Did you mean …?" for a mistyped command, flag or value: the nearest known name within edit distance 2, and
// nothing when two names tie (a wrong guess is worse than none).

/** Damerau-Levenshtein (adjacent swaps count once) between two short ASCII-ish strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) (d[i] as number[])[0] = i;
  for (let j = 0; j < cols; j += 1) (d[0] as number[])[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((d[i - 1] as number[])[j]! + 1, (d[i] as number[])[j - 1]! + 1, (d[i - 1] as number[])[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, (d[i - 2] as number[])[j - 2]! + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return (d[rows - 1] as number[])[cols - 1] as number;
}

export const MAX_SUGGEST_DISTANCE = 2;

/** The one candidate nearest to `input` within distance 2, or null when none is that close or two are equally near. */
export function suggest(input: string, candidates: readonly string[]): string | null {
  const wanted = input.toLowerCase();
  let best: string | null = null;
  let bestDistance = MAX_SUGGEST_DISTANCE + 1;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && candidate !== best) {
      tied = true;
    }
  }
  return best !== null && bestDistance <= MAX_SUGGEST_DISTANCE && !tied ? best : null;
}
