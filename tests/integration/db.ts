import { pool } from "../../lib/db";

// Every table except the migration ledger, emptied between tests. Seed rows a
// migration inserted (the legacy owner) are put back by reseed().
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  if (rows.length === 0) return;
  await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await reseed();
}

async function reseed(): Promise<void> {
  const { rows } = await pool.query(`SELECT to_regclass('public.users') AS users`);
  if (!rows[0].users) return;
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ('00000000-0000-0000-0000-000000000001', 'owner@capitalos.local', 'Owner')
     ON CONFLICT DO NOTHING`
  );
  await pool.query(
    `INSERT INTO accounts (id, user_id, name, base_currency)
     VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Main', 'USD')
     ON CONFLICT DO NOTHING`
  );
}

export async function company(ticker: string, extra: { sector?: string; cik?: string } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO companies (ticker, name, sector, cik) VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [ticker, `${ticker} Inc`, extra.sector ?? "Technology", extra.cik ?? null]
  );
  return rows[0].id;
}
