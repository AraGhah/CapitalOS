import Decimal from "decimal.js";
import { UnsupportedSymbolError, withChange, type Bar, type Chart, type Dividend, type MarketDataProvider, type Range, type Split } from "../types";

/* ---------------------------------------------------------------------------
   Yahoo Finance's chart endpoint — undocumented and unlicensed. Development
   only; see lib/market/data.ts for when it is used.
--------------------------------------------------------------------------- */

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
        currentTradingPeriod?: { regular?: { start?: number; end?: number } };
      };
      timestamp?: number[];
      events?: {
        splits?: Record<string, { date: number; numerator: number; denominator: number }>;
        dividends?: Record<string, { date: number; amount: number }>;
      };
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

const HEADERS = { "User-Agent": "CapitalOS/1.0 (personal research desk)", Accept: "application/json" };

async function get(ticker: string, query: string): Promise<NonNullable<YahooChart["chart"]["result"]>[number]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (res.status === 404) throw new UnsupportedSymbolError("Yahoo", ticker);
  if (!res.ok) throw new Error(`Yahoo chart ${res.status} ${res.statusText}`);
  const body = (await res.json()) as YahooChart;
  if (body.chart.error) throw new Error(body.chart.error.description ?? "Yahoo returned an error");
  const result = body.chart.result?.[0];
  if (!result) throw new UnsupportedSymbolError("Yahoo", ticker);
  return result;
}

export const yahoo: MarketDataProvider = {
  name: "yahoo",
  licensed: false,

  async chart(ticker: string, range: Range): Promise<Chart> {
    const result = await get(ticker, `range=${encodeURIComponent(range)}&interval=1d`);
    const quote = result.indicators.quote?.[0] ?? {};
    const stamps = result.timestamp ?? [];

    // Yahoo pads the arrays with nulls for sessions it has no data for. A bar
    // with no close is dropped rather than carried forward as a flat line.
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
    // chartPreviousClose is the close before the first bar of the requested
    // range, not yesterday's close; the previous session is the bar before the
    // latest one.
    const previousClose =
      result.meta.previousClose ?? (bars.length >= 2 ? bars[bars.length - 2].close : null) ?? result.meta.chartPreviousClose ?? null;

    const session = result.meta.currentTradingPeriod?.regular;
    const lastBar = bars.at(-1);
    const sessionDate = session?.start ? new Date(session.start * 1000).toISOString().slice(0, 10) : null;
    const lastBarComplete = !(lastBar && session?.end && sessionDate === lastBar.date && Date.now() < session.end * 1000);

    return withChange({
      ticker: result.meta.symbol ?? ticker.toUpperCase(),
      currency: result.meta.currency ?? null,
      price,
      previousClose,
      bars,
      lastBarComplete,
      source: "yahoo",
    });
  },

  async splits(ticker: string): Promise<Split[]> {
    const result = await get(ticker, "range=max&interval=1mo&events=split");
    return Object.values(result.events?.splits ?? {})
      .filter((s) => s.numerator > 0 && s.denominator > 0)
      .map((s) => ({ date: new Date(s.date * 1000).toISOString().slice(0, 10), ratio: new Decimal(s.numerator).div(s.denominator) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  async dividends(ticker: string): Promise<Dividend[]> {
    const result = await get(ticker, "range=max&interval=1mo&events=div");
    return Object.values(result.events?.dividends ?? {})
      .filter((d) => d.amount > 0)
      .map((d) => ({ exDate: new Date(d.date * 1000).toISOString().slice(0, 10), payDate: null, amount: new Decimal(d.amount) }))
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  },
};
