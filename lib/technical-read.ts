import { findCompany } from "./company";
import { priceSeries } from "./price-series";
import { technicalSnapshot, THRESHOLDS, type TechnicalSnapshot } from "./technicals";

/* ---------------------------------------------------------------------------
   The technical read of one ticker, for the research page and the
   MCP server. The committee builds the same figures into its evidence pack
   (lib/ai/technical-items.ts); this is the same snapshot from the same
   sessions, without a committee run.
--------------------------------------------------------------------------- */

export interface TechnicalRead {
  ticker: string;
  snapshot: TechnicalSnapshot | null;
  // where the sessions came from, e.g. "prices_daily table"
  source: string;
  ref: string;
  thresholds: typeof THRESHOLDS;
}

export async function technicalRead(ticker: string): Promise<TechnicalRead> {
  const upper = ticker.trim().toUpperCase();
  // A ticker the desk has never stored can still be read from the provider.
  const company = await findCompany(upper).catch(() => null);
  const series = await priceSeries({ id: company?.id ?? null, ticker: upper });
  return {
    ticker: upper,
    snapshot: technicalSnapshot(series.technicalBars),
    source: series.source,
    ref: series.ref,
    thresholds: THRESHOLDS,
  };
}

// The figures in the shape a tool hands a model: rounded, named, and with the
// reading code drew from them.
export function technicalSummary(read: TechnicalRead) {
  const s = read.snapshot;
  if (!s) return { ticker: read.ticker, available: false, note: "not enough price history to compute indicators" };
  const r = (n: number | null, digits = 2) => (n === null ? null : Number(n.toFixed(digits)));
  return {
    ticker: read.ticker,
    available: true,
    as_of: s.asOf,
    sessions_used: s.sessions,
    last_close: r(s.last),
    moving_averages: { ema_10: r(s.ema10), sma_50: r(s.sma50), sma_200: r(s.sma200), vs_sma_50: r(s.vsSma50, 4), vs_sma_200: r(s.vsSma200, 4) },
    rsi_14: r(s.rsi14, 1),
    macd: s.macd ? { line: r(s.macd.line, 3), signal: r(s.macd.signal, 3), histogram: r(s.macd.histogram, 3) } : null,
    bollinger: s.bollinger
      ? { upper: r(s.bollinger.upper), middle: r(s.bollinger.middle), lower: r(s.bollinger.lower), percent_b: r(s.bollinger.percentB, 3), bandwidth: r(s.bollinger.bandwidth, 4) }
      : null,
    atr_14: r(s.atr14),
    atr_share_of_price: r(s.atrPct, 4),
    vwma_20: r(s.vwma20),
    volume_vs_prior_20_sessions: r(s.volumeRatio),
    readings: { ...s.readings, sma_cross: s.smaCross, macd_cross: s.macdCross },
    source: read.ref,
    note: "Computed by code from daily bars; conventional thresholds, not predictions. Not advice.",
  };
}
