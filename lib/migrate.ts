import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

/* ---------------------------------------------------------------------------
   Versioned migrations.

   migrations/NNNN_name.sql, applied in order, each exactly once, each in its
   own transaction, recorded in schema_migrations with a checksum. Every
   process that migrates takes the same advisory lock first, so two deploys
   cannot apply the same file at once. A file whose contents changed after it
   was applied is refused: an applied migration is history, and the fix for a
   mistake in one is the next migration.

   A file whose first line is `-- migrate:no-transaction` runs outside a
   transaction, for statements Postgres forbids inside one (CREATE INDEX
   CONCURRENTLY).
--------------------------------------------------------------------------- */

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrationResult {
  applied: Array<{ version: string; name: string; ms: number }>;
  skipped: number;
}

export class MigrationDriftError extends Error {
  constructor(version: string) {
    super(`migration ${version} was edited after it was applied; write a new migration instead`);
    this.name = "MigrationDriftError";
  }
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = join(process.cwd(), "migrations")): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const match = file.match(FILE);
    if (!match) throw new Error(`migration file "${file}" is not named NNNN_name.sql`);
    const [, version, name] = match;
    if (seen.has(version)) throw new Error(`two migrations share version ${version}`);
    seen.add(version);
    // Line endings are normalised so a checkout on Windows and one on Linux
    // agree on the checksum.
    const sql = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    return {
      version,
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
      transactional: !sql.startsWith("-- migrate:no-transaction"),
    };
  });
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_ms INTEGER NOT NULL
    )`);
}

export async function pendingMigrations(pool: Pool, migrations = loadMigrations()): Promise<Migration[]> {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query(`SELECT version FROM schema_migrations`);
    const applied = new Set(rows.map((r) => r.version as string));
    return migrations.filter((m) => !applied.has(m.version));
  } finally {
    client.release();
  }
}

export async function migrate(
  pool: Pool,
  opts: { migrations?: Migration[]; log?: (line: string) => void } = {}
): Promise<MigrationResult> {
  const migrations = opts.migrations ?? loadMigrations();
  const say = opts.log ?? (() => {});
  const client = await pool.connect();
  let broken: Error | undefined;

  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('schema-migrations'))`);
    try {
      await ensureTable(client);
      const { rows } = await client.query(`SELECT version, checksum FROM schema_migrations`);
      const applied = new Map(rows.map((r) => [r.version as string, r.checksum as string]));

      const result: MigrationResult = { applied: [], skipped: 0 };
      for (const m of migrations) {
        const prior = applied.get(m.version);
        if (prior !== undefined) {
          if (prior !== m.checksum) throw new MigrationDriftError(m.version);
          result.skipped++;
          continue;
        }

        const started = Date.now();
        if (m.transactional) await client.query("BEGIN");
        try {
          await client.query(m.sql);
          const ms = Date.now() - started;
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)`,
            [m.version, m.name, m.checksum, ms]
          );
          if (m.transactional) await client.query("COMMIT");
          result.applied.push({ version: m.version, name: m.name, ms });
          say(`${m.version}_${m.name} applied in ${ms} ms`);
        } catch (err) {
          if (m.transactional) await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(`migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
        }
      }
      return result;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('schema-migrations'))`).catch((err) => {
        broken = err as Error;
      });
    }
  } finally {
    client.release(broken);
  }
}
