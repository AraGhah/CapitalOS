import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { recordTransaction } from "../../lib/ledger";
import { recordCashMovement } from "../../lib/cash";
import { valuationFor } from "../../lib/holdings";
import { GET as accountRoute, PATCH as patchAccount } from "../../app/api/account/route";
import { POST as postCash } from "../../app/api/cash/route";
import { call, signedInUser } from "./helpers";
import { company } from "./db";

const day = (d: string) => new Date(`${d}T12:00:00Z`);

async function prices(companyId: string, rows: Array<[string, number]>) {
  for (const [d, c] of rows) {
    await pool.query(`INSERT INTO prices_daily (company_id, date, close, source) VALUES ($1, $2, $3, 'test')`, [companyId, d, c]);
  }
}

describe("valuation from the database (FIN-01)", () => {
  it("values a cash-tracking account, and switches to tracking cash on the first movement", async () => {
    const u = await signedInUser();
    const acme = await company("ACME");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await prices(acme, [
      [twoDaysAgo, 100],
      [yesterday, 120],
    ]);

    const deposit = await call(postCash, {
      cookie: u.cookie,
      body: { kind: "deposit", amount: "2000", currency: "USD", occurredAt: twoDaysAgo },
    });
    expect(deposit.status).toBe(201);
    await recordTransaction(u, {
      companyId: acme,
      ticker: "ACME",
      side: "buy",
      qty: new Decimal(10),
      price: new Decimal(100),
      fees: new Decimal(0),
      executedAt: day(twoDaysAgo),
    });

    const v = await valuationFor(u.accountId);
    expect(v.tracksCash).toBe(true);
    expect(v.totalValue.toNumber()).toBe(1200 + 1000);
    expect(v.twr.cumulative).toBeCloseTo(0.1, 6);

    const res = await call(accountRoute, { cookie: u.cookie });
    const body = res.body as { valuation: { totalValue: string; cash: Array<{ amount: string }> } };
    expect(Number(body.valuation.totalValue)).toBe(2200);
    expect(Number(body.valuation.cash[0].amount)).toBe(1000);
  });

  it("is idempotent on a repeated cash submission", async () => {
    const u = await signedInUser();
    const one = await recordCashMovement(u, { kind: "deposit", amount: new Decimal(5), currency: "USD", occurredAt: day("2026-01-01"), idempotencyKey: "same-key-1" });
    const two = await recordCashMovement(u, { kind: "deposit", amount: new Decimal(5), currency: "USD", occurredAt: day("2026-01-01"), idempotencyKey: "same-key-1" });
    expect(two).toEqual({ id: one.id, duplicate: true });
  });

  it("changes the base currency and queues the FX refresh it needs", async () => {
    const u = await signedInUser();
    const res = await call(patchAccount, { method: "PATCH", cookie: u.cookie, body: { baseCurrency: "cad" } });
    expect(res.status).toBe(200);
    expect((res.body as { baseCurrency: string }).baseCurrency).toBe("CAD");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'ingest.fx'`);
    expect(rows[0].n).toBe(1);
  });

  it("records a trade in its listing's currency", async () => {
    const u = await signedInUser();
    const { rows } = await pool.query(
      `INSERT INTO companies (ticker, name, currency) VALUES ('SHOP.TO', 'Shopify (TSX)', 'CAD') RETURNING id`
    );
    const { id } = await recordTransaction(u, {
      companyId: rows[0].id,
      ticker: "SHOP.TO",
      side: "buy",
      qty: new Decimal(1),
      price: new Decimal(150),
      fees: new Decimal(0),
      executedAt: day("2026-01-02"),
    });
    const { rows: t } = await pool.query(`SELECT currency FROM transactions WHERE id = $1`, [id]);
    expect(t[0].currency).toBe("CAD");
  });
});
