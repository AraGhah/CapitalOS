import { pool, type Db } from "../db";
import { errorFields, log } from "../log";

/* ---------------------------------------------------------------------------
   The decision journal: one line per thing that happened to a company on this
   desk, written by the code path that did it. Kept free of other imports so
   anything — the theses check included — can write to it.
--------------------------------------------------------------------------- */

export interface JournalEntry {
  id: string;
  ticker: string | null;
  createdAt: string;
  kind: string;
  title: string;
  detail: string | null;
  refId: string | null;
}

export async function addJournal(
  entry: {
    userId: string;
    companyId: string | null;
    kind: string;
    title: string;
    detail?: string | null;
    refId?: string | null;
  },
  db: Db = pool
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO decision_journal (user_id, company_id, kind, title, detail, ref_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.userId, entry.companyId, entry.kind, entry.title.slice(0, 300), entry.detail?.slice(0, 4000) ?? null, entry.refId ?? null]
    );
  } catch (err) {
    // The journal records what happened; it is not a precondition for it. A
    // failed write is logged, never allowed to undo the action it describes.
    log.warn({ ...errorFields(err), kind: entry.kind }, "journal entry not written");
  }
}

export async function listJournal(
  userId: string,
  opts: { companyId?: string; limit?: number } = {}
): Promise<JournalEntry[]> {
  const { rows } = await pool.query(
    `SELECT j.id, c.ticker, j.created_at, j.kind, j.title, j.detail, j.ref_id
     FROM decision_journal j LEFT JOIN companies c ON c.id = j.company_id
     WHERE j.user_id = $1 AND ($2::uuid IS NULL OR j.company_id = $2)
     ORDER BY j.created_at DESC, j.id DESC LIMIT $3`,
    [userId, opts.companyId ?? null, opts.limit ?? 60]
  );
  return rows.map((r) => ({
    id: String(r.id),
    ticker: r.ticker,
    createdAt: (r.created_at as Date).toISOString(),
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    refId: r.ref_id,
  }));
}
