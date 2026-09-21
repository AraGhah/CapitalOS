import Decimal from "decimal.js";
import { pool } from "./db";
import { buildPosition, summarizeHoldings, totalReturn, type Position, type Txn } from "./portfolio";

export interface HoldingRow {
  companyId: string;
  ticker: string;
  name: string;
  qty: Decimal;
  avgCost: Decimal;
  price: Decimal;
  costBasis: Decimal;
  marketValue: Decimal;
  unrealizedPL: Decimal;
  realizedPL: Decimal;
  weight: Decimal;
}

async function getPositionsByCompany(accountId: string): Promise<Map<string, Position>> {
  const { rows } = await pool.query(
    `SELECT company_id, side, qty, price, fees, executed_at
     FROM transactions
     WHERE account_id = $1
     ORDER BY executed_at`,
    [accountId]
  );

  const txnsByCompany = new Map<string, Txn[]>();
  for (const row of rows) {
    const list = txnsByCompany.get(row.company_id) ?? [];
    list.push({
      side: row.side,
      qty: row.qty,
      price: row.price,
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
