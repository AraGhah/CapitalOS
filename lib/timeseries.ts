import { valuationFor } from "./holdings";

export interface SeriesPoint {
  date: string;
  portfolioIndex: number;
  benchmarkIndex: number;
}

// The portfolio's time-weighted index and the benchmark's, both 100 on the
// first day the portfolio held anything, in the account's base currency.
// Money added or taken out moves the value but not the index; see
// lib/valuation.ts and lib/returns.ts.
export async function getPortfolioSeries(accountId: string): Promise<SeriesPoint[]> {
  const v = await valuationFor(accountId);
  return v.series
    .filter((p) => p.benchmarkIndex !== null)
    .map((p) => ({ date: p.date, portfolioIndex: p.portfolioIndex, benchmarkIndex: p.benchmarkIndex as number }));
}
