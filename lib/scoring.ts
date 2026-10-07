import { readFileSync } from "fs";
import { join } from "path";
import Decimal from "decimal.js";
import { pool } from "./db";
import { DERIVED_METRICS, deriveMetrics, type PeriodFacts } from "./metrics";
import { capitalisationShares } from "./edgar";
import { getSplits, sharesOnPriceBasis } from "./splits";

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

async function latestMarketCap(companyId: string, filed: Decimal | undefined, periodEnd: string): Promise<Decimal | null> {
  if (!filed || filed.lte(0)) return null;
  const shares = sharesOnPriceBasis(filed, periodEnd, (await getSplits([companyId])).get(companyId));

  const { rows } = await pool.query(
    `SELECT close FROM prices_daily
     WHERE company_id = $1 AND close IS NOT NULL
     ORDER BY date DESC LIMIT 1`,
    [companyId]
  );
  if (rows.length === 0) return null;

  return new Decimal(rows[0].close).mul(shares);
}

export interface CompanyMetrics {
  periodEnd: string | null;
  raw: Map<string, Decimal>;
  derived: Map<string, Decimal>;
}

// The reported figures for the latest annual period and everything derived from
// them, computed on demand rather than read back from scores. A thesis checked
// against these reacts to a corrected fundamental straight away, without waiting
// for the next scoring run.
export async function latestMetrics(companyId: string): Promise<CompanyMetrics> {
  const periods = await annualPeriods(companyId);
  if (periods.length === 0) {
    return { periodEnd: null, raw: new Map(), derived: new Map() };
  }

  const [current, prior] = periods;
  const marketCap = await latestMarketCap(companyId, capitalisationShares(current.values), current.periodEnd);

  return {
    periodEnd: current.periodEnd,
    raw: current.values,
    derived: deriveMetrics({ current, prior, marketCap }),
  };
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
    const { derived } = await latestMetrics(company.id);
    if (derived.size === 0) continue;

    covered++;
    for (const [component, weight] of Object.entries(weights)) {
      const rawValue = derived.get(component);
      if (rawValue === undefined) continue;
      scoreRows.push({ companyId: company.id, component, rawValue, weight });
    }
  }

  if (scoreRows.length === 0) return { companies: 0, rows: 0 };

  // A rerun for the same date replaces that date's scores outright: a component
  // a company no longer has must not survive from the earlier run. Delete and
  // insert are one transaction, so a failed insert leaves the old rows intact.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM scores WHERE as_of = $1::date`, [asOf]);

    // Percentiles are ranked in SQL so the comparison always runs across the whole
    // stored universe, not whatever happens to be loaded in memory. A sector with a
    // single company has no peers to rank against, so it sits at the midpoint
    // instead of PERCENT_RANK's 0.
    await client.query(
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
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { companies: covered, rows: scoreRows.length };
}

export interface ScoreComponent {
  component: string;
  rawValue: number | null;
  percentile: number;
  weight: number;
  contribution: number;
  // true for a weighted component the company has no data for: it is counted
  // at the sector midpoint (0.5) rather than dropped, and is never evidence
  imputed?: boolean;
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
// alongside them, so there is no second copy of a number to drift. Every
// weighted component counts: one a company has no data for is passed in as an
// imputed midpoint, so a company reporting a single strong figure cannot
// outrank one that reports all of them by having its weight renormalised away.
export function weightedTotal(components: ScoreComponent[]): number {
  const weightUsed = components.reduce((sum, c) => sum + c.weight, 0);
  if (weightUsed === 0) return 0;

  const weighted = components.reduce((sum, c) => sum + c.percentile * c.weight, 0);
  return (weighted / weightUsed) * 100;
}

// The sector midpoint: no better and no worse than the median peer.
const IMPUTED_PERCENTILE = 0.5;

export async function getScores(): Promise<CompanyScore[]> {
  const { rows } = await pool.query(
    `SELECT s.company_id, c.ticker, c.name, c.sector, s.as_of,
            s.component, s.raw_value, s.percentile, s.weight
     FROM scores s
     JOIN companies c ON c.id = s.company_id
     WHERE s.as_of = (SELECT MAX(as_of) FROM scores)
     ORDER BY c.ticker, s.component`
  );

  const weights = loadWeights();
  const expected = Object.keys(weights).length;
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
    score.coverage.present = score.components.length;

    const present = new Set(score.components.map((c) => c.component));
    for (const [component, weight] of Object.entries(weights)) {
      if (present.has(component)) continue;
      score.components.push({
        component,
        rawValue: null,
        percentile: IMPUTED_PERCENTILE,
        weight,
        contribution: 0,
        imputed: true,
      });
    }

    score.total = weightedTotal(score.components);
    const weightUsed = score.components.reduce((sum, c) => sum + c.weight, 0);
    for (const component of score.components) {
      component.contribution =
        weightUsed === 0 ? 0 : (component.percentile * component.weight * 100) / weightUsed;
    }
  }

  scores.sort((a, b) => b.total - a.total);
  return scores;
}
