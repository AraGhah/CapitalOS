// Pure arithmetic on return series. No database, no network, so every number the
// risk engine reports can be reproduced from the closes it was given.

export const TRADING_DAYS = 252;

export function simpleReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (n - 1);
}

export function stdev(xs: number[]): number {
  return Math.sqrt(covariance(xs, xs));
}

export function correlation(a: number[], b: number[]): number | null {
  const sa = stdev(a);
  const sb = stdev(b);
  if (sa === 0 || sb === 0) return null;
  return covariance(a, b) / (sa * sb);
}

// Sensitivity of a to b: how much a moved, on average, per unit move in b.
export function beta(a: number[], b: number[]): number | null {
  const vb = covariance(b, b);
  return vb === 0 ? null : covariance(a, b) / vb;
}

export function annualisedVol(returns: number[]): number {
  return stdev(returns) * Math.sqrt(TRADING_DAYS);
}

// Largest peak-to-trough fall of the value path the returns trace out.
export function maxDrawdown(returns: number[]): number {
  let value = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    value *= 1 + r;
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

export function cumulative(returns: number[]): number {
  return returns.reduce((v, r) => v * (1 + r), 1) - 1;
}

// One-day historical value at risk: the loss exceeded on only (1 - level) of the
// days in the window. Reported as a positive fraction.
export function historicalVaR(returns: number[], level = 0.95): number | null {
  if (returns.length < 20) return null;
  const sorted = [...returns].sort((x, y) => x - y);
  const index = Math.floor((1 - level) * sorted.length);
  return Math.max(0, -sorted[index]);
}

export function weightedSeries(series: number[][], weights: number[]): number[] {
  const n = Math.min(...series.map((s) => s.length));
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    let r = 0;
    for (let i = 0; i < series.length; i++) r += weights[i] * series[i][t];
    out.push(r);
  }
  return out;
}

export function covarianceMatrix(series: number[][]): number[][] {
  return series.map((a) => series.map((b) => covariance(a, b)));
}

// Each position's share of portfolio variance: w_i (Σw)_i / σ²_p. The shares sum
// to one, and a position can take more than its weight's share of the risk.
export function riskContributions(weights: number[], cov: number[][]): number[] {
  const sigmaW = cov.map((row) => row.reduce((s, c, j) => s + c * weights[j], 0));
  const variance = weights.reduce((s, w, i) => s + w * sigmaW[i], 0);
  if (variance <= 0) return weights.map(() => 0);
  return weights.map((w, i) => (w * sigmaW[i]) / variance);
}

// Herfindahl index of the weights, and the number of equal positions that
// would be exactly as concentrated.
export function concentration(weights: number[]): { hhi: number; effectiveN: number } {
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  return { hhi, effectiveN: hhi > 0 ? 1 / hhi : 0 };
}

// Groups positions that move together: any pair correlated above the threshold
// joins one cluster (connected components), so a chain of close relatives is
// reported as the single exposure it really is.
export function correlationClusters(labels: string[], matrix: Array<Array<number | null>>, threshold: number): string[][] {
  const parent = labels.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const c = matrix[i][j];
      if (c !== null && c >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, string[]>();
  labels.forEach((label, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), label]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}
