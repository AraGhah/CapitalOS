import "../lib/env";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";

// Same pattern as migrate-desk: the file is IF NOT EXISTS throughout, so this is
// safe to run again after pulling a newer copy of it.
async function main() {
  const sql = readFileSync("schema-consensus.sql", "utf8");
  await pool.query(sql);
  console.log("consensus schema applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
