import { findCompany, getPriceHistory } from "../company";
import { fetchChart } from "../quote";

/* ---------------------------------------------------------------------------
   A year of daily bars for any symbol, shared by the risk engine, the market
   overview and the scanner. Yahoo is asked first because a risk or momentum
   figure on stale prices is worse than none; stored bars are the fallback.
   Kept for half an hour, so a page reload does not refetch a dozen charts.
--------------------------------------------------------------------------- */

export interface Bar {
  date: string;
  close: number;
  volume: number | null;
}

export interface Loaded {
  bars: Bar[];
  source: string;
}

const CACHE_MS = 30 * 60_000;
const MIN_BARS = 60;
const MAX_CACHED = 400;
const cache = new Map<string, { at: number; loaded: Loaded | null }>();

// range is Yahoo's: "1y" for risk and momentum, "10y" for a backtest.
export async function loadBars(ticker: string, range: "1y" | "5y" | "10y" = "1y"): Promise<Loaded | null> {
  const key = `${ticker}|${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.loaded;

  let loaded: Loaded | null = null;
  try {
    const chart = await fetchChart(ticker, range);
    const bars = chart.bars
      .filter((b) => b.close !== null && b.close > 0)
      .map((b) => ({ date: b.date, close: b.close as number, volume: b.volume }));
    if (bars.length >= MIN_BARS) loaded = { bars, source: `Yahoo Finance daily chart, ${range}` };
  } catch {
    // fall through to stored bars
  }

  if (!loaded) {
    const company = await findCompany(ticker).catch(() => null);
    if (company) {
      const stored = await getPriceHistory(company.id, { limit: range === "1y" ? 260 : 2600 });
      const bars = stored
        .filter((b) => b.close !== null)
        .map((b) => ({ date: b.date, close: Number(b.close), volume: b.volume === null ? null : Number(b.volume) }));
      if (bars.length >= MIN_BARS) loaded = { bars, source: "prices_daily table" };
    }
  }

  // What-if baskets can name any ticker, so the cache is bounded: the oldest
  // entry goes once it is full (a Map iterates in insertion order).
  cache.delete(key);
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), loaded });
  return loaded;
}

// Only the dates every series has, so returns are always compared day for day.
export function aligned(series: Bar[][]): { dates: string[]; closes: number[][] } {
  const maps = series.map((bars) => new Map(bars.map((b) => [b.date, b.close])));
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, closes: maps.map((m) => dates.map((d) => m.get(d) as number)) };
}

export interface Momentum {
  last: number;
  asOf: string;
  day: number | null;
  month: number | null;
  quarter: number | null;
  ytd: number | null;
  year: number | null;
  belowHigh: number;
  sma50: number | null;
  sma200: number | null;
  aboveSma200: boolean | null;
}

// Pure, over bars oldest first.
export function momentum(bars: Bar[]): Momentum {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const back = (n: number) => (closes.length > n ? last / closes[closes.length - 1 - n] - 1 : null);
  const sma = (n: number) => (closes.length >= n ? closes.slice(-n).reduce((s, c) => s + c, 0) / n : null);

  const asOf = bars[bars.length - 1].date;
  const yearStart = bars.findIndex((b) => b.date.slice(0, 4) === asOf.slice(0, 4));
  // YTD runs from the last close of the prior year, when the window reaches it.
  const base = yearStart > 0 ? closes[yearStart - 1] : null;

  const sma200 = sma(200);
  return {
    last,
    asOf,
    day: back(1),
    month: back(21),
    quarter: back(63),
    ytd: base ? last / base - 1 : null,
    year: closes.length > 1 ? last / closes[0] - 1 : null,
    belowHigh: last / Math.max(...closes) - 1,
    sma50: sma(50),
    sma200,
    aboveSma200: sma200 === null ? null : last > sma200,
  };
}
