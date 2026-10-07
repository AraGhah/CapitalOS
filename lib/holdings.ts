import Decimal from "decimal.js";
import { pool } from "./db";
import { BENCHMARK_TICKER } from "./constants";
import { getSplits } from "./splits";
import { FxTable } from "./fx";
import { valueAccount, type HoldingView, type Valuation } from "./valuation";

/* ---------------------------------------------------------------------------
   Loads an account's ledger, prices, splits, dividends and FX from the
   database and hands them to the valuation engine (lib/valuation.ts).
--------------------------------------------------------------------------- */

export type HoldingRow = HoldingView;

export async function valuationFor(accountId: string): Promise<Valuation> {
  const { rows: acct } = await pool.query(`SELECT base_currency, tracks_cash FROM accounts WHERE id = $1`, [accountId]);
  const baseCurrency = (acct[0]?.base_currency as string) ?? "USD";
  const tracksCash = acct[0]?.tracks_cash === true;

  const [{ rows: trades }, { rows: cash }] = await Promise.all([
    pool.query(
      `SELECT t.company_id, t.side, t.qty, t.price, t.fees, t.currency, t.executed_at, c.ticker, c.name, c.currency AS listing
       FROM transactions t JOIN companies c ON c.id = t.company_id
       WHERE t.account_id = $1 AND t.voided_at IS NULL
       ORDER BY t.executed_at, t.created_at, t.id`,
      [accountId]
    ),
    pool.query(
      `SELECT kind, amount, currency, occurred_at FROM cash_movements
       WHERE account_id = $1 AND voided_at IS NULL ORDER BY occurred_at, created_at`,
      [accountId]
    ),
  ]);

  const companies = new Map<string, { ticker: string; name: string; currency: string }>();
  for (const t of trades) companies.set(t.company_id, { ticker: t.ticker, name: t.name, currency: t.listing });
  const ids = [...companies.keys()];
  const firstDate = [
    ...trades.map((t) => (t.executed_at as Date).toISOString().slice(0, 10)),
    ...cash.map((c) => (c.occurred_at as Date).toISOString().slice(0, 10)),
  ].sort()[0];

  const [splits, priceRows, divRows, bench] = await Promise.all([
    getSplits(ids),
    ids.length
      ? pool.query(
          `SELECT company_id, date, close FROM prices_daily
           WHERE company_id = ANY($1) AND close IS NOT NULL AND ($2::date IS NULL OR date >= $2::date - 14)
           ORDER BY company_id, date`,
          [ids, firstDate ?? null]
        )
      : Promise.resolve({ rows: [] as Array<{ company_id: string; date: Date; close: string }> }),
    ids.length
      ? pool.query(`SELECT company_id, ex_date, amount, basis FROM dividends WHERE company_id = ANY($1) ORDER BY ex_date`, [ids])
      : Promise.resolve({ rows: [] as Array<{ company_id: string; ex_date: Date; amount: string; basis: string }> }),
    pool.query(
      `SELECT pd.date, pd.close, c.currency FROM prices_daily pd JOIN companies c ON c.id = pd.company_id
       WHERE c.ticker = $1 AND pd.close IS NOT NULL AND ($2::date IS NULL OR pd.date >= $2::date - 14)
       ORDER BY pd.date`,
      [BENCHMARK_TICKER, firstDate ?? null]
    ),
  ]);

  const prices = new Map<string, Array<{ date: string; close: Decimal }>>();
  for (const r of priceRows.rows) {
    const list = prices.get(r.company_id) ?? [];
    list.push({ date: (r.date as Date).toISOString().slice(0, 10), close: new Decimal(r.close) });
    prices.set(r.company_id, list);
  }
  const dividends = new Map<string, Array<{ exDate: string; amount: Decimal; basis: "as_paid" | "split_adjusted" }>>();
  for (const r of divRows.rows) {
    const list = dividends.get(r.company_id) ?? [];
    list.push({
      exDate: (r.ex_date as Date).toISOString().slice(0, 10),
      amount: new Decimal(r.amount),
      basis: r.basis as "as_paid" | "split_adjusted",
    });
    dividends.set(r.company_id, list);
  }

  const currencies = [
    baseCurrency,
    ...[...companies.values()].map((c) => c.currency),
    ...trades.map((t) => t.currency as string),
    ...cash.map((c) => c.currency as string),
    (bench.rows[0]?.currency as string) ?? "USD",
  ];
  const fx = await FxTable.load(currencies, firstDate ?? new Date().toISOString().slice(0, 10));

  return valueAccount({
    baseCurrency,
    tracksCash,
    today: new Date().toISOString().slice(0, 10),
    companies,
    trades: trades.map((t) => ({
      companyId: t.company_id,
      side: t.side,
      qty: new Decimal(t.qty),
      price: new Decimal(t.price),
      fees: new Decimal(t.fees),
      currency: t.currency,
      executedAt: t.executed_at,
    })),
    cash: cash.map((c) => ({
      kind: c.kind,
      amount: new Decimal(c.amount),
      currency: c.currency,
      occurredAt: c.occurred_at,
    })),
    splits,
    prices,
    dividends,
    benchmark: bench.rows.length
      ? {
          currency: bench.rows[0].currency,
          closes: bench.rows.map((r) => ({ date: (r.date as Date).toISOString().slice(0, 10), close: new Decimal(r.close) })),
        }
      : null,
    fx,
  });
}

// The shape the pages, the risk engine and the MCP server read. totalReturn
// is the time-weighted return: money moving in and out does not move it.
export async function getPortfolio(accountId: string) {
  const v = await valuationFor(accountId);
  return {
    holdings: v.holdings.filter((h) => h.qty.gt(0)),
    totalReturn: new Decimal(v.twr.cumulative),
    integrity: v.integrity,
    valuation: v,
  };
}
