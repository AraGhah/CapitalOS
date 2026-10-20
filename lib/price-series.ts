import { getPriceHistory } from "./company";
import { fetchChart } from "./quote";
import type { OhlcvBar } from "./technicals";

/* ---------------------------------------------------------------------------
   A year of daily bars for one company: stored bars first, the market-data
   provider when the desk has too few or they are stale. Shared by the
   committee's evidence pack and the technical read, so both are built from the
   same sessions.
--------------------------------------------------------------------------- */

export interface Close {
  date: string;
  close: number;
}

export interface PriceSeries {
  closes: Close[];
  // the same sessions with open, high, low and volume, complete sessions only
  technicalBars: OhlcvBar[];
  source: string;
  ref: string;
}

// Long enough to cover a holiday weekend, short enough that a forgotten price
// job does not leave the committee reading last month's close as "last close".
const STALE_AFTER_DAYS = 5;

const numeric = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// `id` is null for a ticker the desk has not stored; only the provider can be asked then.
export async function priceSeries(company: { id: string | null; ticker: string }): Promise<PriceSeries> {
  const stored = company.id ? await getPriceHistory(company.id, { limit: 260 }) : [];
  const storedBars: OhlcvBar[] = stored.flatMap((b) => {
    const close = numeric(b.close);
    return close === null
      ? []
      : [{ date: b.date, open: numeric(b.open), high: numeric(b.high), low: numeric(b.low), close, volume: numeric(b.volume) }];
  });
  const closes = storedBars.map((b) => ({ date: b.date, close: b.close }));
  const fromStore: PriceSeries = { closes, technicalBars: storedBars, source: "prices_daily", ref: "prices_daily table" };

  // A few stored bars are not a year of history, and a year that ended weeks ago
  // is not today's price; in either case the market-data provider is asked instead.
  const lastStored = closes.at(-1)?.date;
  const fresh = lastStored !== undefined && Date.now() - Date.parse(lastStored) < STALE_AFTER_DAYS * 86_400_000;
  if (closes.length >= 60 && fresh) return fromStore;

  try {
    const chart = await fetchChart(company.ticker, "1y");
    const liveBars: OhlcvBar[] = chart.bars.flatMap((b) =>
      b.close === null ? [] : [{ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }]
    );
    const live = liveBars.map((b) => ({ date: b.date, close: b.close }));
    const newer = (live.at(-1)?.date ?? "") > (lastStored ?? "");
    if (live.length > closes.length || (newer && live.length >= 60)) {
      return {
        closes: live,
        technicalBars: chart.lastBarComplete ? liveBars : liveBars.slice(0, -1),
        source: chart.source,
        ref: `${chart.source} daily closes, 1 year`,
      };
    }
  } catch {
    // unreachable — whatever is stored will have to do
  }
  return fromStore;
}
