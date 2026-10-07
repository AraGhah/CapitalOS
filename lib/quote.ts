import { chart, type Chart, type Range } from "./market/data";

// The current quote and daily history for a ticker, from whichever market-data
// provider is configured (lib/market/data.ts).
export type { Bar, Chart } from "./market/data";

export async function fetchChart(ticker: string, range: string = "1mo"): Promise<Chart> {
  return chart(ticker, range as Range);
}
