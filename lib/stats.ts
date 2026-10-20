/* ---------------------------------------------------------------------------
   Small statistics shared by the sentiment benchmark and the track record.
   Pure arithmetic: no clock, no database.
--------------------------------------------------------------------------- */

// The Wilson score interval for a share: well behaved at the small counts and
// the extreme proportions that hand-labelled sets and a few settled decisions
// produce, where the usual normal interval runs outside 0..1.
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

// The standard error of the mean, from the sample variance; null below two observations.
export function standardError(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance / n);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
