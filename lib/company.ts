import { pool } from "./db";

// Every tool reports what it read from, so a claim can be traced back to a filing
// or a table rather than to the model's memory.
export interface ToolSource {
  kind:
    | "filing"
    | "prices_daily"
    | "transactions"
    | "scores"
    | "companies"
    | "watchlist"
    | "macro_series"
    | "sources";
  ref: string;
  id?: string;
  url?: string;
}

export interface CompanyRow {
  id: string;
  ticker: string;
  name: string;
  cik: string | null;
  sector: string | null;
  industry: string | null;
  active: boolean;
}

export async function findCompany(ticker: string): Promise<CompanyRow | null> {
  const { rows } = await pool.query(
    `SELECT id, ticker, name, cik, sector, industry, active
     FROM companies WHERE ticker = upper($1)`,
    [ticker.trim()]
  );
  return rows[0] ?? null;
}

export function companySource(company: CompanyRow): ToolSource {
  return { kind: "companies", ref: company.ticker, id: company.id };
}

export interface FundamentalRow {
  metric: string;
  periodEnd: string;
  fiscalPeriod: string;
  value: string;
  accession: string | null;
  formType: string | null;
  filedAt: string | null;
}

// DISTINCT ON keeps the value from the most recently filed report covering each
// period, so a restatement supersedes the original without either row being lost.
export async function getFundamentals(
  companyId: string,
  opts: { metrics?: string[]; fiscalPeriod?: string; periods?: number } = {}
): Promise<{ rows: FundamentalRow[]; sources: ToolSource[] }> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (f.metric, f.period_end)
            f.metric, f.period_end, f.fiscal_period, f.value,
            fl.id AS filing_id, fl.accession, fl.form_type, fl.filed_at, fl.url
     FROM fundamentals f
     LEFT JOIN filings fl ON fl.id = f.filing_id
     WHERE f.company_id = $1
       AND f.value IS NOT NULL
       AND ($2::text IS NULL OR f.fiscal_period = $2)
       AND ($3::text[] IS NULL OR f.metric = ANY($3))
     ORDER BY f.metric, f.period_end DESC, fl.filed_at DESC NULLS LAST, f.retrieved_at DESC`,
    [companyId, opts.fiscalPeriod ?? null, opts.metrics?.length ? opts.metrics : null]
  );

  const periodLimit = opts.periods ?? 5;
  const keptPeriods = [...new Set(rows.map((r) => (r.period_end as Date).toISOString().slice(0, 10)))]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, periodLimit);
  const keep = new Set(keptPeriods);

  const out: FundamentalRow[] = [];
  const sources = new Map<string, ToolSource>();

  for (const row of rows) {
    const periodEnd = (row.period_end as Date).toISOString().slice(0, 10);
    if (!keep.has(periodEnd)) continue;

    out.push({
      metric: row.metric,
      periodEnd,
      fiscalPeriod: row.fiscal_period,
      value: row.value,
      accession: row.accession,
      formType: row.form_type,
      filedAt: row.filed_at ? (row.filed_at as Date).toISOString().slice(0, 10) : null,
    });

    if (row.accession && !sources.has(row.accession)) {
      sources.set(row.accession, {
        kind: "filing",
        ref: row.accession,
        id: row.filing_id,
        url: row.url ?? undefined,
      });
    }
  }

  out.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.metric.localeCompare(b.metric));
  return { rows: out, sources: [...sources.values()] };
}

export interface FilingRow {
  id: string;
  accession: string;
  formType: string;
  filedAt: string;
  periodEnd: string | null;
  url: string | null;
}

export async function getFilings(
  companyId: string,
  opts: { formType?: string; limit?: number } = {}
): Promise<FilingRow[]> {
  const { rows } = await pool.query(
    `SELECT id, accession, form_type, filed_at, period_end, url
     FROM filings
     WHERE company_id = $1 AND ($2::text IS NULL OR form_type = $2)
     ORDER BY filed_at DESC
     LIMIT $3`,
    [companyId, opts.formType ?? null, opts.limit ?? 20]
  );

  return rows.map((r) => ({
    id: r.id,
    accession: r.accession,
    formType: r.form_type,
    filedAt: (r.filed_at as Date).toISOString().slice(0, 10),
    periodEnd: r.period_end ? (r.period_end as Date).toISOString().slice(0, 10) : null,
    url: r.url,
  }));
}

export interface PriceBarRow {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
}

export async function getPriceHistory(
  companyId: string,
  opts: { start?: string; end?: string; limit?: number } = {}
): Promise<PriceBarRow[]> {
  const { rows } = await pool.query(
    `SELECT date, open, high, low, close, volume
     FROM prices_daily
     WHERE company_id = $1
       AND ($2::date IS NULL OR date >= $2)
       AND ($3::date IS NULL OR date <= $3)
     ORDER BY date DESC
     LIMIT $4`,
    [companyId, opts.start ?? null, opts.end ?? null, opts.limit ?? 120]
  );

  return rows
    .map((r) => ({
      date: (r.date as Date).toISOString().slice(0, 10),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume === null ? null : String(r.volume),
    }))
    .reverse();
}

export async function getWatchlist(userId: string) {
  const { rows } = await pool.query(
    `SELECT c.ticker, c.name, c.sector, w.added_at, w.note
     FROM watchlist w
     JOIN companies c ON c.id = w.company_id
     WHERE w.user_id = $1
     ORDER BY c.ticker`,
    [userId]
  );
  return rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    addedAt: (r.added_at as Date).toISOString(),
    note: r.note,
  }));
}

// A note is only replaced when one is given, so researching a ticker that is
// already watched does not wipe the note written for it.
export async function addToWatchlist(userId: string, companyId: string, note: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO watchlist (user_id, company_id, note) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, company_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, watchlist.note)`,
    [userId, companyId, note]
  );
}

export async function removeFromWatchlist(userId: string, companyId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM watchlist WHERE user_id = $1 AND company_id = $2`, [
    userId,
    companyId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function listMacroSeriesIds(): Promise<Array<{ seriesId: string; observations: number; latest: string }>> {
  const { rows } = await pool.query(
    `SELECT series_id, count(*) AS observations, max(date) AS latest
     FROM macro_series GROUP BY series_id ORDER BY series_id`
  );
  return rows.map((r) => ({
    seriesId: r.series_id,
    observations: Number(r.observations),
    latest: (r.latest as Date).toISOString().slice(0, 10),
  }));
}

export async function getMacroSeries(
  seriesId: string,
  opts: { start?: string; end?: string; limit?: number } = {}
) {
  const { rows } = await pool.query(
    `SELECT date, value FROM macro_series
     WHERE series_id = $1
       AND ($2::date IS NULL OR date >= $2)
       AND ($3::date IS NULL OR date <= $3)
     ORDER BY date DESC
     LIMIT $4`,
    [seriesId, opts.start ?? null, opts.end ?? null, opts.limit ?? 120]
  );
  return rows
    .map((r) => ({ date: (r.date as Date).toISOString().slice(0, 10), value: r.value }))
    .reverse();
}
