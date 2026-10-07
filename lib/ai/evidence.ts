import Decimal from "decimal.js";
import { pool } from "../db";
import type { Actor } from "../actor";
import { getFundamentals, getPriceHistory, type CompanyRow } from "../company";
import { getScores, latestMetrics } from "../scoring";
import { getHeadlines } from "../dossier";
import { getResearchNote, RESEARCH_FIELDS } from "../research";
import { listTheses } from "../theses";
import { getPortfolio } from "../holdings";
import { fetchChart } from "../quote";
import { inputHash } from "../llm";
import { capitalisationShares } from "../edgar";
import { getSplits, splitFactor } from "../splits";

/* ---------------------------------------------------------------------------
   The Capital Data Engine, as far as the committee is concerned: one evidence
   pack per run, built by code, handed unchanged to every model.

   Every item has an id (E1, E2, …). A model may only assert a fact by citing
   the items it came from, and every number in the pack is computed here — the
   models interpret the figures, they never produce them. Because each item
   carries its numeric value, the checker can test any figure a model writes
   against the item it cites, which is arithmetic, not opinion.
--------------------------------------------------------------------------- */

export type Unit = "ratio" | "usd" | "multiple" | "shares" | "percent" | "index" | "count";

export interface EvidenceItem {
  id: string;
  kind:
    | "profile"
    | "fundamental"
    | "metric"
    | "valuation"
    | "price"
    | "score"
    | "headline"
    | "research"
    | "thesis"
    | "macro"
    | "position";
  label: string;
  value?: number;
  unit?: Unit;
  asOf?: string;
  text?: string;
  source: { kind: string; ref: string; url?: string };
}

export interface EvidenceCoverage {
  inputs: Array<{ name: string; present: boolean }>;
  present: number;
  expected: number;
}

export interface EvidencePack {
  ticker: string;
  name: string;
  sector: string | null;
  industry: string | null;
  generatedAt: string;
  // the latest annual period the pack's fundamentals come from, which is what
  // any assumption made from this pack is later checked against
  periodEnd: string | null;
  items: EvidenceItem[];
  coverage: EvidenceCoverage;
  hash: string;
}

/* ------------------------------------------------------------------- format */

export function formatValue(value: number, unit: Unit | undefined): string {
  switch (unit) {
    case "ratio":
      return `${(value * 100).toFixed(2)}%`;
    case "percent":
      return `${value.toFixed(2)}%`;
    case "usd":
      return compactMoney(value);
    case "multiple":
      return `${value.toFixed(2)}x`;
    case "shares":
      return `${compactNumber(value)} shares`;
    case "count":
      return value.toFixed(0);
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
}

function compactMoney(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${compactNumber(Math.abs(value))}`;
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

// What each model actually reads. The formatted value comes first because that
// is the form a model will restate; the raw figure follows so nothing is lost
// to rounding.
export function renderEvidence(pack: EvidencePack): string {
  const lines = pack.items.map((item) => {
    let line = `[${item.id}] ${item.label}`;
    // Most labels already name their period; the date is only added when not.
    if (item.asOf && !item.label.includes(item.asOf)) line += `, ${item.asOf}`;
    if (item.value !== undefined) {
      const formatted = formatValue(item.value, item.unit);
      const raw = item.unit === "usd" || item.unit === "shares" ? ` (${item.value})` : "";
      line += ` = ${formatted}${raw}`;
    }
    if (item.text) line += `: ${item.text}`;
    return `${line} · source: ${item.source.ref}`;
  });

  const missing = pack.coverage.inputs.filter((i) => !i.present).map((i) => i.name);

  return [
    `EVIDENCE PACK — ${pack.ticker} (${pack.name})`,
    pack.sector ? `Sector: ${pack.sector}${pack.industry ? ` · ${pack.industry}` : ""}` : null,
    `Built ${pack.generatedAt.slice(0, 10)}. Every figure below was computed by code from stored filings, prices and feeds.`,
    missing.length > 0 ? `NOT AVAILABLE for this company: ${missing.join(", ")}.` : null,
    "",
    ...lines,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/* ---------------------------------------------------------------- the build */

const FUNDAMENTALS = [
  "revenue",
  "gross_profit",
  "operating_income",
  "net_income",
  "operating_cash_flow",
  "capex",
  "cash_and_equivalents",
  "long_term_debt",
  "current_debt",
  "total_debt",
  "total_equity",
  "shares_diluted",
  "shares_outstanding",
];

const FUNDAMENTAL_LABELS: Record<string, string> = {
  revenue: "Revenue",
  gross_profit: "Gross profit",
  operating_income: "Operating income",
  net_income: "Net income",
  operating_cash_flow: "Operating cash flow",
  capex: "Capital expenditure",
  cash_and_equivalents: "Cash and equivalents",
  long_term_debt: "Long-term debt",
  current_debt: "Current portion of debt",
  total_debt: "Total debt",
  total_equity: "Shareholders' equity",
  shares_diluted: "Diluted weighted shares",
  shares_outstanding: "Shares outstanding at period end",
};

// Only the derived metrics that do not depend on a price. Price-based multiples
// are computed below from the same price the rest of the pack uses, so the pack
// never carries two different EV/EBITDA figures.
const DERIVED: Record<string, { label: string; unit: Unit }> = {
  revenue_growth: { label: "Revenue growth, year over year", unit: "ratio" },
  gross_margin: { label: "Gross margin", unit: "ratio" },
  gross_margin_trend: { label: "Gross margin change vs prior year (ratio points)", unit: "ratio" },
  operating_margin: { label: "Operating margin", unit: "ratio" },
  operating_margin_trend: { label: "Operating margin change vs prior year (ratio points)", unit: "ratio" },
  fcf_margin: { label: "Free cash flow margin", unit: "ratio" },
  roic: { label: "Return on invested capital", unit: "ratio" },
  net_debt_to_ebitda: { label: "Net debt / EBITDA", unit: "multiple" },
};

const MACRO: Record<string, { label: string; transform: "level" | "yoy" }> = {
  DGS10: { label: "10-year Treasury yield", transform: "level" },
  DGS2: { label: "2-year Treasury yield", transform: "level" },
  T10Y2Y: { label: "10-year minus 2-year Treasury spread", transform: "level" },
  FEDFUNDS: { label: "Effective federal funds rate", transform: "level" },
  UNRATE: { label: "US unemployment rate", transform: "level" },
  CPIAUCSL: { label: "US CPI inflation, year over year", transform: "yoy" },
  GDPC1: { label: "US real GDP growth, year over year", transform: "yoy" },
  DTWEXBGS: { label: "Trade-weighted US dollar, change over one year", transform: "yoy" },
};

class PackBuilder {
  items: EvidenceItem[] = [];

  add(item: Omit<EvidenceItem, "id">): EvidenceItem {
    const full = { id: `E${this.items.length + 1}`, ...item };
    this.items.push(full);
    return full;
  }
}

export async function buildEvidence(
  company: CompanyRow,
  actor: Pick<Actor, "userId" | "accountId">
): Promise<EvidencePack> {
  const b = new PackBuilder();
  const inputs: EvidenceCoverage["inputs"] = [];

  b.add({
    kind: "profile",
    label: "Company",
    text: `${company.name} (${company.ticker})${company.sector ? `, ${company.sector}` : ""}${
      company.industry ? ` / ${company.industry}` : ""
    }`,
    source: { kind: "companies", ref: "companies table" },
  });
  inputs.push({ name: "sector classification", present: Boolean(company.sector) });

  /* ---- fundamentals: the last three annual periods, straight from filings */

  const { rows: facts } = await getFundamentals(company.id, {
    fiscalPeriod: "FY",
    periods: 3,
    metrics: FUNDAMENTALS,
  });
  inputs.push({ name: "annual fundamentals", present: facts.length > 0 });

  const latestPeriod = facts.length > 0 ? facts[0].periodEnd : null;
  const latestByMetric = new Map<string, number>();

  for (const fact of facts) {
    const value = Number(fact.value);
    if (!Number.isFinite(value)) continue;
    if (fact.periodEnd === latestPeriod) latestByMetric.set(fact.metric, value);

    b.add({
      kind: "fundamental",
      label: `${FUNDAMENTAL_LABELS[fact.metric] ?? fact.metric}, fiscal year ending ${fact.periodEnd}`,
      value,
      unit: fact.metric === "shares_diluted" || fact.metric === "shares_outstanding" ? "shares" : "usd",
      asOf: fact.periodEnd,
      source: {
        kind: "filing",
        ref: fact.accession
          ? `${fact.formType ?? "filing"} ${fact.accession}${fact.filedAt ? `, filed ${fact.filedAt}` : ""}`
          : "XBRL facts",
      },
    });
  }

  /* ---- derived metrics, computed by lib/metrics from the same filings */

  try {
    const metrics = await latestMetrics(company.id);
    for (const [key, spec] of Object.entries(DERIVED)) {
      const value = metrics.derived.get(key);
      if (value === undefined) continue;
      b.add({
        kind: "metric",
        label: `${spec.label} (fiscal year ending ${metrics.periodEnd})`,
        value: value.toNumber(),
        unit: spec.unit,
        asOf: metrics.periodEnd ?? undefined,
        source: { kind: "computed", ref: "computed from 10-K figures by lib/metrics" },
      });
    }
  } catch {
    // no annual periods — the coverage line above already says so
  }

  /* ---- prices: stored bars first, the market-data provider when the desk has none */

  const price = await priceSeries(company);
  inputs.push({ name: "price history", present: price.closes.length > 1 });

  if (price.closes.length > 1) {
    const stats = priceStats(price.closes);
    const src = { kind: price.source, ref: price.ref };
    const last = price.closes[price.closes.length - 1];

    b.add({ kind: "price", label: "Last close", value: last.close, unit: "usd", asOf: last.date, source: src });
    for (const [key, label] of [
      ["return1m", "Price return, 1 month (21 sessions)"],
      ["return3m", "Price return, 3 months (63 sessions)"],
      ["return1y", "Price return, 1 year (252 sessions or all available)"],
      ["belowHigh", "Distance below the 52-week high"],
      ["volatility", "Annualised volatility of daily returns, 1 year"],
      ["maxDrawdown", "Maximum drawdown, 1 year"],
    ] as const) {
      const value = stats[key];
      if (value !== null) b.add({ kind: "price", label, value, unit: "ratio", asOf: last.date, source: src });
    }
    b.add({ kind: "price", label: "52-week high", value: stats.high, unit: "usd", asOf: last.date, source: src });
    b.add({ kind: "price", label: "52-week low", value: stats.low, unit: "usd", asOf: last.date, source: src });

    /* ---- valuation, from that price and the latest annual figures */

    // Shares as filed for the period, restated for any split since, so they
    // are on the same basis as the split-adjusted price.
    const factor = latestPeriod
      ? splitFactor((await getSplits([company.id])).get(company.id), latestPeriod).toNumber()
      : 1;
    const onPriceBasis = new Map(latestByMetric);
    for (const key of ["shares_outstanding", "shares_diluted"]) {
      const v = onPriceBasis.get(key);
      if (v !== undefined) onPriceBasis.set(key, v * factor);
    }
    for (const v of valuation(last.close, onPriceBasis, factor)) {
      b.add({
        kind: "valuation",
        label: `${v.label} (price ${last.date}, fiscal year ending ${latestPeriod})`,
        value: v.value,
        unit: v.unit,
        asOf: last.date,
        source: { kind: "computed", ref: `computed from ${price.ref} and the latest 10-K` },
      });
    }
  }

  /* ---- the sector score */

  try {
    const score = (await getScores()).find((s) => s.companyId === company.id);
    inputs.push({ name: "sector score", present: Boolean(score) });
    if (score) {
      b.add({
        kind: "score",
        label: "Composite score against its sector, 0 to 100",
        value: score.total,
        asOf: score.asOf,
        source: { kind: "scores", ref: "scores table, weights.json" },
      });
      // A component counted at the midpoint for want of data is not a fact
      // about the company, so it never becomes evidence.
      for (const c of score.components.filter((x) => !x.imputed)) {
        b.add({
          kind: "score",
          label: `Sector percentile for ${c.component.replace(/_/g, " ")} (1.0 = best in sector)`,
          value: c.percentile,
          asOf: score.asOf,
          source: { kind: "scores", ref: "scores table" },
        });
      }
    }
  } catch {
    inputs.push({ name: "sector score", present: false });
  }

  /* ---- headlines */

  const headlines = await getHeadlines(company.id, 30);
  inputs.push({ name: "recent headlines", present: headlines.length > 0 });
  const tagged = headlines.filter((h) => h.sentiment);
  if (tagged.length > 0) {
    const count = (s: string) => tagged.filter((h) => h.sentiment === s).length;
    b.add({
      kind: "headline",
      label: "Headline sentiment counts among the 30 most recent",
      text: `${count("bullish")} bullish, ${count("neutral")} neutral, ${count("bearish")} bearish (labelled by ${
        tagged[0].sentimentProvider ?? "the analyst"
      })`,
      source: { kind: "headlines", ref: "headlines table" },
    });
  }
  for (const h of headlines) {
    b.add({
      kind: "headline",
      label: `Headline${h.domain ? ` (${h.domain})` : ""}${h.sentiment ? `, labelled ${h.sentiment}` : ""}`,
      asOf: h.publishedAt?.slice(0, 10),
      text: `"${h.title}"`,
      source: { kind: "news", ref: h.domain ?? "news", url: h.url },
    });
  }

  /* ---- sourced research claims, each already matched against its source */

  const note = await getResearchNote(actor.userId, company.id, company.ticker, company.name);
  let noteCount = 0;
  for (const field of RESEARCH_FIELDS) {
    for (const claim of note.fields[field].slice(0, 4)) {
      noteCount++;
      b.add({
        kind: "research",
        label: `Sourced research note (${field.replace(/_/g, " ")})`,
        asOf: claim.createdAt.slice(0, 10),
        text: `${claim.text} — quoting: "${claim.snippet}"`,
        source: { kind: claim.source.kind, ref: claim.source.title ?? claim.source.url, url: claim.source.url },
      });
    }
  }
  inputs.push({ name: "sourced research notes", present: noteCount > 0 });

  /* ---- theses already open on this company */

  const theses = await listTheses(actor.userId, undefined, { companyId: company.id });
  for (const t of theses) {
    b.add({
      kind: "thesis",
      label: `Existing thesis (${t.thesis.status}${t.breached ? ", a rule is breached" : ""})`,
      asOf: t.thesis.openedAt.slice(0, 10),
      text: `${t.thesis.rationale ?? "no rationale"} — rules: ${t.checks
        .map((c) => `${c.rule.metric} ${c.rule.operator} ${c.rule.value} (latest ${c.actual ?? "unknown"})`)
        .join("; ")}`,
      source: { kind: "theses", ref: "theses table" },
    });
  }

  /* ---- the position, if one is held */

  {
    const { holdings } = await getPortfolio(actor.accountId);
    const held = holdings.find((h) => h.companyId === company.id);
    if (held) {
      b.add({ kind: "position", label: "Weight in the portfolio", value: held.weight.toNumber(), unit: "ratio", source: { kind: "transactions", ref: "ledger" } });
      b.add({ kind: "position", label: "Market value of the position", value: held.marketValue.toNumber(), unit: "usd", source: { kind: "transactions", ref: "ledger" } });
      if (held.costBasis.gt(0)) {
        b.add({
          kind: "position",
          label: "Unrealised return on the position",
          value: held.unrealizedPL.div(held.costBasis).toNumber(),
          unit: "ratio",
          source: { kind: "transactions", ref: "ledger" },
        });
      }
    }
  }

  /* ---- macro */

  const macro = await macroItems();
  inputs.push({ name: "macro series", present: macro.length > 0 });
  for (const item of macro) b.add(item);

  const generatedAt = new Date().toISOString();
  const coverage = {
    inputs,
    present: inputs.filter((i) => i.present).length,
    expected: inputs.length,
  };

  return {
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    industry: company.industry,
    generatedAt,
    periodEnd: latestPeriod,
    items: b.items,
    coverage,
    // The hash leaves out the build time: the same evidence built twice is the
    // same evidence.
    hash: inputHash({ ticker: company.ticker, items: b.items }),
  };
}

/* ---------------------------------------------------------------- prices */

interface Close {
  date: string;
  close: number;
}

// Long enough to cover a holiday weekend, short enough that a forgotten price
// job does not leave the committee reading last month's close as "last close".
const STALE_AFTER_DAYS = 5;

async function priceSeries(
  company: CompanyRow
): Promise<{ closes: Close[]; source: string; ref: string }> {
  const stored = await getPriceHistory(company.id, { limit: 260 });
  const closes = stored
    .filter((b) => b.close !== null)
    .map((b) => ({ date: b.date, close: Number(b.close) }));

  // A few stored bars are not a year of history, and a year that ended weeks ago
  // is not today's price; in either case the market-data provider is asked instead.
  const lastStored = closes.at(-1)?.date;
  const fresh = lastStored !== undefined && Date.now() - Date.parse(lastStored) < STALE_AFTER_DAYS * 86_400_000;
  if (closes.length >= 60 && fresh) {
    return { closes, source: "prices_daily", ref: "prices_daily table" };
  }

  try {
    const chart = await fetchChart(company.ticker, "1y");
    const live = chart.bars
      .filter((b) => b.close !== null)
      .map((b) => ({ date: b.date, close: b.close as number }));
    const newer = (live.at(-1)?.date ?? "") > (lastStored ?? "");
    if (live.length > closes.length || (newer && live.length >= 60)) {
      return { closes: live, source: chart.source, ref: `${chart.source} daily closes, 1 year` };
    }
  } catch {
    // unreachable — whatever is stored will have to do
  }
  return { closes, source: "prices_daily", ref: "prices_daily table" };
}

export interface PriceStats {
  return1m: number | null;
  return3m: number | null;
  return1y: number | null;
  high: number;
  low: number;
  belowHigh: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
}

// Pure, so the arithmetic can be tested without a database. closes are oldest
// first; the window is the last 252 sessions at most.
export function priceStats(all: Close[]): PriceStats {
  const closes = all.slice(-252);
  const last = closes[closes.length - 1].close;
  const back = (n: number) =>
    closes.length > n ? last / closes[closes.length - 1 - n].close - 1 : null;

  const values = closes.map((c) => c.close);
  const high = Math.max(...values);
  const low = Math.min(...values);

  const logReturns: number[] = [];
  for (let i = 1; i < values.length; i++) logReturns.push(Math.log(values[i] / values[i - 1]));
  let volatility: number | null = null;
  if (logReturns.length >= 20) {
    const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
    const variance =
      logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(252);
  }

  let peak = values[0];
  let maxDrawdown = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    maxDrawdown = Math.min(maxDrawdown, v / peak - 1);
  }

  return {
    return1m: back(21),
    return3m: back(63),
    return1y: closes.length > 1 ? last / closes[0].close - 1 : null,
    high,
    low,
    belowHigh: high > 0 ? last / high - 1 : null,
    volatility,
    maxDrawdown: values.length > 1 ? maxDrawdown : null,
  };
}

/* ------------------------------------------------------------- valuation */

export function valuation(
  price: number,
  latest: Map<string, number>,
  splitRestatement = 1
): Array<{ label: string; value: number; unit: Unit }> {
  const out: Array<{ label: string; value: number; unit: Unit }> = [];
  const shares = capitalisationShares(latest);
  if (!shares || shares <= 0 || !(price > 0)) return out;

  const d = (n: number) => new Decimal(n);
  const marketCap = d(price).mul(shares);
  out.push({
    label: `Market capitalisation, last close times ${
      latest.has("shares_outstanding") ? "shares outstanding at period end" : "diluted weighted shares"
    }${splitRestatement !== 1 ? ` restated ×${splitRestatement} for splits since` : ""}`,
    value: marketCap.toNumber(),
    unit: "usd",
  });

  const revenue = latest.get("revenue");
  const netIncome = latest.get("net_income");
  const ocf = latest.get("operating_cash_flow");
  const capex = latest.get("capex") ?? 0;
  const operating = latest.get("operating_income");
  const cash = latest.get("cash_and_equivalents");
  // The same convention as lib/metrics: a combined balance is taken as given,
  // otherwise the split halves are added and a missing half counts as zero.
  const longTerm = latest.get("long_term_debt");
  const currentDebt = latest.get("current_debt");
  const debt =
    latest.get("total_debt") ??
    (longTerm === undefined && currentDebt === undefined ? undefined : (longTerm ?? 0) + (currentDebt ?? 0));

  if (netIncome !== undefined && netIncome > 0) {
    out.push({ label: "Price / earnings (trailing annual)", value: marketCap.div(netIncome).toNumber(), unit: "multiple" });
  }
  if (revenue !== undefined && revenue > 0) {
    out.push({ label: "Price / sales (trailing annual)", value: marketCap.div(revenue).toNumber(), unit: "multiple" });
  }
  if (ocf !== undefined) {
    const fcf = d(ocf).sub(capex);
    out.push({ label: "Free cash flow yield (annual FCF / market cap)", value: fcf.div(marketCap).toNumber(), unit: "ratio" });
    if (fcf.gt(0)) {
      out.push({ label: "Price / free cash flow", value: marketCap.div(fcf).toNumber(), unit: "multiple" });
    }
  }
  if (operating !== undefined && operating > 0 && cash !== undefined && debt !== undefined) {
    const ev = marketCap.add(debt).sub(cash);
    out.push({
      label: "EV / operating income (EV = market cap + debt − cash)",
      value: ev.div(operating).toNumber(),
      unit: "multiple",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ macro */

async function macroItems(): Promise<Array<Omit<EvidenceItem, "id">>> {
  const ids = Object.keys(MACRO);
  let rows: Array<{ series_id: string; date: Date; value: string; which: "latest" | "year_ago" }>;
  try {
    // The latest observation, and the latest one at least a year before it.
    ({ rows } = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (series_id) series_id, date, value
         FROM macro_series WHERE series_id = ANY($1) AND value IS NOT NULL
         ORDER BY series_id, date DESC
       ),
       year_ago AS (
         SELECT DISTINCT ON (m.series_id) m.series_id, m.date, m.value
         FROM macro_series m JOIN latest l ON l.series_id = m.series_id
         WHERE m.value IS NOT NULL AND m.date <= l.date - interval '1 year'
         ORDER BY m.series_id, m.date DESC
       )
       SELECT series_id, date, value, 'latest' AS which FROM latest
       UNION ALL
       SELECT series_id, date, value, 'year_ago' FROM year_ago`,
      [ids]
    ));
  } catch {
    return [];
  }

  const out: Array<Omit<EvidenceItem, "id">> = [];
  for (const id of ids) {
    const spec = MACRO[id];
    const latest = rows.find((r) => r.series_id === id && r.which === "latest");
    const prior = rows.find((r) => r.series_id === id && r.which === "year_ago");
    if (!latest) continue;

    const asOf = latest.date.toISOString().slice(0, 10);
    const source = { kind: "fred", ref: `FRED ${id}` };

    if (spec.transform === "level") {
      out.push({ kind: "macro", label: spec.label, value: Number(latest.value), unit: "percent", asOf, source });
      if (prior) {
        out.push({
          kind: "macro",
          label: `${spec.label}, one year earlier (${prior.date.toISOString().slice(0, 10)})`,
          value: Number(prior.value),
          unit: "percent",
          asOf: prior.date.toISOString().slice(0, 10),
          source,
        });
      }
    } else if (prior && Number(prior.value) !== 0) {
      out.push({
        kind: "macro",
        label: spec.label,
        value: Number(latest.value) / Number(prior.value) - 1,
        unit: "ratio",
        asOf,
        source,
      });
    }
  }
  return out;
}
