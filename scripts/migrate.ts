import "../lib/env";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";

// Every layer written with IF NOT EXISTS, in dependency order. schema.sql is not
// here: it creates the base tables without guards and is applied once, by hand,
// as the README says.
const LAYERS = [
  "schema-desk.sql",
  "schema-consensus.sql",
  "schema-lab.sql",
  "schema-autopilot.sql",
  "schema-hardening.sql",
];

async function main() {
  const only = process.argv[2];
  for (const file of only ? [only] : LAYERS) {
    await pool.query(readFileSync(file, "utf8"));
    console.log(`${file} applied`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
