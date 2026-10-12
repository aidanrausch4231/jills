const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/** Shared words (3+ letters, lowercase) divided by the word count of the shorter text; 0 when either has none. */
export function wordOverlap(a: string, b: string): number {
  const [x, y] = [words(a), words(b)];
  const min = Math.min(x.size, y.size);
  if (!min) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / min;
}
