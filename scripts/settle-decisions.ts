import "../lib/env";
import { pool } from "../lib/db";
import { settleDecisions } from "../lib/track/data";

// Writes the outcome of every recorded decision whose horizon (5, 20 and 60
// sessions after its price date) has closed and has none yet. The worker does
// this every night as part of the recheck job; this is the by-hand version.
// Free: it reads stored decisions and stored closes, and calls no model. A
// horizon is written once and never changed, so running it again is harmless.
//
//   npm run settle-decisions
//
// Prices must be stored for the outcome to be measurable: run
// `npm run fetch-prices` first, which also stores the S&P 500 it is measured against.

async function main() {
  const report = await settleDecisions(null);
  console.log(`${report.considered} decisions have a horizon still to write.`);
  console.log(`wrote ${report.written} outcomes (${report.excluded} excluded as not fairly measurable); ${report.waiting} horizons have not closed yet.`);
  for (const s of report.settled) console.log(`  ${s.ticker.padEnd(6)} ${String(s.horizon).padStart(2)} sessions  ${s.verdict}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
