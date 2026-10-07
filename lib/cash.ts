import Decimal from "decimal.js";
import { LOCKS, pool, withLock } from "./db";
import { audit } from "./audit";
import type { Actor } from "./actor";
import { assertAccountOwned, LedgerError, NotFoundError } from "./ledger";

/* ---------------------------------------------------------------------------
   Cash movements: deposits, withdrawals, dividends, interest, fees and tax.
   Same rules as the trade ledger — written under the account's lock with an
   audit row, idempotent on a key, never deleted (voided instead).

   Recording the first one switches the account to tracking cash: from then on
   it is valued as positions plus cash, and its returns are measured against
   deposits and withdrawals rather than against each trade.
--------------------------------------------------------------------------- */

export type CashKind = "deposit" | "withdrawal" | "dividend" | "interest" | "fee" | "tax";

export interface NewCashMovement {
  kind: CashKind;
  amount: Decimal;
  currency: string;
  occurredAt: Date;
  companyId?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
  externalId?: string | null;
}

export async function recordCashMovement(actor: Actor, input: NewCashMovement): Promise<{ id: string; duplicate: boolean }> {
  if (input.amount.lte(0)) throw new LedgerError("an amount must be positive; the kind says which way it moved");
  if (input.kind === "dividend" && !input.companyId) throw new LedgerError("a dividend needs the company that paid it");

  return withLock(LOCKS.ledger(actor.accountId), async (client) => {
    await assertAccountOwned(client, actor.userId, actor.accountId);

    if (input.idempotencyKey) {
      const { rows } = await client.query(
        `SELECT id FROM cash_movements WHERE account_id = $1 AND idempotency_key = $2`,
        [actor.accountId, input.idempotencyKey]
      );
      if (rows[0]) return { id: rows[0].id as string, duplicate: true };
    }

    const { rows } = await client.query(
      `INSERT INTO cash_movements (account_id, kind, amount, currency, occurred_at, company_id, note, idempotency_key, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        actor.accountId,
        input.kind,
        input.amount.toString(),
        input.currency,
        input.occurredAt.toISOString(),
        input.companyId ?? null,
        input.note ?? null,
        input.idempotencyKey ?? null,
        input.externalId ?? null,
        actor.userId,
      ]
    );
    const { rowCount: switched } = await client.query(
      `UPDATE accounts SET tracks_cash = true WHERE id = $1 AND NOT tracks_cash`,
      [actor.accountId]
    );
    await audit(client, actor, {
      action: "cash.create",
      entity: "cash_movement",
      entityId: rows[0].id,
      detail: { kind: input.kind, amount: input.amount.toString(), currency: input.currency, startedTrackingCash: Boolean(switched) },
    });
    return { id: rows[0].id as string, duplicate: false };
  });
}

export async function voidCashMovement(actor: Actor, id: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new LedgerError("a void needs a reason");
  const { rows } = await pool.query(
    `SELECT m.account_id FROM cash_movements m JOIN accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id = $2`,
    [id, actor.userId]
  );
  if (!rows[0]) throw new NotFoundError("no such cash movement");
  await withLock(LOCKS.ledger(rows[0].account_id), async (client) => {
    const { rowCount } = await client.query(
      `UPDATE cash_movements SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`,
      [id, actor.userId, trimmed.slice(0, 500)]
    );
    if (!rowCount) throw new LedgerError("this movement is already voided");
    await audit(client, actor, { action: "cash.void", entity: "cash_movement", entityId: id, detail: { reason: trimmed.slice(0, 500) } });
  });
}

export async function listCashMovements(actor: Pick<Actor, "userId" | "accountId">, includeVoided = false) {
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, m.amount, m.currency, m.occurred_at, m.note, m.voided_at, m.void_reason, c.ticker
     FROM cash_movements m
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN companies c ON c.id = m.company_id
     WHERE m.account_id = $1 AND a.user_id = $2 AND ($3::boolean OR m.voided_at IS NULL)
     ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT 200`,
    [actor.accountId, actor.userId, includeVoided]
  );
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as CashKind,
    amount: String(r.amount),
    currency: r.currency as string,
    occurredAt: (r.occurred_at as Date).toISOString(),
    ticker: (r.ticker as string | null) ?? null,
    note: r.note as string | null,
    voidedAt: r.voided_at ? (r.voided_at as Date).toISOString() : null,
    voidReason: r.void_reason as string | null,
  }));
}

export async function getAccount(actor: Pick<Actor, "userId" | "accountId">) {
  const { rows } = await pool.query(
    `SELECT id, name, base_currency, tracks_cash FROM accounts WHERE id = $1 AND user_id = $2`,
    [actor.accountId, actor.userId]
  );
  if (!rows[0]) throw new NotFoundError("no such account");
  return { id: rows[0].id, name: rows[0].name, baseCurrency: rows[0].base_currency, tracksCash: rows[0].tracks_cash };
}

export async function updateAccount(
  actor: Actor,
  patch: { baseCurrency?: string; tracksCash?: boolean; name?: string }
): Promise<void> {
  await withLock(LOCKS.ledger(actor.accountId), async (client) => {
    await assertAccountOwned(client, actor.userId, actor.accountId);
    await client.query(
      `UPDATE accounts SET base_currency = COALESCE($2, base_currency), tracks_cash = COALESCE($3, tracks_cash), name = COALESCE($4, name)
       WHERE id = $1`,
      [actor.accountId, patch.baseCurrency ?? null, patch.tracksCash ?? null, patch.name ?? null]
    );
    await audit(client, actor, { action: "account.update", entity: "account", entityId: actor.accountId, detail: patch });
  });
}
