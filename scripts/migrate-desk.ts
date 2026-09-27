import "../lib/env";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";

// schema-desk.sql is written with IF NOT EXISTS throughout, so running this more
// than once is harmless and there is only ever one copy of those statements.
async function main() {
  const sql = readFileSync("schema-desk.sql", "utf8");
  await pool.query(sql);
  console.log("desk schema applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
