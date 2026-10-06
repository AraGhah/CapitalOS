import { Pool, types } from "pg";

// node-pg turns a DATE into a Date at local midnight, and every caller reads it
// back with toISOString(), which is UTC. East of UTC that is the previous day.
// Parsing it as UTC midnight makes the round trip exact in any timezone.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => new Date(`${value}T00:00:00Z`));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Named locks shared by every process on the database: the web server, the
// autopilot and the MCP server each keep their own memory, so a check followed
// by a write ("is there budget left? then start a run") has to be serialized
// here rather than in any one of them.
export const LOCKS = {
  committeeBudget: 7301,
  paperOrders: 7302,
  autopilotCycle: 7303,
  dossierBudget: 7304,
} as const;

export async function withLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}

// Runs fn only if no other holder has the lock; returns null when skipped.
export async function tryWithLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got", [key]);
    if (!rows[0].got) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}
