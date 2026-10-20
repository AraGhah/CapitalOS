import type { Actor } from "../actor";
import { addJournal } from "../ai/journal";
import { audit } from "../audit";
import { pool, withTransaction } from "../db";
import { isUuid } from "../ids";
import { ACTION_LABEL, type Action, type Decision, type DecisionInput } from "./decide";
import type { DecisionRating } from "./rating";
import { RATING_LABEL } from "./rating";

/* ---------------------------------------------------------------------------
   Recorded decisions. Computing a decision (lib/decision/data.ts) writes
   nothing; the person records one, and it is kept with the inputs it came from
   and the price it was drawn at.
--------------------------------------------------------------------------- */

export interface RecordedDecision {
  id: string;
  ticker: string;
  runId: string | null;
  createdAt: string;
  rating: DecisionRating;
  action: Action;
  refPrice: number | null;
  priceAsOf: string | null;
  headline: string;
}

export async function recordDecision(
  actor: Pick<Actor, "userId">,
  record: { companyId: string; decision: Decision; input: DecisionInput; hash: string }
): Promise<{ id: string; duplicate: boolean }> {
  const { decision, input, hash, companyId } = record;
  const ref = decision.plan.reference;

  // The row and its audit entry are one transaction; the journal line is
  // written after and never undoes the record.
  const id = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO decisions (user_id, company_id, run_id, rating, action, ref_price, price_as_of, inputs_hash, inputs, decision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, run_id, inputs_hash) DO NOTHING
       RETURNING id`,
      [
        actor.userId,
        companyId,
        decision.runId,
        decision.rating.final,
        decision.action,
        ref !== null && ref > 0 ? ref : null,
        decision.plan.asOf,
        hash,
        JSON.stringify(input),
        JSON.stringify(decision),
      ]
    );
    const row = inserted.rows[0];
    if (!row) return null;
    await audit(client, actor, {
      action: "decision.record",
      entity: "decision",
      entityId: row.id as string,
      detail: { ticker: decision.ticker, rating: decision.rating.final, action: decision.action },
    });
    return row.id as string;
  });

  if (id) {
    await addJournal({
      userId: actor.userId,
      companyId,
      kind: "decision",
      title: `${decision.ticker}: ${RATING_LABEL[decision.rating.final]} → ${ACTION_LABEL[decision.action].toLowerCase()}`,
      detail: decision.headline,
      refId: id,
    });
    return { id, duplicate: false };
  }

  const { rows } = await pool.query(
    `SELECT id FROM decisions WHERE user_id = $1 AND run_id IS NOT DISTINCT FROM $2 AND inputs_hash = $3`,
    [actor.userId, decision.runId, hash]
  );
  return { id: rows[0].id as string, duplicate: true };
}

export async function listDecisions(
  userId: string,
  opts: { companyId?: string; ticker?: string; limit?: number } = {}
): Promise<RecordedDecision[]> {
  const { rows } = await pool.query(
    `SELECT d.id, c.ticker, d.run_id, d.created_at, d.rating, d.action, d.ref_price, d.price_as_of,
            d.decision->>'headline' AS headline
     FROM decisions d JOIN companies c ON c.id = d.company_id
     WHERE d.user_id = $1
       AND ($2::uuid IS NULL OR d.company_id = $2)
       AND ($3::text IS NULL OR c.ticker = upper($3))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $4`,
    [userId, opts.companyId ?? null, opts.ticker ?? null, Math.min(opts.limit ?? 20, 200)]
  );
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    runId: r.run_id,
    createdAt: (r.created_at as Date).toISOString(),
    rating: r.rating,
    action: r.action,
    refPrice: r.ref_price === null ? null : Number(r.ref_price),
    priceAsOf: r.price_as_of === null ? null : (r.price_as_of as Date).toISOString().slice(0, 10),
    headline: r.headline ?? "",
  }));
}

export async function getDecision(userId: string, id: string): Promise<{ summary: RecordedDecision; decision: Decision; input: DecisionInput } | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query(
    `SELECT d.id, c.ticker, d.run_id, d.created_at, d.rating, d.action, d.ref_price, d.price_as_of, d.inputs, d.decision
     FROM decisions d JOIN companies c ON c.id = d.company_id
     WHERE d.id = $1 AND d.user_id = $2`,
    [id, userId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    summary: {
      id: r.id,
      ticker: r.ticker,
      runId: r.run_id,
      createdAt: (r.created_at as Date).toISOString(),
      rating: r.rating,
      action: r.action,
      refPrice: r.ref_price === null ? null : Number(r.ref_price),
      priceAsOf: r.price_as_of === null ? null : (r.price_as_of as Date).toISOString().slice(0, 10),
      headline: (r.decision as Decision).headline ?? "",
    },
    decision: r.decision as Decision,
    input: r.inputs as DecisionInput,
  };
}
