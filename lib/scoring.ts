import { readFileSync } from "fs";
import { join } from "path";
import Decimal from "decimal.js";
import { pool } from "./db";
import { DERIVED_METRICS, deriveMetrics, type PeriodFacts } from "./metrics";

// Read fresh on every run rather than imported, so editing weights.json changes
// the next score without a rebuild.
export function loadWeights(): Record<string, number> {
  const raw = readFileSync(join(process.cwd(), "weights.json"), "utf8");
  const weights = JSON.parse(raw) as Record<string, number>;

  for (const component of Object.keys(weights)) {
    if (!(component in DERIVED_METRICS)) {
      throw new Error(`weights.json lists unknown component "${component}"`);
    }
  }
  return weights;
}

// A restatement is a new row, so the value in force is the one from the most
// recently filed report covering that period.
async function annualPeriods(companyId: string): Promise<PeriodFacts[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (f.metric, f.period_end) f.metric, f.period_end, f.value
     FROM fundamentals f
     LEFT JOIN filings fl ON fl.id = f.filing_id
     WHERE f.company_id = $1 AND f.fiscal_period = 'FY' AND f.value IS NOT NULL
     ORDER BY f.metric, f.period_end DESC, fl.filed_at DESC NULLS LAST, f.retrieved_at DESC`,
    [companyId]
  );

  const byPeriod = new Map<string, PeriodFacts>();
  for (const row of rows) {
    const periodEnd = (row.period_end as Date).toISOString().slice(0, 10);
    const period = byPeriod.get(periodEnd) ?? { periodEnd, values: new Map<string, Decimal>() };
    period.values.set(row.metric, new Decimal(row.value));
    byPeriod.set(periodEnd, period);
  }

  return [...byPeriod.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

async function latestMarketCap(companyId: string, shares: Decimal | undefined): Promise<Decimal | null> {
  if (!shares || shares.lte(0)) return null;

  const { rows } = await pool.query(
    `SELECT close FROM prices_daily
     WHERE company_id = $1 AND close IS NOT NULL
     ORDER BY date DESC LIMIT 1`,
    [companyId]
  );
  if (rows.length === 0) return null;

  return new Decimal(rows[0].close).mul(shares);
}

interface ScoreRow {
  companyId: string;
  component: string;
  rawValue: Decimal;
  weight: number;
}

export async function computeScores(asOf: string): Promise<{ companies: number; rows: number }> {
  const weights = loadWeights();

  const { rows: companies } = await pool.query(
    "SELECT id, ticker FROM companies WHERE active = true ORDER BY ticker"
  );

  const scoreRows: ScoreRow[] = [];
  let covered = 0;

  for (const company of companies) {
    const periods = await annualPeriods(company.id);
    if (periods.length === 0) continue;

    const [current, prior] = periods;
    const marketCap = await latestMarketCap(company.id, current.values.get("shares_diluted"));
    const derived = deriveMetrics({ current, prior, marketCap });
    if (derived.size === 0) continue;

    covered++;
    for (const [component, weight] of Object.entries(weights)) {
      const rawValue = derived.get(component);
      if (rawValue === undefined) continue;
      scoreRows.push({ companyId: company.id, component, rawValue, weight });
    }
  }

  if (scoreRows.length === 0) return { companies: 0, rows: 0 };

  // Percentiles are ranked in SQL so the comparison always runs across the whole
  // stored universe, not whatever happens to be loaded in memory. A sector with a
  // single company has no peers to rank against, so it sits at the midpoint
  // instead of PERCENT_RANK's 0.
  await pool.query(
    `WITH input AS (
       SELECT * FROM unnest($2::uuid[], $3::text[], $4::numeric[], $5::numeric[], $6::text[])
         AS t(company_id, component, raw_value, weight, direction)
     ),
     ranked AS (
       SELECT i.*,
              PERCENT_RANK() OVER (PARTITION BY c.sector, i.component ORDER BY i.raw_value) AS pct_rank,
              COUNT(*) OVER (PARTITION BY c.sector, i.component) AS peers
       FROM input i
       JOIN companies c ON c.id = i.company_id
     )
     INSERT INTO scores (company_id, as_of, component, raw_value, percentile, weight)
     SELECT company_id, $1::date, component, raw_value,
            CASE WHEN peers = 1 THEN 0.5
                 WHEN direction = 'lower' THEN 1 - pct_rank
                 ELSE pct_rank END,
            weight
     FROM ranked
     ON CONFLICT (company_id, as_of, component) DO UPDATE
     SET raw_value = EXCLUDED.raw_value,
         percentile = EXCLUDED.percentile,
         weight = EXCLUDED.weight`,
    [
      asOf,
      scoreRows.map((r) => r.companyId),
      scoreRows.map((r) => r.component),
      scoreRows.map((r) => r.rawValue.toString()),
      scoreRows.map((r) => r.weight),
      scoreRows.map((r) => DERIVED_METRICS[r.component]),
    ]
  );

  return { companies: covered, rows: scoreRows.length };
}

export interface ScoreComponent {
  component: string;
  rawValue: number | null;
  percentile: number;
  weight: number;
  contribution: number;
}

export interface CompanyScore {
  companyId: string;
  ticker: string;
  name: string;
  sector: string | null;
  asOf: string;
  total: number;
  coverage: { present: number; expected: number };
  components: ScoreComponent[];
}

// The total is recomputed from the stored component rows rather than stored
// alongside them, so there is no second copy of a number to drift.
export function weightedTotal(components: ScoreComponent[]): number {
  const weightUsed = components.reduce((sum, c) => sum + c.weight, 0);
  if (weightUsed === 0) return 0;

  const weighted = components.reduce((sum, c) => sum + c.percentile * c.weight, 0);
  return (weighted / weightUsed) * 100;
}

export async function getScores(): Promise<CompanyScore[]> {
  const { rows } = await pool.query(
    `SELECT s.company_id, c.ticker, c.name, c.sector, s.as_of,
            s.component, s.raw_value, s.percentile, s.weight
     FROM scores s
     JOIN companies c ON c.id = s.company_id
     WHERE s.as_of = (SELECT MAX(as_of) FROM scores)
     ORDER BY c.ticker, s.component`
  );

  const expected = Object.keys(loadWeights()).length;
  const byCompany = new Map<string, CompanyScore>();

  for (const row of rows) {
    const entry: CompanyScore = byCompany.get(row.company_id) ?? {
      companyId: row.company_id,
      ticker: row.ticker,
      name: row.name,
      sector: row.sector,
      asOf: (row.as_of as Date).toISOString().slice(0, 10),
      total: 0,
      coverage: { present: 0, expected },
      components: [],
    };

    entry.components.push({
      component: row.component,
      rawValue: row.raw_value === null ? null : Number(row.raw_value),
      percentile: Number(row.percentile),
      weight: Number(row.weight),
      contribution: 0,
    });
    byCompany.set(row.company_id, entry);
  }

  const scores = [...byCompany.values()];
  for (const score of scores) {
    score.total = weightedTotal(score.components);
    score.coverage.present = score.components.length;

    // Weights are renormalised over the components a company actually has, so
    // contributions add up to the total even when some inputs are missing.
    const weightUsed = score.components.reduce((sum, c) => sum + c.weight, 0);
    for (const component of score.components) {
      component.contribution =
        weightUsed === 0 ? 0 : (component.percentile * component.weight * 100) / weightUsed;
    }
  }

  scores.sort((a, b) => b.total - a.total);
  return scores;
}
