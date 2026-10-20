import { findCompany } from "../company";
import { BENCHMARK_TICKER } from "../constants";
import { pool } from "../db";
import { errorFields, log } from "../log";
import { priceSeries, type PriceSeries } from "../price-series";
import { quartersFrom, readDrift, type Bar, type DriftRead, type FactRow } from "./drift";

/* ---------------------------------------------------------------------------
   Gathers what the post-earnings drift read needs — the company's quarterly
   earnings per share as each filing reported them, the days it announced
   earnings, and a year of daily closes of the stock and of the S&P 500 — and
   hands it to lib/earnings/drift.ts, which does the reading. No model is
   called. A source that fails comes through as absent, and the read says so.

   The closes are read the way the technical read and the evidence pack read
   them (lib/price-series): the desk's own bars while they are fresh, the
   provider only when they are not, and complete sessions only, so the same
   figures come out of the research page, the API and a committee's evidence.
--------------------------------------------------------------------------- */

export interface EarningsRead {
  ticker: string;
  drift: DriftRead;
  // where the stock's closes came from, e.g. "prices_daily table"
  ref: string | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function quarterlyFacts(companyId: string): Promise<FactRow[]> {
  // Only quarters (three-month facts), and only the metrics the surprise reads.
  // The filing is kept with each row: a filing's quarter and its year-ago
  // comparative are read together so they share a share basis.
  const { rows } = await pool.query(
    `SELECT fl.accession, fl.form_type, fl.filed_at, f.metric, f.period_end, f.value
     FROM fundamentals f
     JOIN filings fl ON fl.id = f.filing_id
     WHERE f.company_id = $1
       AND f.fiscal_period = 'Q'
       AND f.metric IN ('eps_diluted', 'net_income', 'shares_diluted')
       AND f.value IS NOT NULL
     ORDER BY fl.filed_at, f.id`,
    [companyId]
  );
  return rows.map((r) => ({
    accession: r.accession,
    form: r.form_type,
    filedOn: iso(r.filed_at as Date),
    metric: r.metric,
    periodEnd: iso(r.period_end as Date),
    value: Number(r.value),
  }));
}

// The days of the company's earnings releases. A database that has not run the
// newest migration, or has not ingested the 8-Ks, has none; the read then dates
// each announcement by the 10-Q and says so.
async function storedReleases(companyId: string): Promise<string[]> {
  try {
    const { rows } = await pool.query(`SELECT announced_on FROM earnings_releases WHERE company_id = $1 ORDER BY announced_on`, [companyId]);
    return rows.map((r) => iso(r.announced_on as Date));
  } catch (err) {
    log.warn({ ...errorFields(err), companyId }, "earnings releases could not be read; announcements will be dated by the periodic filing");
    return [];
  }
}

async function latestReport(companyId: string): Promise<{ form: string; filedOn: string } | null> {
  const { rows } = await pool.query(
    `SELECT form_type, filed_at FROM filings WHERE company_id = $1 AND form_type ~ '^10-[KQ]' ORDER BY filed_at DESC LIMIT 1`,
    [companyId]
  );
  return rows[0] ? { form: rows[0].form_type, filedOn: iso(rows[0].filed_at as Date) } : null;
}

const completeCloses = (series: PriceSeries | null): Bar[] => (series?.technicalBars ?? []).map((b) => ({ date: b.date, close: b.close }));

// The S&P 500 as the desk stores it; the provider is asked only when it is not stored or has gone stale.
async function benchmark(): Promise<PriceSeries | null> {
  const stored = await findCompany(BENCHMARK_TICKER).catch(() => null);
  return priceSeries({ id: stored?.id ?? null, ticker: BENCHMARK_TICKER }).catch(() => null);
}

// `prices` is the stock's series when the caller already holds it (the evidence pack does).
export async function earningsRead(company: { id: string; ticker: string }, prices?: PriceSeries): Promise<EarningsRead> {
  const [facts, releases, report, stock, market] = await Promise.all([
    quarterlyFacts(company.id),
    storedReleases(company.id),
    latestReport(company.id),
    prices ?? priceSeries(company).catch(() => null),
    benchmark(),
  ]);

  return {
    ticker: company.ticker,
    drift: readDrift({
      quarters: quartersFrom(facts),
      releases,
      stock: completeCloses(stock),
      market: market ? completeCloses(market) : null,
      latestReport: report,
    }),
    ref: stock?.ref ?? null,
  };
}
