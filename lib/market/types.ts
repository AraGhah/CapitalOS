import type Decimal from "decimal.js";

// Shared by the market-data providers and the code that chooses between them.

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
  // Split-adjusted closes, not adjusted for dividends.
  bars: Bar[];
  // false while the latest bar's session is still trading: its "close" is the
  // price so far, not a close, and must not be stored as one
  lastBarComplete: boolean;
  source: string;
}

export interface Split {
  date: string;
  // new shares per old share: 4 for a 4-for-1 split, 0.1 for a 1-for-10 reverse
  ratio: Decimal;
}

export interface Dividend {
  exDate: string;
  payDate: string | null;
  // cash per share, in the listing's currency, on the share count of its day
  amount: Decimal;
}

export type Range = "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "10y" | "max";

export interface MarketDataProvider {
  readonly name: string;
  readonly licensed: boolean;
  chart(ticker: string, range: Range): Promise<Chart>;
  splits(ticker: string): Promise<Split[]>;
  dividends(ticker: string): Promise<Dividend[]>;
}

export class UnsupportedSymbolError extends Error {
  readonly status = 404;
  constructor(provider: string, symbol: string) {
    super(`${provider} has no data for ${symbol}`);
    this.name = "UnsupportedSymbolError";
  }
}

export class NoMarketDataError extends Error {
  readonly status = 503;
  constructor() {
    super(
      "no licensed market-data provider is configured: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY, " +
        "or set MARKET_DATA_PROVIDER=yahoo to accept unofficial data for personal use"
    );
    this.name = "NoMarketDataError";
  }
}

export function withChange(c: Omit<Chart, "changePct">): Chart {
  return {
    ...c,
    changePct: c.price !== null && c.previousClose ? ((c.price - c.previousClose) / c.previousClose) * 100 : null,
  };
}

export function rangeStart(range: Range, now = new Date()): Date {
  const d = new Date(now);
  const days: Record<Range, number> = {
    "5d": 8,
    "1mo": 35,
    "3mo": 95,
    "6mo": 190,
    "1y": 370,
    "2y": 735,
    "5y": 1830,
    "10y": 3655,
    max: 365 * 40,
  };
  d.setUTCDate(d.getUTCDate() - days[range]);
  return d;
}
