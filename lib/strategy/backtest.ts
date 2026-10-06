import Decimal from "decimal.js";
import { pool } from "../db";
import { deriveMetrics, type PeriodFacts } from "../metrics";
import { capitalisationShares } from "../edgar";
import { loadBars, type Bar } from "../market/bars";
import { METRICS, passes, type MetricKey, type ScreenRule } from "../scanner";
import { annualisedVol, maxDrawdown, mean, TRADING_DAYS } from "../risk/stats";

/* ---------------------------------------------------------------------------
   The backtesting lab.

   A strategy is a screen (the scanner's rules), a ranking, a position limit and
   a rebalance calendar. It is replayed day by day over up to ten years of
   prices, and on each rebalance date it may only see what was knowable then:
   a company's annual figures count from the day the 10-K reporting them was
   filed, not from the period they describe, and a restatement counts from the
   day it was filed. Every trade pays commission and slippage.

   What it cannot fix is recorded with the result rather than hidden: the
   universe is the companies on the desk today, which is survivorship bias, and
   prices are split-adjusted closes without dividends.
--------------------------------------------------------------------------- */

export type Rebalance = "monthly" | "quarterly" | "annual";

export interface StrategySpec {
  name: string;
  rules: ScreenRule[];
  rankBy: MetricKey;
  rankDescending: boolean;
  maxPositions: number;
  rebalance: Rebalance;
  costBps: number;
  slippageBps: number;
  years: number;
  // null: every company on the desk with annual filings
  universe: string[] | null;
}

// The scanner's metrics that can be known on a past date. The sector score is
// recomputed across today's universe, so it cannot be replayed honestly.
export const BACKTEST_METRICS: MetricKey[] = (Object.keys(METRICS) as MetricKey[]).filter((k) => k !== "score");

export const PRESETS: StrategySpec[] = [
  {
    name: "Quality compounders, rebalanced yearly",
    rules: [
      { metric: "revenue_growth", op: ">=", value: 0.1 },
      { metric: "fcf_margin", op: ">=", value: 0.15 },
      { metric: "roic", op: ">=", value: 0.15 },
    ],
    rankBy: "roic",
    rankDescending: true,
    maxPositions: 5,
    rebalance: "annual",
    costBps: 5,
    slippageBps: 10,
    years: 10,
    universe: null,
  },
  {
    name: "Momentum rotation, top 3 monthly",
    rules: [{ metric: "above_sma200", op: ">=", value: 1 }],
    rankBy: "return_3m",
    rankDescending: true,
    maxPositions: 3,
    rebalance: "monthly",
    costBps: 5,
    slippageBps: 10,
    years: 10,
    universe: null,
  },
  {
    name: "Beaten-down quality, quarterly",
    rules: [
      { metric: "below_high", op: "<=", value: -0.15 },
      { metric: "revenue_growth", op: ">", value: 0 },
      { metric: "fcf_margin", op: ">=", value: 0.1 },
    ],
    rankBy: "below_high",
    rankDescending: false,
    maxPositions: 4,
    rebalance: "quarterly",
    costBps: 5,
    slippageBps: 10,
    years: 10,
    universe: null,
  },
];

export interface Trade {
  ticker: string;
  entered: string;
  exited: string | null;
  entryPrice: number;
  exitPrice: number;
  return: number;
}

export interface BacktestResult {
  spec: StrategySpec;
  start: string;
  end: string;
  sessions: number;
  equity: Array<{ date: string; strategy: number; benchmark: number }>;
  stats: {
    totalReturn: number;
    cagr: number;
    benchmarkReturn: number;
    benchmarkCagr: number;
    vol: number;
    benchmarkVol: number;
    sharpe: number | null;
    maxDrawdown: number;
    benchmarkDrawdown: number;
    winRate: number | null;
    trades: number;
    invested: number;
    turnover: number;
    // average share of the portfolio paid away in commission and slippage per year
    costDrag: number;
  };
  years: Array<{ year: string; strategy: number; benchmark: number }>;
  regimes: Array<{ regime: string; days: number; strategy: number; benchmark: number }>;
  rebalances: Array<{ date: string; holdings: string[]; candidates: number }>;
  trades: Trade[];
  warnings: string[];
}

/* ------------------------------------------------------- point in time */

interface FactRow {
  metric: string;
  periodEnd: string;
  value: Decimal;
  knownFrom: string;
}

// A filing is knowable from the day it was filed. A fact with no filing on
// record is treated as knowable 90 days after its period ended — later than
// most 10-Ks arrive, so the guess errs towards not peeking.
async function annualFacts(companyIds: string[]): Promise<Map<string, FactRow[]>> {
  const { rows } = await pool.query(
    `SELECT f.company_id, f.metric, f.period_end, f.value,
            COALESCE(fl.filed_at, f.period_end + 90) AS known_from
     FROM fundamentals f
     LEFT JOIN filings fl ON fl.id = f.filing_id
     WHERE f.company_id = ANY($1) AND f.fiscal_period = 'FY' AND f.value IS NOT NULL
     ORDER BY known_from`,
    [companyIds]
  );
  const out = new Map<string, FactRow[]>();
  for (const r of rows) {
    const list = out.get(r.company_id) ?? [];
    list.push({
      metric: r.metric,
      periodEnd: (r.period_end as Date).toISOString().slice(0, 10),
      value: new Decimal(r.value),
      knownFrom: (r.known_from as Date).toISOString().slice(0, 10),
    });
    out.set(r.company_id, list);
  }
  return out;
}

// The annual periods as they stood on a date: for each metric and period, the
// most recently filed value that had been filed by then.
export function periodsAsOf(facts: FactRow[], date: string): PeriodFacts[] {
  const byPeriod = new Map<string, Map<string, Decimal>>();
  for (const f of facts) {
    if (f.knownFrom > date) break; // sorted by knownFrom
    const period = byPeriod.get(f.periodEnd) ?? new Map<string, Decimal>();
    period.set(f.metric, f.value); // later filings overwrite: restatements win
    byPeriod.set(f.periodEnd, period);
  }
  return [...byPeriod.entries()]
    .map(([periodEnd, values]) => ({ periodEnd, values }))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

function priceMetrics(bars: Bar[], upto: number): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  const last = bars[upto].close;
  const back = (n: number) => (upto - n >= 0 ? last / bars[upto - n].close - 1 : undefined);
  const r1 = back(21);
  const r3 = back(63);
  const r12 = back(252);
  if (r1 !== undefined) out.return_1m = r1;
  if (r3 !== undefined) out.return_3m = r3;
  if (r12 !== undefined) out.return_1y = r12;
  const window = bars.slice(Math.max(0, upto - 251), upto + 1).map((b) => b.close);
  out.below_high = last / Math.max(...window) - 1;
  if (upto >= 199) {
    const sma = bars.slice(upto - 199, upto + 1).reduce((s, b) => s + b.close, 0) / 200;
    out.above_sma200 = last > sma ? 1 : 0;
  }
  return out;
}

function metricsAsOf(facts: FactRow[] | undefined, bars: Bar[], upto: number, date: string): Partial<Record<MetricKey, number>> {
  const out = priceMetrics(bars, upto);
  if (!facts) return out;
  const periods = periodsAsOf(facts, date);
  if (periods.length === 0) return out;

  const [current, prior] = periods;
  const price = bars[upto].close;
  const shares = capitalisationShares(current.values);
  const marketCap = shares && shares.gt(0) ? shares.mul(price) : null;

  for (const [key, value] of deriveMetrics({ current, prior, marketCap })) {
    if ((BACKTEST_METRICS as string[]).includes(key)) out[key as MetricKey] = value.toNumber();
  }
  if (marketCap) {
    const income = current.values.get("net_income");
    const revenue = current.values.get("revenue");
    const ocf = current.values.get("operating_cash_flow");
    const capex = current.values.get("capex") ?? new Decimal(0);
    if (income && income.gt(0)) out.pe = marketCap.div(income).toNumber();
    if (revenue && revenue.gt(0)) out.ps = marketCap.div(revenue).toNumber();
    if (ocf) out.fcf_yield = ocf.sub(capex).div(marketCap).toNumber();
  }
  return out;
}

/* ------------------------------------------------------------ calendar */

function isRebalanceDay(prev: string | undefined, date: string, every: Rebalance): boolean {
  if (!prev) return true;
  const [py, pm] = [Number(prev.slice(0, 4)), Number(prev.slice(5, 7))];
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  if (every === "annual") return y !== py;
  if (every === "quarterly") return y !== py || Math.floor((m - 1) / 3) !== Math.floor((pm - 1) / 3);
  return y !== py || m !== pm;
}

/* ----------------------------------------------------------------- run */

export async function runBacktest(spec: StrategySpec): Promise<BacktestResult> {
  const warnings: string[] = [
    "The universe is today's companies on the desk, so companies that failed or were delisted are missing — survivorship bias flatters the result.",
    "Prices are split-adjusted closes without dividends, for the strategy and the benchmark alike.",
  ];

  const { rows: companies } = await pool.query(
    `SELECT c.id, c.ticker FROM companies c
     WHERE c.active AND EXISTS (SELECT 1 FROM fundamentals f WHERE f.company_id = c.id AND f.fiscal_period = 'FY')
       AND ($1::text[] IS NULL OR c.ticker = ANY($1))
     ORDER BY c.ticker`,
    [spec.universe?.length ? spec.universe.map((t) => t.toUpperCase()) : null]
  );
  if (companies.length === 0) throw new Error("no company in the universe has annual filings on the desk");

  const range = spec.years > 5 ? "10y" : "5y";
  const [spy, ...loaded] = await Promise.all([loadBars("SPY", range), ...companies.map((c) => loadBars(c.ticker, range))]);
  if (!spy) throw new Error("no benchmark prices could be loaded for SPY");

  const facts = await annualFacts(companies.map((c) => c.id));
  const universe = companies
    .map((c, i) => ({ id: c.id as string, ticker: c.ticker as string, bars: loaded[i]?.bars ?? null }))
    .filter((c) => {
      if (c.bars) return true;
      warnings.push(`${c.ticker}: no price history, left out`);
      return false;
    }) as Array<{ id: string; ticker: string; bars: Bar[] }>;

  // Each company's bars indexed by date, and a cursor into them per day.
  const index = universe.map((c) => new Map(c.bars.map((b, i) => [b.date, i])));
  const tickerIndex = new Map(universe.map((c, u) => [c.ticker, u]));
  const startCut = new Date(Date.now() - spec.years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  // A year of warm-up so momentum, 52-week highs and the 200-day average exist
  // on the first rebalance.
  const calendar = spy.bars.map((b) => b.date).filter((d) => d >= startCut);
  const spyIndex = new Map(spy.bars.map((b, i) => [b.date, i]));
  const firstUsable = calendar.findIndex((d) => (spyIndex.get(d) ?? 0) >= 252);
  const days = calendar.slice(Math.max(0, firstUsable));
  if (days.length < 60) throw new Error("not enough shared price history to run this backtest");
  if (firstUsable > 0) warnings.push(`The first ${firstUsable} sessions were used to warm up momentum and trend measures.`);

  const bps = (spec.costBps + spec.slippageBps) / 10_000;
  const holdings = new Map<string, number>(); // ticker → dollars
  // The last close each holding was marked at. A day with no bar for a holding
  // leaves it at that mark, and the next bar moves it from there, so a gap in a
  // series delays a return rather than losing it.
  const marks = new Map<string, number>();
  const openTrades = new Map<string, { entered: string; entryPrice: number }>();
  const trades: Trade[] = [];
  const rebalances: BacktestResult["rebalances"] = [];

  let cash = 1;
  let costDrag = 0;
  let turnover = 0;
  let investedDays = 0;
  const equity: BacktestResult["equity"] = [];
  const spyStart = spy.bars[spyIndex.get(days[0]) as number].close;

  const priceOn = (u: number, date: string): number | null => {
    const i = index[u].get(date);
    return i === undefined ? null : universe[u].bars[i].close;
  };

  let prevDate: string | undefined;
  for (const date of days) {
    // 1. the day's moves
    if (prevDate) {
      for (const [ticker, dollars] of holdings) {
        const u = tickerIndex.get(ticker) as number;
        const today = priceOn(u, date);
        const before = marks.get(ticker) ?? null;
        if (today !== null && before !== null) {
          holdings.set(ticker, (dollars * today) / before);
          marks.set(ticker, today);
        }
      }
    }
    let value = cash + [...holdings.values()].reduce((s, v) => s + v, 0);

    // 2. rebalance, seeing only what was known on this date
    if (isRebalanceDay(prevDate, date, spec.rebalance)) {
      const candidates = universe
        .map((c, u) => {
          const i = index[u].get(date);
          if (i === undefined || i < 21) return null;
          const metrics = metricsAsOf(facts.get(c.id), c.bars, i, date);
          const ok = spec.rules.every((r) => metrics[r.metric] !== undefined && passes(r, metrics[r.metric] as number));
          const rank = metrics[spec.rankBy];
          return ok && rank !== undefined ? { ticker: c.ticker, rank, price: c.bars[i].close } : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => (spec.rankDescending ? b.rank - a.rank : a.rank - b.rank));

      const chosen = candidates.slice(0, spec.maxPositions);
      const target = new Map(chosen.map((c) => [c.ticker, value / Math.max(1, chosen.length)]));

      let traded = 0;
      for (const ticker of new Set([...holdings.keys(), ...target.keys()])) {
        traded += Math.abs((target.get(ticker) ?? 0) - (holdings.get(ticker) ?? 0));
      }
      const cost = traded * bps;
      costDrag += cost / Math.max(value, 1e-9);
      turnover += traded / Math.max(value, 1e-9);
      value -= cost;

      // close trades no longer held, open new ones
      for (const [ticker, open] of openTrades) {
        if (target.has(ticker)) continue;
        const exitPrice = priceOn(tickerIndex.get(ticker) as number, date) ?? marks.get(ticker) ?? open.entryPrice;
        trades.push({ ticker, entered: open.entered, exited: date, entryPrice: open.entryPrice, exitPrice, return: exitPrice / open.entryPrice - 1 });
        openTrades.delete(ticker);
      }
      for (const c of chosen) {
        if (!openTrades.has(c.ticker)) openTrades.set(c.ticker, { entered: date, entryPrice: c.price });
      }

      holdings.clear();
      marks.clear();
      const perPosition = chosen.length > 0 ? value / chosen.length : 0;
      for (const c of chosen) {
        holdings.set(c.ticker, perPosition);
        marks.set(c.ticker, c.price);
      }
      cash = chosen.length > 0 ? 0 : value;
      rebalances.push({ date, holdings: chosen.map((c) => c.ticker), candidates: candidates.length });
    }

    if (holdings.size > 0) investedDays++;
    const spyNow = spy.bars[spyIndex.get(date) as number].close;
    equity.push({ date, strategy: value, benchmark: spyNow / spyStart });
    prevDate = date;
  }

  // Positions still open are marked at the last close, so they count as trades.
  const last = days[days.length - 1];
  for (const [ticker, open] of openTrades) {
    const exitPrice = priceOn(tickerIndex.get(ticker) as number, last) ?? marks.get(ticker) ?? open.entryPrice;
    trades.push({ ticker, entered: open.entered, exited: null, entryPrice: open.entryPrice, exitPrice, return: exitPrice / open.entryPrice - 1 });
  }

  return {
    spec,
    start: days[0],
    end: last,
    sessions: days.length,
    equity,
    stats: summarise(equity, trades, investedDays, turnover, costDrag, await averageRiskFree(days[0], last)),
    years: byYear(equity),
    regimes: byRegime(equity, spy.bars, spyIndex),
    rebalances,
    trades,
    warnings,
  };
}

/* --------------------------------------------------------------- stats */

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(values[i] / values[i - 1] - 1);
  return out;
}

function summarise(
  equity: BacktestResult["equity"],
  trades: Trade[],
  investedDays: number,
  turnover: number,
  costDrag: number,
  riskFree: number | null
): BacktestResult["stats"] {
  const s = equity.map((e) => e.strategy);
  const b = equity.map((e) => e.benchmark);
  const years = equity.length / TRADING_DAYS;
  const rs = dailyReturns(s);
  const rb = dailyReturns(b);
  const vol = annualisedVol(rs);
  const cagr = (s[s.length - 1] / s[0]) ** (1 / years) - 1;

  return {
    totalReturn: s[s.length - 1] / s[0] - 1,
    cagr,
    benchmarkReturn: b[b.length - 1] / b[0] - 1,
    benchmarkCagr: (b[b.length - 1] / b[0]) ** (1 / years) - 1,
    vol,
    benchmarkVol: annualisedVol(rb),
    sharpe: vol > 0 ? (mean(rs) * TRADING_DAYS - (riskFree ?? 0)) / vol : null,
    maxDrawdown: maxDrawdown(rs),
    benchmarkDrawdown: maxDrawdown(rb),
    winRate: trades.length ? trades.filter((t) => t.return > 0).length / trades.length : null,
    trades: trades.length,
    invested: investedDays / equity.length,
    turnover: turnover / years,
    costDrag: costDrag / years,
  };
}

function byYear(equity: BacktestResult["equity"]): BacktestResult["years"] {
  const out: BacktestResult["years"] = [];
  let start = equity[0];
  for (let i = 1; i <= equity.length; i++) {
    const cur = equity[i];
    const prev = equity[i - 1];
    if (!cur || cur.date.slice(0, 4) !== prev.date.slice(0, 4)) {
      out.push({ year: prev.date.slice(0, 4), strategy: prev.strategy / start.strategy - 1, benchmark: prev.benchmark / start.benchmark - 1 });
      start = prev;
    }
  }
  return out;
}

// Bull and bear markets, told apart the simple way: whether SPY closed above or
// below its own 200-day average that day.
function byRegime(equity: BacktestResult["equity"], spy: Bar[], spyIndex: Map<string, number>): BacktestResult["regimes"] {
  const acc = { up: { days: 0, s: 1, b: 1 }, down: { days: 0, s: 1, b: 1 } };
  for (let i = 1; i < equity.length; i++) {
    const at = spyIndex.get(equity[i - 1].date) as number;
    if (at < 199) continue;
    const sma = spy.slice(at - 199, at + 1).reduce((s, x) => s + x.close, 0) / 200;
    const bucket = spy[at].close > sma ? acc.up : acc.down;
    bucket.days++;
    bucket.s *= equity[i].strategy / equity[i - 1].strategy;
    bucket.b *= equity[i].benchmark / equity[i - 1].benchmark;
  }
  return [
    { regime: "S&P 500 above its 200-day (bull)", days: acc.up.days, strategy: acc.up.s - 1, benchmark: acc.up.b - 1 },
    { regime: "S&P 500 below its 200-day (bear)", days: acc.down.days, strategy: acc.down.s - 1, benchmark: acc.down.b - 1 },
  ];
}

async function averageRiskFree(start: string, end: string): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `SELECT avg(value)::float AS rate FROM macro_series WHERE series_id = 'DGS2' AND date BETWEEN $1 AND $2 AND value IS NOT NULL`,
      [start, end]
    );
    return rows[0].rate === null ? null : rows[0].rate / 100;
  } catch {
    return null;
  }
}
