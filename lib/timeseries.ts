import Decimal from "decimal.js";
import { pool } from "./db";
import { BENCHMARK_TICKER } from "./constants";

export interface SeriesPoint {
  date: string;
  portfolioIndex: number;
  benchmarkIndex: number;
}

interface PriceBar {
  date: Date;
  close: Decimal;
}

// portfolio value and the benchmark, both indexed to 100 at the first date they can be compared
export async function getPortfolioSeries(accountId: string): Promise<SeriesPoint[]> {
  const { rows: txnRows } = await pool.query(
    `SELECT company_id, side, qty, executed_at
     FROM transactions
     WHERE account_id = $1
     ORDER BY executed_at`,
    [accountId]
  );
  if (txnRows.length === 0) return [];

  const firstDate: Date = txnRows[0].executed_at;

  const { rows: benchRows } = await pool.query(
    `SELECT pd.date, pd.close
     FROM prices_daily pd
     JOIN companies c ON c.id = pd.company_id
     WHERE c.ticker = $1 AND pd.date >= $2
     ORDER BY pd.date`,
    [BENCHMARK_TICKER, firstDate]
  );
  if (benchRows.length === 0) return [];

  const companyIds = [...new Set(txnRows.map((r) => r.company_id as string))];
  const { rows: priceRows } = await pool.query(
    `SELECT company_id, date, close
     FROM prices_daily
     WHERE company_id = ANY($1) AND date >= $2
     ORDER BY company_id, date`,
    [companyIds, firstDate]
  );

  const pricesByCompany = new Map<string, PriceBar[]>();
  for (const row of priceRows) {
    const list = pricesByCompany.get(row.company_id) ?? [];
    list.push({ date: row.date, close: new Decimal(row.close) });
    pricesByCompany.set(row.company_id, list);
  }

  // walks forward monotonically as we scan dates, so this stays O(n)
  const pointer = new Map<string, number>();
  function priceAsOf(companyId: string, date: Date): Decimal | null {
    const series = pricesByCompany.get(companyId);
    if (!series) return null;
    let idx = pointer.get(companyId) ?? -1;
    while (idx + 1 < series.length && series[idx + 1].date <= date) idx++;
    pointer.set(companyId, idx);
    return idx >= 0 ? series[idx].close : null;
  }

  let txnIdx = 0;
  const qtyByCompany = new Map<string, Decimal>();
  const baseBenchmark = new Decimal(benchRows[0].close);
  let basePortfolioValue: Decimal | null = null;

  const points: SeriesPoint[] = [];

  for (const b of benchRows) {
    const date: Date = b.date;

    while (txnIdx < txnRows.length && (txnRows[txnIdx].executed_at as Date) <= date) {
      const t = txnRows[txnIdx];
      const current = qtyByCompany.get(t.company_id) ?? new Decimal(0);
      const delta = new Decimal(t.qty).mul(t.side === "buy" ? 1 : -1);
      qtyByCompany.set(t.company_id, current.add(delta));
      txnIdx++;
    }

    let value = new Decimal(0);
    for (const [companyId, qty] of qtyByCompany) {
      if (qty.isZero()) continue;
      const price = priceAsOf(companyId, date);
      if (price) value = value.add(qty.mul(price));
    }

    if (basePortfolioValue === null) {
      if (value.isZero()) continue;
      basePortfolioValue = value;
    }

    points.push({
      date: date.toISOString().slice(0, 10),
      portfolioIndex: value.div(basePortfolioValue).mul(100).toNumber(),
      benchmarkIndex: new Decimal(b.close).div(baseBenchmark).mul(100).toNumber(),
    });
  }

  return points;
}
