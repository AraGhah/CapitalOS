import "../lib/env";
import { pool } from "../lib/db";
import { checkMemory } from "../lib/ai/memory";

// Run after ingest-edgar. Settles every remembered assumption that a newer
// annual period can now answer, and writes each result to the journal.
async function main() {
  const result = await checkMemory();

  for (const s of result.settled) {
    console.log(`${s.ticker}: ${s.status === "supported" ? "held" : "broke"} — ${s.statement} (actual ${s.actual})`);
  }
  console.log(
    `checked ${result.checked} pending assumptions: ${result.settled.length} settled, ${result.waiting} still waiting for a newer filing`
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
