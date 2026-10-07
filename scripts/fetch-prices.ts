import "../lib/env";
import { pool } from "../lib/db";
import { ensureBenchmark, refreshPrices, trackedForPrices } from "../lib/market/ingest";
import type { Range } from "../lib/market/data";

// Daily bars, splits and dividends from the configured market-data provider
// (MARKET_DATA_PROVIDER; see lib/market/data.ts). The worker runs the same
// refresh every evening; this is the by-hand version.
//
//   npm run fetch-prices              every held or watched ticker
//   npm run fetch-prices -- MSFT NVDA just these
//   RANGE=5y npm run fetch-prices     a longer history (default 2y)

const RANGE = (process.env.RANGE ?? "2y") as Range;

async function main() {
  await ensureBenchmark();
  const asked = process.argv.slice(2).map((t) => t.toUpperCase());
  let targets = await trackedForPrices();
  if (asked.length > 0) {
    const { rows } = await pool.query(`SELECT id, ticker FROM companies WHERE ticker = ANY($1)`, [asked]);
    for (const t of asked) if (!rows.some((r) => r.ticker === t)) console.warn(`${t}: not in companies, skipped`);
    targets = rows;
  }
  if (targets.length === 0) {
    console.log("nothing to fetch — add a transaction or a watchlist entry first");
    return;
  }

  for (const target of targets) {
    try {
      const r = await refreshPrices(target.id, target.ticker, RANGE);
      console.log(
        `${r.ticker}: ${r.bars} bars from ${r.source}${r.newSplits ? `, ${r.newSplits} new splits` : ""}` +
          `${r.refetchedHistory ? " (history refetched onto the new split basis)" : ""}, ${r.dividends} dividends`
      );
    } catch (err) {
      console.error(`${target.ticker}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
