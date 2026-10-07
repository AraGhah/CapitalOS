import { Pool } from "pg";
import { migrate } from "../../lib/migrate";

// A clean schema, every migration applied, once per test run. The test database
// is disposable: TEST_DATABASE_URL must never point at real data.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start a throwaway Postgres (see docs/testing.md) and point TEST_DATABASE_URL at it."
    );
  }
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a database with 'test' in it, so a real database is never wiped");
  }
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
