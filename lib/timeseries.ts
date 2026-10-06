import Decimal from "decimal.js";
import { pool } from "./db";
import { BENCHMARK_TICKER } from "./constants";
import { getSplits, splitFactor } from "./splits";

export interface SeriesPoint {
  date: string;
  portfolioIndex: number;
  benchmarkIndex: number;
}

interface PriceBar {
  date: string;
  close: Decimal;
}

// The portfolio and the benchmark, both indexed to 100 on the first day the
// portfolio held anything.
//
// The portfolio line is a time-weighted return: each day it moves by what the
// positions held overnight did, and money added or taken out by a trade moves
// the value but not the index. Indexing raw market value instead would read a
// new purchase as a gain and a sale as a loss.
export async function getPortfolioSeries(accountId: string): Promise<SeriesPoint[]> {
  const { rows: txnRows } = await pool.query(
    `SELECT company_id, side, qty, executed_at
     FROM transactions
     WHERE account_id = $1
     ORDER BY executed_at`,
    [accountId]
  );
  if (txnRows.length === 0) return [];

  const firstDate = (txnRows[0].executed_at as Date).toISOString().slice(0, 10);

  const { rows: benchRows } = await pool.query(
    `SELECT pd.date, pd.close
     FROM prices_daily pd
     JOIN companies c ON c.id = pd.company_id
     WHERE c.ticker = $1 AND pd.date >= $2 AND pd.close IS NOT NULL
     ORDER BY pd.date`,
    [BENCHMARK_TICKER, firstDate]
  );
  if (benchRows.length === 0) return [];

  const companyIds = [...new Set(txnRows.map((r) => r.company_id as string))];
  const [{ rows: priceRows }, splits] = await Promise.all([
    pool.query(
      `SELECT company_id, date, close
       FROM prices_daily
       WHERE company_id = ANY($1) AND date >= ($2::date - 14) AND close IS NOT NULL
       ORDER BY company_id, date`,
      [companyIds, firstDate]
    ),
    getSplits(companyIds),
  ]);

  const pricesByCompany = new Map<string, PriceBar[]>();
  for (const row of priceRows) {
    const list = pricesByCompany.get(row.company_id) ?? [];
    list.push({ date: (row.date as Date).toISOString().slice(0, 10), close: new Decimal(row.close) });
    pricesByCompany.set(row.company_id, list);
  }

  // Walks forward monotonically as the dates are scanned, so this stays O(n).
  // The last close on or before a date stands in for a day with no bar.
  const pointer = new Map<string, number>();
  function priceAsOf(companyId: string, date: string): Decimal | null {
    const series = pricesByCompany.get(companyId);
    if (!series) return null;
    let idx = pointer.get(companyId) ?? -1;
    while (idx + 1 < series.length && series[idx + 1].date <= date) idx++;
    pointer.set(companyId, idx);
    return idx >= 0 ? series[idx].close : null;
  }

  // Quantities in today's shares, to match split-adjusted prices.
  const txns = txnRows.map((t) => {
    const date = (t.executed_at as Date).toISOString().slice(0, 10);
    const qty = new Decimal(t.qty).mul(splitFactor(splits.get(t.company_id), date));
    return { companyId: t.company_id as string, date, delta: t.side === "buy" ? qty : qty.neg() };
  });

  const qtyByCompany = new Map<string, Decimal>();
  const valueAt = (date: string): Decimal => {
    let value = new Decimal(0);
    for (const [companyId, qty] of qtyByCompany) {
      if (qty.lte(0)) continue;
      const price = priceAsOf(companyId, date);
      if (price) value = value.add(qty.mul(price));
    }
    return value;
  };

  let txnIdx = 0;
  let index: Decimal | null = null;
  let previousEnd = new Decimal(0);
  let baseBenchmark: Decimal | null = null;
  const points: SeriesPoint[] = [];

  for (const b of benchRows) {
    const date = (b.date as Date).toISOString().slice(0, 10);

    // What yesterday's positions are worth at today's prices: the day's return,
    // before any of today's trades.
    const beforeTrades = valueAt(date);
    if (index !== null && previousEnd.gt(0)) {
      index = index.mul(beforeTrades.div(previousEnd));
    }

    // Trades are taken as filled at the day's close, after the day's move.
    while (txnIdx < txns.length && txns[txnIdx].date <= date) {
      const t = txns[txnIdx];
      const current = qtyByCompany.get(t.companyId) ?? new Decimal(0);
      qtyByCompany.set(t.companyId, Decimal.max(0, current.add(t.delta)));
      txnIdx++;
    }
    const afterTrades = valueAt(date);

    if (index === null) {
      if (afterTrades.isZero()) continue;
      index = new Decimal(100);
      baseBenchmark = new Decimal(b.close);
    }

    points.push({
      date,
      portfolioIndex: index.toNumber(),
      benchmarkIndex: new Decimal(b.close).div(baseBenchmark as Decimal).mul(100).toNumber(),
    });
    previousEnd = afterTrades;
  }

  return points;
}
