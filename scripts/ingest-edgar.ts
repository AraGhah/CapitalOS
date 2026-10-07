import "../lib/env";
import { pool } from "../lib/db";
import { cachedJson } from "../lib/sec";
import {
  filingUrl,
  padCik,
  parseFacts,
  sectorForSic,
  type CompanyFacts,
  type ParsedFact,
} from "../lib/edgar";

const REFRESH = process.argv.includes("--refresh");

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

async function loadTickerMap(): Promise<Map<string, TickerEntry>> {
  const data = (await cachedJson(
    "company-tickers",
    "https://www.sec.gov/files/company_tickers.json",
    REFRESH
  )) as Record<string, TickerEntry>;

  const map = new Map<string, TickerEntry>();
  for (const entry of Object.values(data)) {
    map.set(entry.ticker.toUpperCase(), entry);
  }
  return map;
}

interface Submissions {
  name: string;
  sic: string;
  sicDescription: string;
}

async function updateCompanyProfile(companyId: string, cik: number) {
  const subs = (await cachedJson(
    `submissions-${padCik(cik)}`,
    `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`,
    REFRESH
  )) as Submissions;

  await pool.query(
    `UPDATE companies
     SET cik = $2, name = $3, sector = $4, industry = $5
     WHERE id = $1`,
    [companyId, padCik(cik), subs.name, sectorForSic(subs.sic), subs.sicDescription ?? null]
  );
}

// One row per accession, dated by the latest period the filing reports on.
async function upsertFilings(companyId: string, cik: number, facts: ParsedFact[]): Promise<Map<string, string>> {
  interface FilingInfo {
    formType: string;
    filedAt: string;
    periodEnd: string;
  }

  const byAccession = new Map<string, FilingInfo>();
  for (const fact of facts) {
    const existing = byAccession.get(fact.accession);
    if (!existing) {
      byAccession.set(fact.accession, {
        formType: fact.form,
        filedAt: fact.filedAt,
        periodEnd: fact.periodEnd,
      });
    } else if (fact.periodEnd > existing.periodEnd) {
      existing.periodEnd = fact.periodEnd;
    }
  }

  const accessions = [...byAccession.keys()];
  if (accessions.length === 0) return new Map();

  await pool.query(
    `INSERT INTO filings (company_id, accession, form_type, filed_at, period_end, url)
     SELECT $1, accession, form_type, filed_at::date, period_end::date, url
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       AS t(accession, form_type, filed_at, period_end, url)
     ON CONFLICT (accession) DO NOTHING`,
    [
      companyId,
      accessions,
      accessions.map((a) => byAccession.get(a)!.formType),
      accessions.map((a) => byAccession.get(a)!.filedAt),
      accessions.map((a) => byAccession.get(a)!.periodEnd),
      accessions.map((a) => filingUrl(cik, a)),
    ]
  );

  const { rows } = await pool.query(`SELECT id, accession FROM filings WHERE accession = ANY($1)`, [
    accessions,
  ]);
  return new Map(rows.map((r) => [r.accession as string, r.id as string]));
}

function factKey(periodEnd: string, fiscalPeriod: string, metric: string, value: number, filingId: string) {
  return `${periodEnd}|${fiscalPeriod}|${metric}|${value}|${filingId}`;
}

// fundamentals is append only: an unchanged fact is skipped, a changed one lands
// as a new row next to the old, never over it.
async function insertFundamentals(companyId: string, facts: ParsedFact[], filingIds: Map<string, string>) {
  const { rows: existingRows } = await pool.query(
    `SELECT period_end, fiscal_period, metric, value, filing_id FROM fundamentals WHERE company_id = $1`,
    [companyId]
  );

  const seen = new Set(
    existingRows.map((r) =>
      factKey(
        (r.period_end as Date).toISOString().slice(0, 10),
        r.fiscal_period,
        r.metric,
        Number(r.value),
        r.filing_id
      )
    )
  );

  const fresh: Array<ParsedFact & { filingId: string }> = [];
  for (const fact of facts) {
    const filingId = filingIds.get(fact.accession);
    if (!filingId) continue;

    const key = factKey(fact.periodEnd, fact.fiscalPeriod, fact.metric, fact.value, filingId);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ ...fact, filingId });
  }

  if (fresh.length === 0) return 0;

  await pool.query(
    `INSERT INTO fundamentals (company_id, period_end, fiscal_period, metric, value, filing_id)
     SELECT $1, period_end::date, fiscal_period, metric, value, filing_id
     FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::uuid[])
       AS t(period_end, fiscal_period, metric, value, filing_id)
     ON CONFLICT DO NOTHING`,
    [
      companyId,
      fresh.map((f) => f.periodEnd),
      fresh.map((f) => f.fiscalPeriod),
      fresh.map((f) => f.metric),
      fresh.map((f) => f.value),
      fresh.map((f) => f.filingId),
    ]
  );

  return fresh.length;
}

async function main() {
  const { rows: companies } = await pool.query(
    "SELECT id, ticker FROM companies WHERE active = true ORDER BY ticker"
  );
  if (companies.length === 0) {
    console.log("no active companies to ingest");
    await pool.end();
    return;
  }

  const tickerMap = await loadTickerMap();

  for (const company of companies) {
    const entry = tickerMap.get((company.ticker as string).toUpperCase());
    if (!entry) {
      console.log(`${company.ticker}: no CIK on file with SEC, skipping`);
      continue;
    }

    try {
      await updateCompanyProfile(company.id, entry.cik_str);

      const facts = (await cachedJson(
        `facts-${padCik(entry.cik_str)}`,
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(entry.cik_str)}.json`,
        REFRESH
      )) as CompanyFacts;

      const parsed = parseFacts(facts);
      const filingIds = await upsertFilings(company.id, entry.cik_str, parsed);
      const inserted = await insertFundamentals(company.id, parsed, filingIds);

      console.log(
        `${company.ticker}: ${parsed.length} facts across ${filingIds.size} filings, ${inserted} new rows`
      );
    } catch (err) {
      console.error(`${company.ticker}: ${(err as Error).message}`);
    }
  }

  await pool.end();
}

main();
