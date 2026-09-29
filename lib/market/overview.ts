import { pool } from "../db";
import { loadBars, momentum, type Momentum } from "./bars";

/* ---------------------------------------------------------------------------
   Market intelligence: what moved, and what kind of market it is.

   The regime is a set of fixed rules over computed figures — trend against
   the 200-day average, relative performance, the VIX level, the yield curve,
   the Fed funds path — each reported with the numbers that decided it. No model
   classifies the market; a model may only describe what these rules found.
--------------------------------------------------------------------------- */

export interface Asset {
  symbol: string;
  label: string;
  group: "Indices" | "Sectors" | "Rates & credit" | "Commodities" | "Currencies" | "Crypto";
}

export const ASSETS: Asset[] = [
  { symbol: "SPY", label: "S&P 500", group: "Indices" },
  { symbol: "QQQ", label: "Nasdaq-100", group: "Indices" },
  { symbol: "DIA", label: "Dow Jones", group: "Indices" },
  { symbol: "IWM", label: "Russell 2000", group: "Indices" },
  { symbol: "^VIX", label: "VIX", group: "Indices" },
  { symbol: "XLK", label: "Technology", group: "Sectors" },
  { symbol: "SOXX", label: "Semiconductors", group: "Sectors" },
  { symbol: "XLC", label: "Communication", group: "Sectors" },
  { symbol: "XLY", label: "Consumer discretionary", group: "Sectors" },
  { symbol: "XLF", label: "Financials", group: "Sectors" },
  { symbol: "XLV", label: "Health care", group: "Sectors" },
  { symbol: "XLI", label: "Industrials", group: "Sectors" },
  { symbol: "XLE", label: "Energy", group: "Sectors" },
  { symbol: "XLB", label: "Materials", group: "Sectors" },
  { symbol: "XLP", label: "Consumer staples", group: "Sectors" },
  { symbol: "XLU", label: "Utilities", group: "Sectors" },
  { symbol: "XLRE", label: "Real estate", group: "Sectors" },
  { symbol: "TLT", label: "20+ year Treasuries", group: "Rates & credit" },
  { symbol: "HYG", label: "High-yield credit", group: "Rates & credit" },
  { symbol: "USO", label: "Crude oil", group: "Commodities" },
  { symbol: "UNG", label: "Natural gas", group: "Commodities" },
  { symbol: "GLD", label: "Gold", group: "Commodities" },
  { symbol: "UUP", label: "US dollar", group: "Currencies" },
  { symbol: "BTC-USD", label: "Bitcoin", group: "Crypto" },
  { symbol: "ETH-USD", label: "Ethereum", group: "Crypto" },
];

// The eleven SPDR sectors; SOXX is an industry inside technology, so it is not
// counted towards breadth.
const BREADTH_SECTORS = ["XLK", "XLC", "XLY", "XLF", "XLV", "XLI", "XLE", "XLB", "XLP", "XLU", "XLRE"];

export interface AssetRow extends Asset {
  m: Momentum | null;
}

export type Stance = "on" | "off" | "neutral";

export interface Signal {
  id: string;
  name: string;
  reading: string;
  stance: Stance;
  basis: string;
}

export interface MacroRow {
  id: string;
  label: string;
  unit: "percent" | "ratio";
  latest: number;
  asOf: string;
  yearAgo: number | null;
  threeMonthsAgo: number | null;
}

export interface MarketOverview {
  asOf: string | null;
  assets: AssetRow[];
  signals: Signal[];
  regime: { label: "Risk-on" | "Risk-off" | "Mixed"; on: number; off: number; neutral: number };
  macro: MacroRow[];
  missing: string[];
}

export async function marketOverview(): Promise<MarketOverview> {
  const loaded = await Promise.all(ASSETS.map((a) => loadBars(a.symbol)));
  const assets: AssetRow[] = ASSETS.map((a, i) => ({ ...a, m: loaded[i] ? momentum(loaded[i]!.bars) : null }));
  const bySymbol = new Map(assets.map((a) => [a.symbol, a.m]));
  const macro = await macroSnapshot();

  const signals = regimeSignals(bySymbol, macro);
  const on = signals.filter((s) => s.stance === "on").length;
  const off = signals.filter((s) => s.stance === "off").length;
  const neutral = signals.length - on - off;

  return {
    asOf: bySymbol.get("SPY")?.asOf ?? null,
    assets,
    signals,
    regime: { label: on - off >= 2 ? "Risk-on" : off - on >= 2 ? "Risk-off" : "Mixed", on, off, neutral },
    macro,
    missing: assets.filter((a) => a.m === null).map((a) => a.symbol),
  };
}

/* ----------------------------------------------------------------- regime */

const p = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

export function regimeSignals(m: Map<string, Momentum | null>, macro: MacroRow[]): Signal[] {
  const out: Signal[] = [];
  const spy = m.get("SPY") ?? null;
  const rel = (sym: string) => {
    const a = m.get(sym)?.quarter;
    const b = spy?.quarter;
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  };

  if (spy && spy.sma200 !== null && spy.sma50 !== null) {
    const up = spy.last > spy.sma200 && spy.sma50 > spy.sma200;
    const down = spy.last < spy.sma200;
    out.push({
      id: "trend",
      name: "Market trend",
      reading: up ? "Uptrend" : down ? "Downtrend" : "Mixed",
      stance: up ? "on" : down ? "off" : "neutral",
      basis: `SPY ${spy.last.toFixed(2)} vs 200-day ${spy.sma200.toFixed(2)}, 50-day ${spy.sma50.toFixed(2)}`,
    });
  }

  const vix = m.get("^VIX");
  if (vix) {
    const level = vix.last;
    out.push({
      id: "volatility",
      name: "Volatility",
      reading: level < 15 ? "Low" : level < 22 ? "Moderate" : level < 30 ? "Elevated" : "High",
      stance: level < 18 ? "on" : level >= 25 ? "off" : "neutral",
      basis: `VIX ${level.toFixed(2)}; 1-month change ${p(vix.month)}`,
    });
  }

  const growth = rel("QQQ");
  const qqq = m.get("QQQ");
  if (growth !== null && qqq) {
    const high = growth > 0.03 && qqq.aboveSma200 === true;
    const low = growth < -0.03 || qqq.aboveSma200 === false;
    out.push({
      id: "growth",
      name: "Growth appetite",
      reading: high ? "High" : low ? "Low" : "Neutral",
      stance: high ? "on" : low ? "off" : "neutral",
      basis: `Nasdaq-100 vs S&P 500 over 3 months: ${p(growth)}; ${qqq.aboveSma200 ? "above" : "below"} its 200-day`,
    });
  }

  const xlk = m.get("XLK");
  if (xlk && xlk.quarter !== null) {
    const strong = xlk.quarter > 0.05 && xlk.aboveSma200 === true;
    const weak = xlk.quarter < -0.05 || xlk.aboveSma200 === false;
    out.push({
      id: "tech",
      name: "Technology momentum",
      reading: strong ? "Strong" : weak ? "Weak" : "Neutral",
      stance: strong ? "on" : weak ? "off" : "neutral",
      basis: `XLK 3 months ${p(xlk.quarter)}; ${xlk.aboveSma200 ? "above" : "below"} its 200-day`,
    });
  }

  const small = rel("IWM");
  if (small !== null) {
    out.push({
      id: "smallcaps",
      name: "Small caps",
      reading: small > 0.02 ? "Leading" : small < -0.02 ? "Lagging" : "In line",
      stance: small > 0.02 ? "on" : small < -0.02 ? "off" : "neutral",
      basis: `Russell 2000 vs S&P 500 over 3 months: ${p(small)}`,
    });
  }

  const defensives = ["XLU", "XLP", "XLV"].map(rel).filter((x): x is number => x !== null);
  if (defensives.length === 3) {
    const d = defensives.reduce((s, x) => s + x, 0) / 3;
    out.push({
      id: "defensives",
      name: "Defensive assets",
      reading: d > 0.02 ? "Leading" : d < -0.02 ? "Lagging" : "Neutral",
      stance: d > 0.02 ? "off" : d < -0.02 ? "on" : "neutral",
      basis: `Utilities, staples and health care vs S&P 500 over 3 months: ${p(d)} on average`,
    });
  }

  const breadth = BREADTH_SECTORS.map((s) => m.get(s)?.aboveSma200).filter((x): x is boolean => x !== null && x !== undefined);
  if (breadth.length >= 8) {
    const above = breadth.filter(Boolean).length;
    const share = above / breadth.length;
    out.push({
      id: "breadth",
      name: "Breadth",
      reading: share >= 0.7 ? "Broad" : share <= 0.4 ? "Narrow" : "Moderate",
      stance: share >= 0.7 ? "on" : share <= 0.4 ? "off" : "neutral",
      basis: `${above} of ${breadth.length} sectors above their 200-day average`,
    });
  }

  const credit = m.get("HYG");
  if (credit && credit.quarter !== null) {
    out.push({
      id: "credit",
      name: "Credit",
      reading: credit.aboveSma200 && credit.quarter >= 0 ? "Calm" : credit.aboveSma200 === false ? "Stressed" : "Neutral",
      stance: credit.aboveSma200 && credit.quarter >= 0 ? "on" : credit.aboveSma200 === false ? "off" : "neutral",
      basis: `High-yield bonds (HYG) 3 months ${p(credit.quarter)}; ${credit.aboveSma200 ? "above" : "below"} 200-day`,
    });
  }

  const fed = macro.find((x) => x.id === "FEDFUNDS");
  const dollar = m.get("UUP");
  if (fed && fed.threeMonthsAgo !== null) {
    const change = fed.latest - fed.threeMonthsAgo;
    const dollarMove = dollar?.quarter ?? 0;
    const easing = change <= -0.2 && dollarMove <= 0.02;
    const tightening = change >= 0.2 || dollarMove > 0.04;
    out.push({
      id: "liquidity",
      name: "Liquidity",
      reading: easing ? "Easing" : tightening ? "Tightening" : "Neutral",
      stance: easing ? "on" : tightening ? "off" : "neutral",
      basis: `Fed funds ${fed.latest.toFixed(2)}% vs ${fed.threeMonthsAgo.toFixed(2)}% three months earlier; dollar 3 months ${p(dollar?.quarter ?? null)}`,
    });
  }

  const curve = macro.find((x) => x.id === "T10Y2Y");
  if (curve) {
    out.push({
      id: "curve",
      name: "Yield curve",
      reading: curve.latest < 0 ? "Inverted" : curve.latest < 0.5 ? "Flat" : "Normal",
      stance: curve.latest < 0 ? "off" : "neutral",
      basis: `10-year minus 2-year: ${curve.latest.toFixed(2)} points (${curve.asOf})`,
    });
  }

  const cpi = macro.find((x) => x.id === "CPI_YOY");
  if (cpi) {
    const v = cpi.latest;
    out.push({
      id: "inflation",
      name: "Inflation",
      reading: v > 0.03 ? "Hot" : v < 0.02 ? "Cool" : "Moderate",
      stance: v > 0.035 ? "off" : "neutral",
      basis: `CPI ${(v * 100).toFixed(1)}% year over year (${cpi.asOf})`,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ macro */

const LEVELS: Record<string, string> = {
  DGS10: "10-year yield",
  DGS2: "2-year yield",
  T10Y2Y: "10y − 2y spread",
  FEDFUNDS: "Fed funds",
  UNRATE: "Unemployment",
};

const GROWTH: Record<string, { id: string; label: string }> = {
  CPIAUCSL: { id: "CPI_YOY", label: "CPI inflation y/y" },
  GDPC1: { id: "GDP_YOY", label: "Real GDP y/y" },
};

export async function macroSnapshot(): Promise<MacroRow[]> {
  let rows: Array<{ series_id: string; date: Date; value: string }>;
  try {
    ({ rows } = await pool.query(
      `SELECT series_id, date, value FROM macro_series
       WHERE series_id = ANY($1) AND value IS NOT NULL AND date >= now() - interval '800 days'
       ORDER BY series_id, date`,
      [[...Object.keys(LEVELS), ...Object.keys(GROWTH)]]
    ));
  } catch {
    return [];
  }

  const bySeries = new Map<string, Array<{ date: string; value: number }>>();
  for (const r of rows) {
    const list = bySeries.get(r.series_id) ?? [];
    list.push({ date: r.date.toISOString().slice(0, 10), value: Number(r.value) });
    bySeries.set(r.series_id, list);
  }

  // The latest observation on or before a date some days back from the last one.
  const before = (list: Array<{ date: string; value: number }>, days: number) => {
    const cutoff = new Date(Date.parse(list[list.length - 1].date) - days * 86_400_000).toISOString().slice(0, 10);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].date <= cutoff) return list[i];
    return null;
  };

  const out: MacroRow[] = [];
  for (const [id, label] of Object.entries(LEVELS)) {
    const list = bySeries.get(id);
    if (!list?.length) continue;
    const last = list[list.length - 1];
    out.push({
      id,
      label,
      unit: "percent",
      latest: last.value,
      asOf: last.date,
      yearAgo: before(list, 365)?.value ?? null,
      threeMonthsAgo: before(list, 90)?.value ?? null,
    });
  }

  for (const [series, spec] of Object.entries(GROWTH)) {
    const list = bySeries.get(series);
    if (!list?.length) continue;
    const yoy = (at: number) => {
      const point = at === 0 ? list[list.length - 1] : before(list, at);
      if (!point) return null;
      const idx = list.indexOf(point);
      const sub = list.slice(0, idx + 1);
      const prior = before(sub, 365);
      return prior && prior.value !== 0 ? point.value / prior.value - 1 : null;
    };
    const latest = yoy(0);
    if (latest === null) continue;
    out.push({
      id: spec.id,
      label: spec.label,
      unit: "ratio",
      latest,
      asOf: list[list.length - 1].date,
      yearAgo: yoy(365),
      threeMonthsAgo: yoy(90),
    });
  }
  return out;
}
