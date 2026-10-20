import type { TechnicalSnapshot } from "../technicals";
import type { EvidenceItem } from "./evidence";

/* ---------------------------------------------------------------------------
   The technical snapshot as evidence items.

   Every indicator that has a value becomes a numbered item the fact checker
   can test a model's figure against. The readings ("uptrend", "overbought")
   are decided by code from those same figures and carry no number of their
   own: a model that wants to quote a level must cite the item that holds it,
   not a threshold it half remembers.
--------------------------------------------------------------------------- */

type Item = Omit<EvidenceItem, "id">;

const ago = (sessions: number): string => (sessions === 0 ? "on the last session" : `${sessions} sessions ago`);

export function technicalItems(s: TechnicalSnapshot, source: EvidenceItem["source"]): Item[] {
  const items: Item[] = [];
  const add = (label: string, value: number | null, unit: EvidenceItem["unit"]) => {
    if (value !== null && Number.isFinite(value)) items.push({ kind: "technical", label, value, unit, asOf: s.asOf, source });
  };
  const note = (label: string, text: string | null) => {
    if (text) items.push({ kind: "technical", label, text, asOf: s.asOf, source });
  };

  add("10-day exponential moving average (EMA)", s.ema10, "usd");
  add("50-day simple moving average (SMA)", s.sma50, "usd");
  add("200-day simple moving average (SMA)", s.sma200, "usd");
  add("Last close versus the 50-day SMA", s.vsSma50, "ratio");
  add("Last close versus the 200-day SMA", s.vsSma200, "ratio");
  add("Relative strength index, RSI(14)", s.rsi14, "index");

  if (s.macd) {
    add("MACD line, MACD(12,26,9), in price units", s.macd.line, "usd");
    add("MACD signal line, MACD(12,26,9), in price units", s.macd.signal, "usd");
    add("MACD histogram (line minus signal), MACD(12,26,9), in price units", s.macd.histogram, "usd");
  }

  if (s.bollinger) {
    add("Bollinger upper band, Bollinger(20,2)", s.bollinger.upper, "usd");
    add("Bollinger lower band, Bollinger(20,2)", s.bollinger.lower, "usd");
    add("Bollinger %B: where the last close sits between the bands (0% is the lower band, 100% the upper)", s.bollinger.percentB, "ratio");
    add("Bollinger bandwidth: distance between the bands as a share of the middle band", s.bollinger.bandwidth, "ratio");
  }

  add("Average true range, ATR(14)", s.atr14, "usd");
  add("ATR(14) as a share of the last close", s.atrPct, "ratio");
  add("Volume-weighted moving average, VWMA(20)", s.vwma20, "usd");
  add("Last session's volume against the average of the 20 sessions before it", s.volumeRatio, "multiple");

  const r = s.readings;
  note(
    "Trend reading",
    r.trend === null
      ? null
      : r.trend === "uptrend"
        ? "uptrend: the last close is above the 50-day SMA, which is above the 200-day SMA"
        : r.trend === "downtrend"
          ? "downtrend: the last close is below the 50-day SMA, which is below the 200-day SMA"
          : "mixed: the last close, the 50-day SMA and the 200-day SMA are not in a single order"
  );
  note(
    "Moving-average cross",
    s.smaCross
      ? `${s.smaCross.kind} cross: the 50-day SMA crossed ${s.smaCross.kind === "golden" ? "above" : "below"} the 200-day SMA ${ago(s.smaCross.sessionsAgo)}`
      : null
  );
  note("RSI zone", r.rsiZone === null ? null : `${r.rsiZone} by the conventional RSI thresholds`);
  note(
    "MACD reading",
    r.macdMomentum === null
      ? null
      : `${r.macdMomentum}: the histogram is ${r.macdMomentum === "bullish" ? "above" : "below"} zero${r.macdSlope ? ` and ${r.macdSlope}` : ""}`
  );
  note(
    "MACD cross",
    s.macdCross ? `${s.macdCross.kind} cross: the MACD line crossed ${s.macdCross.kind === "bullish" ? "above" : "below"} its signal line ${ago(s.macdCross.sessionsAgo)}` : null
  );
  note("Bollinger position", r.bandPosition === null ? null : `the last close is in the ${r.bandPosition}`);

  return items;
}
