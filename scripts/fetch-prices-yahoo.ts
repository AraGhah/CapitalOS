import "../lib/env";
import { pool } from "../lib/db";
import { BENCHMARK_TICKER } from "../lib/constants";
import { fetchChart } from "../lib/quote";
import { fetchSplits, storeSplits } from "../lib/splits";

// The same job as fetch-prices.ts, against Yahoo's chart endpoint instead of Alpha
// Vantage, so daily bars can be filled without an API key. Range defaults to two
// years, which is enough history for the benchmark comparison.
//
//   npx tsx scripts/fetch-prices-yahoo.ts            every held or watched ticker
//   npx tsx scripts/fetch-prices-yahoo.ts MSFT NVDA  just these
//   RANGE=5y npx tsx scripts/fetch-prices-yahoo.ts

const RANGE = process.env.RANGE ?? "2y";
const GAP_MS = 1200;

// The benchmark has to exist as a company row before its bars can be stored, and
// it is an ETF, so no EDGAR ingest will ever create it.
async function ensureBenchmark(): Promise<void> {
  await pool.query(
    `INSERT INTO companies (ticker, name) VALUES ($1, $2)
     ON CONFLICT (ticker) DO NOTHING`,
    [BENCHMARK_TICKER, `${BENCHMARK_TICKER} (benchmark)`]
  );
}

async function tickersToFetch(): Promise<Array<{ id: string; ticker: string }>> {
  const asked = process.argv.slice(2).map((t) => t.toUpperCase());

  if (asked.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, ticker FROM companies WHERE upper(ticker) = ANY($1)`,
      [asked]
    );
    const found = new Set(rows.map((r) => r.ticker.toUpperCase()));
    for (const t of asked) {
      if (!found.has(t)) console.warn(`${t}: not in companies, skipped`);
    }
    return rows;
  }

  // The benchmark is always included: without it there is nothing to compare to.
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id, c.ticker
     FROM companies c
     WHERE c.ticker = $1
        OR EXISTS (SELECT 1 FROM transactions t WHERE t.company_id = c.id)
        OR EXISTS (SELECT 1 FROM watchlist w WHERE w.company_id = c.id)
     ORDER BY c.ticker`,
    [BENCHMARK_TICKER]
  );
  return rows;
}

async function store(companyId: string, ticker: string): Promise<number> {
  const chart = await fetchChart(ticker, RANGE);
  let written = 0;

  // A session still trading has a price, not a close; it is stored on the next
  // run once the session has ended.
  const bars = chart.lastBarComplete ? chart.bars : chart.bars.slice(0, -1);

  // Splits go in alongside the bars, so ledger quantities can be restated in
  // the same shares as these split-adjusted closes.
  try {
    await storeSplits(companyId, await fetchSplits(ticker));
  } catch (err) {
    console.warn(`${ticker}: splits not recorded (${err instanceof Error ? err.message : err})`);
  }

  for (const bar of bars) {
    const { rowCount } = await pool.query(
      `INSERT INTO prices_daily (company_id, date, open, high, low, close, volume, adj_close)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6)
       ON CONFLICT (company_id, date) DO UPDATE
         SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
             close = EXCLUDED.close, volume = EXCLUDED.volume, adj_close = EXCLUDED.adj_close`,
      [companyId, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume]
    );
    written += rowCount ?? 0;
  }

  return written;
}

async function main() {
  await ensureBenchmark();
  const targets = await tickersToFetch();
  if (targets.length === 0) {
    console.log("nothing to fetch — add a transaction or a watchlist entry first");
    await pool.end();
    return;
  }

  for (const [i, target] of targets.entries()) {
    try {
      const written = await store(target.id, target.ticker);
      console.log(`${target.ticker}: ${written} bars`);
    } catch (err) {
      console.error(`${target.ticker}: ${err instanceof Error ? err.message : err}`);
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
