import { pool, type Db } from "../db";
import { errorFields, log } from "../log";

/* ---------------------------------------------------------------------------
   Outside signals cannot be asked for a past date, so each reading is kept.
   A reading younger than the TTL is reused instead of fetched again, which is
   what keeps two committee runs on the same morning reading the same evidence.
--------------------------------------------------------------------------- */

export interface Snapshot<T> {
  payload: T;
  fetchedAt: string;
  // true when the reading came from a stored snapshot rather than the network
  cached: boolean;
}

export type SnapshotReader = <T>(
  source: string,
  key: string,
  ttlMinutes: number,
  fetcher: () => Promise<T>
) => Promise<Snapshot<T>>;

export const cachedSnapshot: SnapshotReader = async <T>(
  source: string,
  key: string,
  ttlMinutes: number,
  fetcher: () => Promise<T>,
  db: Db = pool
): Promise<Snapshot<T>> => {
  const { rows } = await db.query(
    `SELECT payload, fetched_at FROM signal_snapshots
     WHERE source = $1 AND key = $2 AND fetched_at > now() - make_interval(mins => $3)
     ORDER BY fetched_at DESC LIMIT 1`,
    [source, key, ttlMinutes]
  );
  if (rows[0]) {
    return { payload: rows[0].payload as T, fetchedAt: (rows[0].fetched_at as Date).toISOString(), cached: true };
  }

  const payload = await fetcher();
  try {
    const { rows: saved } = await db.query(
      `INSERT INTO signal_snapshots (source, key, payload) VALUES ($1, $2, $3::jsonb) RETURNING fetched_at`,
      [source, key.slice(0, 200), JSON.stringify(payload)]
    );
    return { payload, fetchedAt: (saved[0].fetched_at as Date).toISOString(), cached: false };
  } catch (err) {
    // The reading is good; failing to keep a copy must not discard it.
    log.warn({ ...errorFields(err), source }, "signal snapshot not stored");
    return { payload, fetchedAt: new Date().toISOString(), cached: false };
  }
};
