import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { LEGACY_ACCOUNT_ID, LEGACY_OWNER_ID, type Actor } from "../../lib/actor";
import { LedgerError, listTransactions, recordTransaction, voidTransaction } from "../../lib/ledger";
import { company } from "./db";

const actor: Actor = { userId: LEGACY_OWNER_ID, accountId: LEGACY_ACCOUNT_ID, requestId: "test" };
const day = (d: string) => new Date(`${d}T12:00:00Z`);

async function trade(companyId: string, side: "buy" | "sell", qty: number, date: string, key?: string) {
  return recordTransaction(actor, {
    companyId,
    ticker: "ACME",
    side,
    qty: new Decimal(qty),
    price: new Decimal(100),
    fees: new Decimal(0),
    executedAt: day(date),
    idempotencyKey: key,
  });
}

describe("ledger write path", () => {
  it("refuses a backdated sell that a later sell already covered (LED-01)", async () => {
    const id = await company("ACME");
    await trade(id, "buy", 10, "2026-10-01");
    await trade(id, "sell", 10, "2026-10-05");
    await expect(trade(id, "sell", 10, "2026-10-03")).rejects.toBeInstanceOf(LedgerError);
    expect(await listTransactions(actor)).toHaveLength(2);
  });

  it("serialises concurrent sells so only one of two can spend the same shares", async () => {
    const id = await company("ACME");
    await trade(id, "buy", 10, "2026-10-01");
    const results = await Promise.allSettled([
      trade(id, "sell", 10, "2026-10-02"),
      trade(id, "sell", 10, "2026-10-02"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("treats a repeated idempotency key as the same transaction", async () => {
    const id = await company("ACME");
    const first = await trade(id, "buy", 5, "2026-10-01", "key-123456");
    const again = await trade(id, "buy", 5, "2026-10-01", "key-123456");
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(await listTransactions(actor)).toHaveLength(1);
  });

  it("writes an audit row in the same transaction as the trade", async () => {
    const id = await company("ACME");
    const { id: txnId } = await trade(id, "buy", 5, "2026-10-01");
    const { rows } = await pool.query(`SELECT action, entity_id, request_id FROM audit_log`);
    expect(rows).toEqual([{ action: "transaction.create", entity_id: txnId, request_id: "test" }]);
  });

  it("refuses to void a buy that a later sell depends on, and voids otherwise", async () => {
    const id = await company("ACME");
    const buy = await trade(id, "buy", 10, "2026-10-01");
    const sell = await trade(id, "sell", 10, "2026-10-02");
    await expect(voidTransaction(actor, buy.id, "typo")).rejects.toThrow(/strand a later sell/);
    await voidTransaction(actor, sell.id, "entered twice");
    await voidTransaction(actor, buy.id, "typo");
    expect(await listTransactions(actor)).toHaveLength(0);
    expect(await listTransactions(actor, { includeVoided: true })).toHaveLength(2);
  });

  it("will not write into an account the actor does not own", async () => {
    const id = await company("ACME");
    const { rows } = await pool.query(
      `INSERT INTO users (email) VALUES ('other@example.com') RETURNING id`
    );
    const intruder: Actor = { userId: rows[0].id, accountId: LEGACY_ACCOUNT_ID };
    await expect(
      recordTransaction(intruder, {
        companyId: id,
        ticker: "ACME",
        side: "buy",
        qty: new Decimal(1),
        price: new Decimal(1),
        fees: new Decimal(0),
        executedAt: day("2026-10-01"),
      })
    ).rejects.toThrow(/no such account/);
  });
});
