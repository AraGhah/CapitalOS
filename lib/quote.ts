// Yahoo Finance's chart endpoint: no key, one request per ticker, open/high/low/
// close plus the current quote. It is also what fills prices_daily when no
// Alpha Vantage key is configured.

export interface Bar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface Chart {
  ticker: string;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  bars: Bar[];
}

interface YahooChart {
  chart: {
    error: { description?: string } | null;
    result?: Array<{
      meta: {
        symbol: string;
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}

export async function fetchChart(ticker: string, range = "1mo"): Promise<Chart> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${encodeURIComponent(range)}&interval=1d`;

  const res = await fetch(url, {
    headers: { "User-Agent": "CapitalOS/1.0 (personal research desk)", Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Yahoo chart ${res.status} ${res.statusText}`);

  const body = (await res.json()) as YahooChart;
  if (body.chart.error) {
    throw new Error(body.chart.error.description ?? "Yahoo returned an error");
  }

  const result = body.chart.result?.[0];
  if (!result) throw new Error(`no chart data for ${ticker}`);

  const quote = result.indicators.quote?.[0] ?? {};
  const stamps = result.timestamp ?? [];

  // Yahoo pads the arrays with nulls for sessions it has no data for. A bar with
  // no close is dropped rather than carried forward as a flat line.
  const bars: Bar[] = stamps
    .map((stamp, i) => ({
      date: new Date(stamp * 1000).toISOString().slice(0, 10),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close: quote.close?.[i] ?? null,
      volume: quote.volume?.[i] ?? null,
    }))
    .filter((bar) => bar.close !== null);

  const price = result.meta.regularMarketPrice ?? bars.at(-1)?.close ?? null;
  const previousClose =
    result.meta.chartPreviousClose ?? result.meta.previousClose ?? bars.at(-2)?.close ?? null;

  return {
    ticker: result.meta.symbol ?? ticker.toUpperCase(),
    currency: result.meta.currency ?? null,
    price,
    previousClose,
    changePct:
      price !== null && previousClose ? ((price - previousClose) / previousClose) * 100 : null,
    bars,
  };
}
