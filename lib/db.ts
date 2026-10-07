import { Pool, types, type PoolClient } from "pg";
import { config } from "./config";
import { errorFields, log } from "./log";

// node-pg turns a DATE into a Date at local midnight, and every caller reads it
// back with toISOString(), which is UTC. East of UTC that is the previous day.
// Parsing it as UTC midnight makes the round trip exact in any timezone.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => new Date(`${value}T00:00:00Z`));

function createPool(): Pool {
  const c = config();
  const p = new Pool({
    connectionString: c.DATABASE_URL,
    max: c.DATABASE_POOL_MAX,
    // A request never waits forever for a connection or a query.
    connectionTimeoutMillis: c.DATABASE_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: c.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 60_000,
    application_name: process.env.CAPITALOS_SERVICE ?? "capitalos",
  });

  // An idle client whose connection drops (a database restart, a network blip)
  // emits 'error' on the pool. Unhandled, that event kills the process; handled,
  // the pool discards the client and the next query reconnects.
  p.on("error", (err) => {
    log.error({ ...errorFields(err) }, "postgres idle client error");
  });
  return p;
}

// Created on first use, not on import: building the app imports every route
// module, and must not need a database or production secrets to do it.
let instance: Pool | null = null;
function getPool(): Pool {
  instance ??= createPool();
  return instance;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const p = getPool();
    const value = Reflect.get(p, prop, p);
    return typeof value === "function" ? value.bind(p) : value;
  },
});

export type Db = Pick<PoolClient, "query">;

/* ------------------------------------------------------------- transactions */

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // A connection that cannot even roll back is not handed to anyone else.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/* -------------------------------------------------------------------- locks */

// Named locks shared by every process on the database: the web server, the
// worker and the MCP server each keep their own memory, so a check followed by
// a write ("is there budget left? then start a run") is serialized here.
//
// Keys are strings hashed by Postgres, so a lock can be scoped to one user or
// one position ("ledger:<account>:<company>") without a registry of integers.
export const LOCKS = {
  committeeBudget: (userId: string) => `committee-budget:${userId}`,
  dossierBudget: (userId: string) => `dossier-budget:${userId}`,
  chatBudget: (userId: string) => `chat-budget:${userId}`,
  spend: (userId: string) => `spend:${userId}`,
  paperOrders: (userId: string) => `paper-orders:${userId}`,
  ledger: (accountId: string) => `ledger:${accountId}`,
  autopilot: (userId: string) => `autopilot:${userId}`,
  research: (ticker: string) => `research:${ticker.toUpperCase()}`,
  migrations: "schema-migrations",
} as const;

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`timed out waiting for "${key}"; another operation holds it`);
    this.name = "LockTimeoutError";
  }
}

// Runs fn inside a transaction that holds a transaction-scoped advisory lock.
// The critical section runs on the locked connection itself, so it never needs
// a second pooled connection while holding the lock — a pool full of waiters
// cannot starve the holder — and the lock is released by COMMIT or ROLLBACK,
// so it cannot leak back into the pool.
export async function withLock<T>(
  key: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${opts.timeoutMs ?? 10_000}ms`]);
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    } catch (err) {
      if ((err as { code?: string }).code === "55P03") throw new LockTimeoutError(key);
      throw err;
    }
    return fn(client);
  });
}

// A long-running job that should run once at a time across every process (an
// autopilot pass that may convene committees for minutes). Session-level, on a
// dedicated connection, so no transaction stays open for the whole run.
// Returns null when another holder has it.
export async function tryWithSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [key]);
    if (!rows[0].got) return null;
    try {
      return await fn();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } catch (err) {
        // Destroying the connection is what releases a session lock we could
        // not release by hand; returning it to the pool would leak the lock.
        broken = err as Error;
      }
    }
  } finally {
    client.release(broken);
  }
}

// For work that holds a lock for minutes (a research pipeline run): a
// session-level lock, so no transaction sits open while models are called.
// A waiter polls with pg_try_advisory_lock instead of blocking, and gives its
// connection back between attempts, so any number of waiters can never starve
// the holder of the connections its own work needs.
export async function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const poll = opts.pollMs ?? 500;
  for (;;) {
    const result = await tryWithSessionLock(key, async () => ({ value: await fn() }));
    if (result) return result.value;
    if (Date.now() >= deadline) throw new LockTimeoutError(key);
    await new Promise((r) => setTimeout(r, poll));
  }
}

export async function ping(): Promise<{ ok: true; latencyMs: number }> {
  const started = Date.now();
  await pool.query("SELECT 1");
  return { ok: true, latencyMs: Date.now() - started };
}
