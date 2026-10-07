import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { LOCKS, pool, withLock, type Db } from "./db";
import { audit } from "./audit";
import type { Actor } from "./actor";
import { compareTxns } from "./portfolio";
import { getSplits, splitFactor } from "./splits";

/* ---------------------------------------------------------------------------
   The ledger's write path.

   A position is valid only if its running quantity never goes below zero at
   any moment of its history — not just on the date of the trade being
   entered. A sell backdated to Oct 3 is checked against everything after Oct
   3 too: if a later sell already used those shares, the new one is refused.
   A void is checked the same way, since voiding a buy can strand the sells
   that came after it.

   The check and the write run under one lock per account, on the locked
   connection, inside one transaction with the audit row. Two sells submitted
   together are therefore checked one after the other, never both against the
   same starting quantity.
--------------------------------------------------------------------------- */

export interface LedgerEntry {
  side: "buy" | "sell";
  // In today's shares, so a split between two trades does not read as a
  // change in the position.
  qty: Decimal;
  executedAt: Date;
  // insertion order, the last tie-break
  seq: number;
}

export type ReplayResult =
  | { ok: true; final: Decimal }
  | { ok: false; violation: { at: Date; shortfall: Decimal; held: Decimal } };

// Shares can be fractional (NUMERIC(14,4)); anything below this is rounding.
const EPSILON = new Decimal("1e-9");

export function replayPosition(entries: LedgerEntry[]): ReplayResult {
  const sorted = [...entries].sort((a, b) => compareTxns(a, b) || a.seq - b.seq);
  let running = new Decimal(0);
  for (const entry of sorted) {
    const before = running;
    running = entry.side === "buy" ? running.add(entry.qty) : running.sub(entry.qty);
    if (running.lt(EPSILON.neg())) {
      return { ok: false, violation: { at: entry.executedAt, shortfall: running.neg(), held: before } };
    }
  }
  return { ok: true, final: running };
}

export class LedgerError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

interface Row {
  id: string;
  side: "buy" | "sell";
  qty: string;
  executed_at: Date;
}

async function positionTimeline(db: Db, accountId: string, companyId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `SELECT id, side, qty, executed_at FROM transactions
     WHERE account_id = $1 AND company_id = $2 AND voided_at IS NULL
     ORDER BY executed_at, created_at, id`,
    [accountId, companyId]
  );
  return rows;
}

async function toEntries(db: Db, companyId: string, rows: Array<Pick<Row, "side" | "qty" | "executed_at">>): Promise<LedgerEntry[]> {
  const splits = (await getSplits([companyId], db)).get(companyId);
  return rows.map((r, seq) => ({
    side: r.side,
    qty: new Decimal(r.qty).mul(splitFactor(splits, r.executed_at.toISOString().slice(0, 10))),
    executedAt: r.executed_at,
    seq,
  }));
}

function describe(v: { at: Date; shortfall: Decimal; held: Decimal }, ticker: string): string {
  const day = v.at.toISOString().slice(0, 10);
  return `this would leave ${ticker} short by ${v.shortfall.toString()} shares on ${day} (only ${v.held.toString()} held then, in today's shares); a sell cannot use shares a later trade already sold`;
}

export async function assertAccountOwned(db: Db, userId: string, accountId: string): Promise<void> {
  const { rowCount } = await db.query(`SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2`, [accountId, userId]);
  if (!rowCount) throw new NotFoundError("no such account");
}

export interface NewTransaction {
  companyId: string;
  ticker: string;
  side: "buy" | "sell";
  qty: Decimal;
  price: Decimal;
  fees: Decimal;
  executedAt: Date;
  note?: string | null;
  idempotencyKey?: string | null;
}

export async function recordTransaction(
  actor: Actor,
  input: NewTransaction
): Promise<{ id: string; duplicate: boolean }> {
  return withLock(LOCKS.ledger(actor.accountId), async (client: PoolClient) => {
    await assertAccountOwned(client, actor.userId, actor.accountId);

    if (input.idempotencyKey) {
      const { rows } = await client.query(
        `SELECT id FROM transactions WHERE account_id = $1 AND idempotency_key = $2`,
        [actor.accountId, input.idempotencyKey]
      );
      if (rows[0]) return { id: rows[0].id as string, duplicate: true };
    }

    const existing = await positionTimeline(client, actor.accountId, input.companyId);
    const entries = await toEntries(client, input.companyId, [
      ...existing,
      { side: input.side, qty: input.qty.toString(), executed_at: input.executedAt },
    ]);
    const replay = replayPosition(entries);
    if (!replay.ok) throw new LedgerError(describe(replay.violation, input.ticker));

    // A trade is priced in its listing's currency.
    const { rows } = await client.query(
      `INSERT INTO transactions (account_id, company_id, side, qty, price, fees, executed_at,
                                 created_by, idempotency_key, note, currency)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, c.currency FROM companies c WHERE c.id = $2
       RETURNING id`,
      [
        actor.accountId,
        input.companyId,
        input.side,
        input.qty.toString(),
        input.price.toString(),
        input.fees.toString(),
        input.executedAt.toISOString(),
        actor.userId,
        input.idempotencyKey ?? null,
        input.note ?? null,
      ]
    );
    const id = rows[0].id as string;

    await audit(client, actor, {
      action: "transaction.create",
      entity: "transaction",
      entityId: id,
      detail: {
        accountId: actor.accountId,
        ticker: input.ticker,
        side: input.side,
        qty: input.qty.toString(),
        price: input.price.toString(),
        fees: input.fees.toString(),
        executedAt: input.executedAt.toISOString(),
      },
    });
    return { id, duplicate: false };
  });
}

export async function voidTransaction(actor: Actor, transactionId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new LedgerError("a void needs a reason");

  // Which account the row is in decides which lock to take, so it is looked up
  // first and re-checked under the lock.
  const { rows: found } = await pool.query(
    `SELECT t.account_id FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = $1 AND a.user_id = $2`,
    [transactionId, actor.userId]
  );
  if (!found[0]) throw new NotFoundError("no such transaction");
  const accountId = found[0].account_id as string;

  await withLock(LOCKS.ledger(accountId), async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.company_id, t.voided_at, c.ticker
       FROM transactions t JOIN companies c ON c.id = t.company_id
       WHERE t.id = $1 AND t.account_id = $2`,
      [transactionId, accountId]
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("no such transaction");
    if (row.voided_at) throw new LedgerError("this transaction is already voided");

    const remaining = (await positionTimeline(client, accountId, row.company_id)).filter((r) => r.id !== transactionId);
    const replay = replayPosition(await toEntries(client, row.company_id, remaining));
    if (!replay.ok) {
      throw new LedgerError(`voiding it would strand a later sell: ${describe(replay.violation, row.ticker)}`);
    }

    await client.query(
      `UPDATE transactions SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
      [transactionId, actor.userId, trimmed.slice(0, 500)]
    );
    await audit(client, actor, {
      action: "transaction.void",
      entity: "transaction",
      entityId: transactionId,
      detail: { accountId, reason: trimmed.slice(0, 500) },
    });
  });
}

export interface TransactionView {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  fees: string;
  executedAt: string;
  createdAt: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export async function listTransactions(
  actor: Pick<Actor, "userId" | "accountId">,
  opts: { ticker?: string; limit?: number; includeVoided?: boolean } = {}
): Promise<TransactionView[]> {
  const { rows } = await pool.query(
    `SELECT t.id, c.ticker, t.side, t.qty, t.price, t.fees, t.executed_at, t.created_at, t.note,
            t.voided_at, t.void_reason
     FROM transactions t
     JOIN companies c ON c.id = t.company_id
     JOIN accounts a ON a.id = t.account_id
     WHERE t.account_id = $1 AND a.user_id = $2
       AND ($3::text IS NULL OR upper(c.ticker) = upper($3))
       AND ($4::boolean OR t.voided_at IS NULL)
     ORDER BY t.executed_at DESC, t.created_at DESC
     LIMIT $5`,
    [actor.accountId, actor.userId, opts.ticker ?? null, opts.includeVoided ?? false, opts.limit ?? 100]
  );
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    side: r.side,
    qty: String(r.qty),
    price: String(r.price),
    fees: String(r.fees),
    executedAt: (r.executed_at as Date).toISOString(),
    createdAt: (r.created_at as Date).toISOString(),
    note: r.note,
    voidedAt: r.voided_at ? (r.voided_at as Date).toISOString() : null,
    voidReason: r.void_reason,
  }));
}
