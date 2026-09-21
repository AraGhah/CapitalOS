import "../lib/env";
import { pool } from "../lib/db";
import { computeScores } from "../lib/scoring";

async function main() {
  const asOf = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`usage: tsx scripts/compute-scores.ts [YYYY-MM-DD]`);
    process.exit(1);
  }

  const { companies, rows } = await computeScores(asOf);
  console.log(`scored ${companies} companies, ${rows} component rows as of ${asOf}`);

  await pool.end();
}

main();
