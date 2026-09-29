import { pool } from "./db";
import { latestMetrics, getScores } from "./scoring";
import { loadBars, momentum } from "./market/bars";

/* ---------------------------------------------------------------------------
   The opportunity scanner.

   A screen is a list of rules over computed metrics — the same structure a
   thesis uses, so it is checked by arithmetic and never by reading text as
   code. The scanner runs every screen over every company the desk has filings
   for and turns the matches into a research queue, each entry carrying the
   numbers that put it there.
--------------------------------------------------------------------------- */

export type Op = ">=" | "<=" | ">" | "<";

export interface ScreenRule {
  metric: MetricKey;
  op: Op;
  value: number;
}

export interface Screen {
  id: string;
  name: string;
  description: string;
  rules: ScreenRule[];
}

export const METRICS = {
  revenue_growth: { label: "Revenue growth", unit: "ratio", from: "filings" },
  gross_margin: { label: "Gross margin", unit: "ratio", from: "filings" },
  gross_margin_trend: { label: "Gross margin change", unit: "points", from: "filings" },
  operating_margin: { label: "Operating margin", unit: "ratio", from: "filings" },
  operating_margin_trend: { label: "Operating margin change", unit: "points", from: "filings" },
  fcf_margin: { label: "FCF margin", unit: "ratio", from: "filings" },
  roic: { label: "ROIC", unit: "ratio", from: "filings" },
  net_debt_to_ebitda: { label: "Net debt / EBITDA", unit: "multiple", from: "filings" },
  pe: { label: "P/E", unit: "multiple", from: "valuation" },
  ps: { label: "P/S", unit: "multiple", from: "valuation" },
  fcf_yield: { label: "FCF yield", unit: "ratio", from: "valuation" },
  return_1m: { label: "1-month return", unit: "ratio", from: "price" },
  return_3m: { label: "3-month return", unit: "ratio", from: "price" },
  return_1y: { label: "1-year return", unit: "ratio", from: "price" },
  below_high: { label: "From 52-week high", unit: "ratio", from: "price" },
  above_sma200: { label: "Above 200-day average", unit: "flag", from: "price" },
  score: { label: "Sector score", unit: "score", from: "scores" },
} as const;

export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export const SCREENS: Screen[] = [
  {
    id: "quality-compounders",
    name: "Quality compounders",
    description: "Growing, cash-generative, high returns on capital.",
    rules: [
      { metric: "revenue_growth", op: ">=", value: 0.1 },
      { metric: "fcf_margin", op: ">=", value: 0.15 },
      { metric: "roic", op: ">=", value: 0.15 },
    ],
  },
  {
    id: "accelerating",
    name: "Fast growth, widening margins",
    description: "Revenue up 20% or more with operating margin improving.",
    rules: [
      { metric: "revenue_growth", op: ">=", value: 0.2 },
      { metric: "operating_margin_trend", op: ">", value: 0 },
    ],
  },
  {
    id: "beaten-down-quality",
    name: "Beaten-down quality",
    description: "15% or more below the 52-week high while still growing and generating cash.",
    rules: [
      { metric: "below_high", op: "<=", value: -0.15 },
      { metric: "revenue_growth", op: ">", value: 0 },
      { metric: "fcf_margin", op: ">=", value: 0.1 },
    ],
  },
  {
    id: "improving-margins",
    name: "Improving margins",
    description: "Gross and operating margins both up on the prior year.",
    rules: [
      { metric: "gross_margin_trend", op: ">", value: 0 },
      { metric: "operating_margin_trend", op: ">", value: 0 },
    ],
  },
  {
    id: "reasonable-value",
    name: "Growth at a reasonable price",
    description: "P/E of 25 or less, growing 8%+, with a 3%+ free-cash-flow yield.",
    rules: [
      { metric: "pe", op: "<=", value: 25 },
      { metric: "revenue_growth", op: ">=", value: 0.08 },
      { metric: "fcf_yield", op: ">=", value: 0.03 },
    ],
  },
  {
    id: "momentum",
    name: "Strong momentum",
    description: "Up 15%+ over three months and above the 200-day average.",
    rules: [
      { metric: "return_3m", op: ">=", value: 0.15 },
      { metric: "above_sma200", op: ">=", value: 1 },
    ],
  },
];

export interface ScanRow {
  ticker: string;
  name: string;
  sector: string | null;
  metrics: Partial<Record<MetricKey, number>>;
  periodEnd: string | null;
  priceAsOf: string | null;
  matches: Array<{ screen: string; name: string; reasons: string[] }>;
}

export interface ScanResult {
  rows: ScanRow[];
  screens: Screen[];
  queue: ScanRow[];
  universe: number;
  custom: Screen | null;
}

/* ---------------------------------------------------------------- format */

export function formatMetric(key: MetricKey, value: number): string {
  switch (METRICS[key].unit) {
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "points":
      return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
    case "multiple":
      return `${value.toFixed(1)}x`;
    case "flag":
      return value >= 1 ? "yes" : "no";
    default:
      return value.toFixed(1);
  }
}

function reason(key: MetricKey, value: number): string {
  const m = METRICS[key];
  if (m.unit === "flag") return value >= 1 ? m.label : `Not ${m.label.toLowerCase()}`;
  return `${m.label} ${formatMetric(key, value)}`;
}

export function describeRule(rule: ScreenRule): string {
  const m = METRICS[rule.metric];
  if (m.unit === "flag") return `${m.label}: ${rule.value >= 1 ? "yes" : "no"}`;
  return `${m.label} ${rule.op} ${formatMetric(rule.metric, rule.value)}`;
}

export function passes(rule: ScreenRule, actual: number): boolean {
  switch (rule.op) {
    case ">=":
      return actual >= rule.value;
    case "<=":
      return actual <= rule.value;
    case ">":
      return actual > rule.value;
    case "<":
      return actual < rule.value;
  }
}

// "revenue_growth>=0.2; fcf_margin>0.1" — the form the custom screen travels in
// through a URL, and the form the Copilot writes a strategy into.
export function parseScreen(text: string): { rules: ScreenRule[]; errors: string[] } {
  const rules: ScreenRule[] = [];
  const errors: string[] = [];
  for (const part of text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^([a-z0-9_]+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/i);
    if (!match) {
      errors.push(`"${part}" is not a rule like revenue_growth>=0.2`);
      continue;
    }
    const metric = match[1].toLowerCase();
    if (!(METRIC_KEYS as string[]).includes(metric)) {
      errors.push(`"${metric}" is not a metric the scanner computes`);
      continue;
    }
    rules.push({ metric: metric as MetricKey, op: match[2] as Op, value: Number(match[3]) });
  }
  return { rules, errors };
}

/* ------------------------------------------------------------------ scan */

async function universe(): Promise<Array<{ id: string; ticker: string; name: string; sector: string | null }>> {
  // Companies with annual filings on record — funds and benchmarks have none.
  const { rows } = await pool.query(
    `SELECT c.id, c.ticker, c.name, c.sector FROM companies c
     WHERE c.active AND EXISTS (SELECT 1 FROM fundamentals f WHERE f.company_id = c.id AND f.fiscal_period = 'FY')
     ORDER BY c.ticker`
  );
  return rows;
}

async function metricsFor(company: { id: string; ticker: string }, scores: Map<string, number>) {
  const out: Partial<Record<MetricKey, number>> = {};
  const facts = await latestMetrics(company.id);
  for (const [key, value] of facts.derived) {
    if ((METRIC_KEYS as string[]).includes(key)) out[key as MetricKey] = value.toNumber();
  }

  const loaded = await loadBars(company.ticker);
  let priceAsOf: string | null = null;
  if (loaded) {
    const m = momentum(loaded.bars);
    priceAsOf = m.asOf;
    if (m.month !== null) out.return_1m = m.month;
    if (m.quarter !== null) out.return_3m = m.quarter;
    if (m.year !== null) out.return_1y = m.year;
    out.below_high = m.belowHigh;
    if (m.aboveSma200 !== null) out.above_sma200 = m.aboveSma200 ? 1 : 0;

    // Valuation from the same price and the latest annual figures.
    const raw = facts.raw;
    const shares = raw.get("shares_diluted")?.toNumber();
    if (shares && shares > 0) {
      const cap = m.last * shares;
      const income = raw.get("net_income")?.toNumber();
      const revenue = raw.get("revenue")?.toNumber();
      const ocf = raw.get("operating_cash_flow")?.toNumber();
      const capex = raw.get("capex")?.toNumber() ?? 0;
      if (income && income > 0) out.pe = cap / income;
      if (revenue && revenue > 0) out.ps = cap / revenue;
      if (ocf !== undefined) out.fcf_yield = (ocf - capex) / cap;
    }
  }

  const score = scores.get(company.id);
  if (score !== undefined) out.score = score;
  return { metrics: out, periodEnd: facts.periodEnd, priceAsOf };
}

export async function scan(custom?: ScreenRule[]): Promise<ScanResult> {
  const companies = await universe();
  const scores = new Map((await getScores().catch(() => [])).map((s) => [s.companyId, s.total]));
  const customScreen: Screen | null = custom?.length
    ? { id: "custom", name: "Custom screen", description: custom.map(describeRule).join(" · "), rules: custom }
    : null;
  const screens = customScreen ? [customScreen, ...SCREENS] : SCREENS;

  const rows: ScanRow[] = await Promise.all(
    companies.map(async (c) => {
      const { metrics, periodEnd, priceAsOf } = await metricsFor(c, scores);
      const matches = screens
        .filter((screen) =>
          screen.rules.every((rule) => metrics[rule.metric] !== undefined && passes(rule, metrics[rule.metric] as number))
        )
        .map((screen) => ({
          screen: screen.id,
          name: screen.name,
          reasons: screen.rules.map((rule) => reason(rule.metric, metrics[rule.metric] as number)),
        }));
      return { ticker: c.ticker, name: c.name, sector: c.sector, metrics, periodEnd, priceAsOf, matches };
    })
  );

  // The queue: anything a screen caught, most screens first, then the sector
  // score as the tie-break. A custom screen, when given, decides on its own.
  const queue = rows
    .filter((r) => (customScreen ? r.matches.some((m) => m.screen === "custom") : r.matches.length > 0))
    .sort((a, b) => b.matches.length - a.matches.length || (b.metrics.score ?? 0) - (a.metrics.score ?? 0));

  return { rows, screens, queue, universe: companies.length, custom: customScreen };
}
