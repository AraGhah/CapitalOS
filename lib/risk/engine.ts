import { pool } from "../db";
import { ACCOUNT_ID } from "../constants";
import { getPortfolio } from "../holdings";
import { findCompany, getWatchlist } from "../company";
import { aligned, loadBars, type Loaded } from "../market/bars";
import {
  annualisedVol,
  beta,
  concentration,
  correlation,
  correlationClusters,
  covarianceMatrix,
  cumulative,
  historicalVaR,
  maxDrawdown,
  mean,
  riskContributions,
  simpleReturns,
  TRADING_DAYS,
  weightedSeries,
} from "./stats";
import { FACTORS, type ExposureRow, type FactorId } from "./scenarios";

/* ---------------------------------------------------------------------------
   The risk engine. Everything here is arithmetic on a year of daily closes:
   volatility, beta, drawdown, value at risk, correlation, each position's share
   of the risk, and its sensitivity to eight market factors. No model is
   involved, and every figure says which window and which prices it came from.

   It runs on the ledger's open positions, or — before anything is held, or to
   test an idea — on a what-if basket of tickers and weights.
--------------------------------------------------------------------------- */

export interface BasketLine {
  ticker: string;
  weight: number;
  marketValue: number | null;
}

export type Basis = { kind: "holdings" } | { kind: "watchlist" } | { kind: "custom"; text: string };

export interface PositionRisk {
  ticker: string;
  name: string;
  sector: string;
  weight: number;
  marketValue: number | null;
  vol: number | null;
  beta: number | null;
  riskShare: number | null;
  dayChange: number | null;
  dayContribution: number | null;
  avgDollarVolume: number | null;
  daysToExit: number | null;
}

export interface RiskReport {
  basis: "holdings" | "watchlist" | "custom";
  label: string;
  asOf: string | null;
  window: { start: string; end: string; sessions: number } | null;
  positions: PositionRisk[];
  portfolio: {
    vol: number | null;
    beta: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
    var95: number | null;
    return1y: number | null;
    benchmarkReturn1y: number | null;
    avgCorrelation: number | null;
    diversification: number | null;
    effectiveN: number;
    hhi: number;
    topWeight: number;
    dayChange: number | null;
    marketValue: number | null;
  };
  riskFree: { rate: number; source: string } | null;
  correlation: { tickers: string[]; matrix: Array<Array<number | null>> };
  sectors: Array<{ sector: string; weight: number }>;
  factors: Array<{ id: FactorId; portfolioBeta: number | null; explained: number }>;
  exposures: ExposureRow[];
  clusters: Array<{ tickers: string[]; weight: number; avgCorrelation: number }>;
  findings: Array<{ severity: "info" | "warn" | "high"; text: string }>;
  warnings: string[];
  sources: string[];
}

/* ---------------------------------------------------------------- basket */

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const MAX_LINES = 25;

// "NVDA:30, AMD:20, MSFT" — a ticker with no weight counts as one share of the
// total, and the weights are scaled to sum to one.
export function parseBasket(text: string): { lines: Array<{ ticker: string; weight: number }>; errors: string[] } {
  const errors: string[] = [];
  const byTicker = new Map<string, number>();

  for (const raw of text.split(/[,\s;]+/).filter(Boolean)) {
    const [symbol, amount] = raw.split(/[:=@]/);
    const ticker = symbol.trim().toUpperCase();
    if (!TICKER.test(ticker)) {
      errors.push(`"${raw}" is not a ticker`);
      continue;
    }
    const weight = amount === undefined || amount === "" ? 1 : Number(amount.replace("%", ""));
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`"${raw}" has no usable weight`);
      continue;
    }
    byTicker.set(ticker, (byTicker.get(ticker) ?? 0) + weight);
  }

  const total = [...byTicker.values()].reduce((s, w) => s + w, 0);
  const lines = [...byTicker.entries()].slice(0, MAX_LINES).map(([ticker, w]) => ({ ticker, weight: w / total }));
  if (byTicker.size > MAX_LINES) errors.push(`only the first ${MAX_LINES} tickers are used`);
  return { lines, errors };
}

export async function resolveBasket(basis: Basis): Promise<{ label: string; lines: BasketLine[]; warnings: string[] }> {
  if (basis.kind === "holdings") {
    const { holdings } = await getPortfolio(ACCOUNT_ID);
    return {
      label: "Open positions",
      lines: holdings.map((h) => ({ ticker: h.ticker, weight: h.weight.toNumber(), marketValue: h.marketValue.toNumber() })),
      warnings: [],
    };
  }
  if (basis.kind === "watchlist") {
    const watched = await getWatchlist();
    return {
      label: "Watchlist, equal weight",
      lines: watched.map((w) => ({ ticker: w.ticker, weight: 1 / watched.length, marketValue: null })),
      warnings: [],
    };
  }
  const { lines, errors } = parseBasket(basis.text);
  return {
    label: "What-if basket",
    lines: lines.map((l) => ({ ...l, marketValue: null })),
    warnings: errors,
  };
}

/* --------------------------------------------------------------- analysis */

const CLUSTER_CORRELATION = 0.7;
const EXPOSED_R2 = 0.4;
const EXPOSED_BETA = 0.3;
// A position is assumed exitable at a tenth of its average daily dollar volume
// without moving the price much. A convention, stated on the page.
const PARTICIPATION = 0.1;

export async function analyzeRisk(basis: Basis): Promise<RiskReport> {
  const resolved = await resolveBasket(basis);
  const warnings = [...resolved.warnings];
  const empty = emptyReport(basis.kind, resolved.label, warnings);
  if (resolved.lines.length === 0) return empty;

  const factorTickers = FACTORS.map((f) => f.proxy);
  const tickers = [...new Set([...resolved.lines.map((l) => l.ticker), ...factorTickers])];
  const loadedList = await Promise.all(tickers.map((t) => loadBars(t)));
  const loaded = new Map(tickers.map((t, i) => [t, loadedList[i]]));

  // Positions without a year of prices cannot be measured; they are dropped and
  // the rest re-weighted, and the page says so.
  let lines = resolved.lines.filter((l) => {
    if (loaded.get(l.ticker)) return true;
    warnings.push(`${l.ticker}: no price history could be loaded, so it is left out of the risk figures`);
    return false;
  });
  const kept = lines.reduce((s, l) => s + l.weight, 0);
  if (lines.length === 0 || kept <= 0) return { ...empty, warnings };
  if (kept < 0.999) lines = lines.map((l) => ({ ...l, weight: l.weight / kept }));

  const spy = loaded.get("SPY");
  const holdingBars = lines.map((l) => (loaded.get(l.ticker) as Loaded).bars);
  const { dates, closes } = aligned(spy ? [...holdingBars, spy.bars] : holdingBars);
  if (dates.length < 40) {
    warnings.push("fewer than 40 trading days are shared by every position, too few to measure risk");
    return { ...empty, warnings };
  }

  const returns = closes.map(simpleReturns);
  const holdingReturns = returns.slice(0, lines.length);
  const spyReturns = spy ? returns[lines.length] : null;
  const weights = lines.map((l) => l.weight);

  const portfolioReturns = weightedSeries(holdingReturns, weights);
  const vol = annualisedVol(portfolioReturns);
  const cov = covarianceMatrix(holdingReturns);
  const shares = riskContributions(weights, cov);
  const riskFree = await riskFreeRate();

  // correlation among positions
  const matrix = holdingReturns.map((a, i) => holdingReturns.map((b, j) => (i === j ? 1 : correlation(a, b))));
  const pairs: number[] = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (matrix[i][j] !== null) pairs.push(matrix[i][j] as number);

  const individualVols = holdingReturns.map(annualisedVol);
  const weightedVol = individualVols.reduce((s, v, i) => s + v * weights[i], 0);

  // names and sectors
  const meta = await Promise.all(lines.map((l) => findCompany(l.ticker)));

  const positions: PositionRisk[] = lines.map((l, i) => {
    const bars = holdingBars[i];
    const last = bars.at(-1);
    const prior = bars.at(-2);
    const dayChange = last && prior ? last.close / prior.close - 1 : null;
    const recent = bars.slice(-20).filter((b) => b.volume !== null);
    const adv = recent.length >= 10 ? mean(recent.map((b) => b.close * (b.volume as number))) : null;
    return {
      ticker: l.ticker,
      name: meta[i]?.name ?? l.ticker,
      sector: meta[i]?.sector ?? "Unclassified",
      weight: l.weight,
      marketValue: l.marketValue,
      vol: individualVols[i],
      beta: spyReturns ? beta(holdingReturns[i], spyReturns) : null,
      riskShare: shares[i],
      dayChange,
      dayContribution: dayChange === null ? null : dayChange * l.weight,
      avgDollarVolume: adv,
      daysToExit: adv && l.marketValue !== null ? l.marketValue / (adv * PARTICIPATION) : null,
    };
  });

  // factor sensitivities, each measured on the dates the position and the proxy share
  const exposures: ExposureRow[] = lines.map((l, i) => {
    const betas: ExposureRow["betas"] = {};
    const r2: ExposureRow["r2"] = {};
    for (const f of FACTORS) {
      const proxy = loaded.get(f.proxy);
      if (!proxy) {
        betas[f.id] = null;
        r2[f.id] = null;
        continue;
      }
      const pair = aligned([holdingBars[i], proxy.bars]);
      if (pair.dates.length < 40) {
        betas[f.id] = null;
        r2[f.id] = null;
        continue;
      }
      const [a, b] = pair.closes.map(simpleReturns);
      betas[f.id] = beta(a, b);
      const c = correlation(a, b);
      r2[f.id] = c === null ? null : c * c;
    }
    return { ticker: l.ticker, weight: l.weight, marketValue: l.marketValue, betas, r2 };
  });

  const factors = FACTORS.map((f) => {
    let portfolioBeta = 0;
    let explained = 0;
    let measured = false;
    for (const row of exposures) {
      const b = row.betas[f.id];
      if (b === null || b === undefined) continue;
      measured = true;
      portfolioBeta += row.weight * b;
      explained += row.weight * (row.r2[f.id] ?? 0);
    }
    return { id: f.id, portfolioBeta: measured ? portfolioBeta : null, explained };
  });

  const labels = lines.map((l) => l.ticker);
  const clusters = correlationClusters(labels, matrix, CLUSTER_CORRELATION).map((group) => {
    const idx = group.map((t) => labels.indexOf(t));
    const cs: number[] = [];
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const c = matrix[idx[a]][idx[b]];
      if (c !== null) cs.push(c);
    }
    return { tickers: group, weight: idx.reduce((s, i) => s + weights[i], 0), avgCorrelation: mean(cs) };
  });

  const sectorWeights = new Map<string, number>();
  positions.forEach((p) => sectorWeights.set(p.sector, (sectorWeights.get(p.sector) ?? 0) + p.weight));
  const sectors = [...sectorWeights.entries()].map(([sector, weight]) => ({ sector, weight })).sort((a, b) => b.weight - a.weight);

  const { hhi, effectiveN } = concentration(weights);
  const annualReturn = mean(portfolioReturns) * TRADING_DAYS;
  const marketValues = lines.map((l) => l.marketValue);
  const totalValue = marketValues.every((v) => v !== null) ? (marketValues as number[]).reduce((s, v) => s + v, 0) : null;
  const dayChanges = positions.map((p) => p.dayContribution);

  const report: RiskReport = {
    basis: basis.kind,
    label: resolved.label,
    asOf: dates.at(-1) ?? null,
    window: { start: dates[0], end: dates.at(-1) as string, sessions: dates.length },
    positions,
    portfolio: {
      vol,
      beta: spyReturns ? beta(portfolioReturns, spyReturns) : null,
      maxDrawdown: maxDrawdown(portfolioReturns),
      sharpe: vol > 0 && riskFree ? (annualReturn - riskFree.rate) / vol : null,
      var95: historicalVaR(portfolioReturns),
      return1y: cumulative(portfolioReturns),
      benchmarkReturn1y: spyReturns ? cumulative(spyReturns) : null,
      avgCorrelation: pairs.length ? mean(pairs) : null,
      diversification: vol > 0 ? weightedVol / vol : null,
      effectiveN,
      hhi,
      topWeight: Math.max(...weights),
      dayChange: dayChanges.every((c) => c !== null) ? (dayChanges as number[]).reduce((s, c) => s + c, 0) : null,
      marketValue: totalValue,
    },
    riskFree,
    correlation: { tickers: labels, matrix },
    sectors,
    factors,
    exposures,
    clusters,
    findings: [],
    warnings,
    sources: [...new Set([...lines.map((l) => (loaded.get(l.ticker) as Loaded).source), ...(riskFree ? [riskFree.source] : [])])],
  };

  report.findings = findings(report);
  return report;
}

/* -------------------------------------------------------------- findings */

// The page's headline observations, each one a threshold on a computed number,
// so the same portfolio always produces the same findings.
export function findings(r: RiskReport): RiskReport["findings"] {
  const out: RiskReport["findings"] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const top = [...r.positions].sort((a, b) => b.weight - a.weight)[0];
  if (top && top.weight >= 0.25 && r.positions.length > 1) {
    out.push({ severity: top.weight >= 0.4 ? "high" : "warn", text: `${top.ticker} is ${pct(top.weight)} of the portfolio.` });
  }

  const riskiest = [...r.positions].filter((p) => p.riskShare !== null).sort((a, b) => (b.riskShare as number) - (a.riskShare as number))[0];
  if (riskiest && riskiest.riskShare !== null && riskiest.riskShare > riskiest.weight * 1.3 && r.positions.length > 1) {
    out.push({
      severity: "warn",
      text: `${riskiest.ticker} carries ${pct(riskiest.riskShare)} of the portfolio's risk on ${pct(riskiest.weight)} of its value — the largest source of risk.`,
    });
  }

  for (const c of r.clusters) {
    out.push({
      severity: c.weight >= 0.4 ? "high" : "warn",
      text: `${c.tickers.join(", ")} move together (average correlation ${c.avgCorrelation.toFixed(2)}): ${pct(c.weight)} of the portfolio behaves close to a single position.`,
    });
  }

  // Hidden exposure: positions whose daily moves a theme explains, whatever
  // sector they are filed under.
  for (const f of FACTORS) {
    if (f.id === "market") continue;
    let weight = 0;
    const names: string[] = [];
    for (const row of r.exposures) {
      const b = row.betas[f.id];
      const r2 = row.r2[f.id];
      if (b === null || b === undefined || r2 === null || r2 === undefined) continue;
      if (r2 >= EXPOSED_R2 && Math.abs(b) >= EXPOSED_BETA) {
        weight += row.weight;
        names.push(row.ticker);
      }
    }
    if (weight >= 0.25 && names.length > 0) {
      out.push({
        severity: weight >= 0.5 ? "high" : "warn",
        text: `${pct(weight)} of the portfolio (${names.join(", ")}) moves with ${f.label} (${f.proxy}: ${f.means}), which explains at least ${Math.round(EXPOSED_R2 * 100)}% of each one's daily variance.`,
      });
    }
  }

  const topSector = r.sectors[0];
  if (topSector && topSector.weight >= 0.6 && r.positions.length > 1) {
    out.push({ severity: "warn", text: `${pct(topSector.weight)} sits in one sector: ${topSector.sector}.` });
  }

  if (r.portfolio.beta !== null && r.portfolio.beta >= 1.3) {
    out.push({ severity: "warn", text: `Beta to the S&P 500 is ${r.portfolio.beta.toFixed(2)}: a 10% market fall has historically meant about ${Math.round(r.portfolio.beta * 10)}% here.` });
  }

  const slow = r.positions.filter((p) => p.daysToExit !== null && p.daysToExit > 1);
  for (const p of slow) {
    out.push({ severity: "info", text: `${p.ticker} would take about ${p.daysToExit!.toFixed(1)} days to exit at ${Math.round(PARTICIPATION * 100)}% of its daily volume.` });
  }

  if (out.length === 0 && r.positions.length > 0) {
    out.push({ severity: "info", text: "No concentration, correlation or hidden-exposure threshold was crossed." });
  }
  return out;
}

async function riskFreeRate(): Promise<RiskReport["riskFree"]> {
  try {
    const { rows } = await pool.query(
      `SELECT value, date FROM macro_series WHERE series_id = 'DGS2' AND value IS NOT NULL ORDER BY date DESC LIMIT 1`
    );
    if (rows.length === 0) return null;
    return {
      rate: Number(rows[0].value) / 100,
      source: `FRED DGS2 (2-year Treasury), ${(rows[0].date as Date).toISOString().slice(0, 10)}`,
    };
  } catch {
    return null;
  }
}

function emptyReport(kind: Basis["kind"], label: string, warnings: string[]): RiskReport {
  return {
    basis: kind,
    label,
    asOf: null,
    window: null,
    positions: [],
    portfolio: {
      vol: null,
      beta: null,
      maxDrawdown: null,
      sharpe: null,
      var95: null,
      return1y: null,
      benchmarkReturn1y: null,
      avgCorrelation: null,
      diversification: null,
      effectiveN: 0,
      hhi: 0,
      topWeight: 0,
      dayChange: null,
      marketValue: null,
    },
    riskFree: null,
    correlation: { tickers: [], matrix: [] },
    sectors: [],
    factors: [],
    exposures: [],
    clusters: [],
    findings: [],
    warnings,
    sources: [],
  };
}

export function basisFrom(params: { basket?: string | null; source?: string | null }): Basis {
  if (params.basket && params.basket.trim()) return { kind: "custom", text: params.basket };
  if (params.source === "watchlist") return { kind: "watchlist" };
  return { kind: "holdings" };
}
