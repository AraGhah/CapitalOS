import { pool } from "../db";

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

export async function addJournal(entry: {
  companyId: string | null;
  kind: string;
  title: string;
  detail?: string | null;
  refId?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO decision_journal (company_id, kind, title, detail, ref_id) VALUES ($1, $2, $3, $4, $5)`,
      [entry.companyId, entry.kind, entry.title, entry.detail ?? null, entry.refId ?? null]
    );
  } catch {
    // The journal is a record of what happened, not a precondition for it: a
    // desk that has not run the consensus migration still works.
  }
}

export async function listJournal(opts: { companyId?: string; limit?: number } = {}): Promise<JournalEntry[]> {
  try {
    const { rows } = await pool.query(
      `SELECT j.id, c.ticker, j.created_at, j.kind, j.title, j.detail, j.ref_id
       FROM decision_journal j LEFT JOIN companies c ON c.id = j.company_id
       WHERE ($1::uuid IS NULL OR j.company_id = $1)
       ORDER BY j.created_at DESC, j.id DESC LIMIT $2`,
      [opts.companyId ?? null, opts.limit ?? 60]
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
  } catch {
    return [];
  }
}
