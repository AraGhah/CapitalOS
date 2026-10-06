import Decimal from "decimal.js";
import { pool } from "./db";
import { buildPosition, summarizeHoldings, totalReturn, type Position, type Txn } from "./portfolio";
import { getSplits, splitFactor } from "./splits";

export interface HoldingRow {
  companyId: string;
  ticker: string;
  name: string;
  qty: Decimal;
  avgCost: Decimal;
  price: Decimal;
  priced: boolean;
  costBasis: Decimal;
  marketValue: Decimal;
  unrealizedPL: Decimal;
  realizedPL: Decimal;
  weight: Decimal;
}

async function transactionRows(accountId: string, companyId?: string) {
  const { rows } = await pool.query(
    `SELECT company_id, side, qty, price, fees, executed_at
     FROM transactions
     WHERE account_id = $1 AND ($2::uuid IS NULL OR company_id = $2)
     ORDER BY executed_at`,
    [accountId, companyId ?? null]
  );
  return rows;
}

// Every transaction is restated in today's shares, because every price it will
// be compared with is split-adjusted: 10 shares at $800 before a 4-for-1 split
// become 40 shares at $200. Cost and proceeds are unchanged by the restatement.
async function getPositionsByCompany(accountId: string): Promise<Map<string, Position>> {
  const rows = await transactionRows(accountId);
  const splits = await getSplits([...new Set(rows.map((r) => r.company_id as string))]);

  const txnsByCompany = new Map<string, Txn[]>();
  for (const row of rows) {
    const factor = splitFactor(splits.get(row.company_id), (row.executed_at as Date).toISOString().slice(0, 10));
    const list = txnsByCompany.get(row.company_id) ?? [];
    list.push({
      side: row.side,
      qty: new Decimal(row.qty).mul(factor),
      price: new Decimal(row.price).div(factor),
      fees: row.fees,
      executedAt: row.executed_at,
    });
    txnsByCompany.set(row.company_id, list);
  }

  const positions = new Map<string, Position>();
  for (const [companyId, txns] of txnsByCompany) {
    positions.set(companyId, buildPosition(txns));
  }
  return positions;
}

// Shares of one company held at a moment, in the shares of that moment, so a
// sell entered for a past date is checked against what was held then.
export async function heldQuantity(accountId: string, companyId: string, at: Date): Promise<Decimal> {
  const rows = await transactionRows(accountId, companyId);
  const splits = (await getSplits([companyId])).get(companyId);
  const atDate = at.toISOString().slice(0, 10);

  let held = new Decimal(0);
  for (const row of rows) {
    const when = row.executed_at as Date;
    if (when.getTime() > at.getTime()) break;
    const qty = new Decimal(row.qty).mul(splitFactor(splits, when.toISOString().slice(0, 10), atDate));
    held = row.side === "buy" ? held.add(qty) : held.sub(qty);
  }
  return Decimal.max(held, 0);
}

async function getLatestPrices(companyIds: string[]): Promise<Map<string, Decimal>> {
  if (companyIds.length === 0) return new Map();

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (company_id) company_id, close
     FROM prices_daily
     WHERE company_id = ANY($1)
     ORDER BY company_id, date DESC`,
    [companyIds]
  );

  const prices = new Map<string, Decimal>();
  for (const row of rows) {
    if (row.close != null) prices.set(row.company_id, new Decimal(row.close));
  }
  return prices;
}

export async function getPortfolio(accountId: string) {
  const positions = await getPositionsByCompany(accountId);
  const companyIds = [...positions.keys()];
  const prices = await getLatestPrices(companyIds);

  const { rows: companyRows } = companyIds.length
    ? await pool.query(`SELECT id, ticker, name FROM companies WHERE id = ANY($1)`, [companyIds])
    : { rows: [] };
  const companyInfo = new Map(companyRows.map((c) => [c.id, c]));

  const holdings: HoldingRow[] = summarizeHoldings(positions, prices).map((h) => ({
    ...h,
    ticker: companyInfo.get(h.companyId)?.ticker ?? "?",
    name: companyInfo.get(h.companyId)?.name ?? "",
  }));

  holdings.sort((a, b) => b.marketValue.comparedTo(a.marketValue));

  return {
    holdings,
    totalReturn: totalReturn(positions, prices),
  };
}
