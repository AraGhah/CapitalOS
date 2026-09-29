import "../lib/env";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";

// Same pattern as the other migrations: IF NOT EXISTS throughout, safe to rerun.
async function main() {
  const sql = readFileSync("schema-lab.sql", "utf8");
  await pool.query(sql);
  console.log("lab schema applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
