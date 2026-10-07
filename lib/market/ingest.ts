import { pool } from "../db";
import { BENCHMARK_TICKER } from "../constants";
import { getSplits, storeSplits } from "../splits";
import { chart, dividends, marketData, splits as providerSplits, type Range } from "./data";

/* ---------------------------------------------------------------------------
   Price ingestion, from the configured provider into prices_daily.

   Stored closes are split-adjusted as of the day they were fetched. When a
   new split appears, every earlier stored close is on the old basis, so the
   whole history is fetched again — otherwise prices before and after the
   split would disagree by the split ratio.
--------------------------------------------------------------------------- */

export async function ensureBenchmark(): Promise<void> {
  await pool.query(
    `INSERT INTO companies (ticker, name) VALUES ($1, $2) ON CONFLICT (ticker) DO NOTHING`,
    [BENCHMARK_TICKER, `${BENCHMARK_TICKER} (benchmark)`]
  );
}

// Everything anyone holds or watches, and the benchmark.
export async function trackedForPrices(): Promise<Array<{ id: string; ticker: string }>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id, c.ticker
     FROM companies c
     WHERE c.ticker = $1
        OR EXISTS (SELECT 1 FROM transactions t WHERE t.company_id = c.id AND t.voided_at IS NULL)
        OR EXISTS (SELECT 1 FROM watchlist w WHERE w.company_id = c.id)
     ORDER BY c.ticker`,
    [BENCHMARK_TICKER]
  );
  return rows;
}

export interface RefreshResult {
  ticker: string;
  bars: number;
  newSplits: number;
  dividends: number;
  refetchedHistory: boolean;
  source: string;
}

export async function refreshPrices(companyId: string, ticker: string, range: Range = "1mo"): Promise<RefreshResult> {
  const source = marketData().name;

  // Splits first: a new one means the stored history is on an old basis.
  const before = new Set(((await getSplits([companyId])).get(companyId) ?? []).map((s) => s.date));
  const fetched = await providerSplits(ticker).catch(() => []);
  await storeSplits(companyId, fetched);
  const newSplits = fetched.filter((s) => !before.has(s.date)).length;
  const { rows: stored } = await pool.query(`SELECT count(*)::int AS n FROM prices_daily WHERE company_id = $1`, [companyId]);
  const refetchedHistory = newSplits > 0 && stored[0].n > 0;

  const c = await chart(ticker, refetchedHistory ? "max" : range);
  // A session still trading has a price, not a close; it is stored on the
  // next run once the session has ended.
  const bars = (c.lastBarComplete ? c.bars : c.bars.slice(0, -1)).filter((b) => b.close !== null);

  let written = 0;
  if (bars.length > 0) {
    const { rowCount } = await pool.query(
      `INSERT INTO prices_daily (company_id, date, open, high, low, close, volume, source)
       SELECT $1, d::date, o, h, l, cl, v::bigint, $8
       FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
         AS t(d, o, h, l, cl, v)
       ON CONFLICT (company_id, date) DO UPDATE
         SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
             close = EXCLUDED.close, volume = EXCLUDED.volume, source = EXCLUDED.source`,
      [
        companyId,
        bars.map((b) => b.date),
        bars.map((b) => b.open),
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        bars.map((b) => (b.volume === null ? null : Math.round(b.volume))),
        c.source,
      ]
    );
    written = rowCount ?? 0;
  }

  const divs = await dividends(ticker).catch(() => []);
  if (divs.length > 0) {
    await pool.query(
      `INSERT INTO dividends (company_id, ex_date, pay_date, amount, currency, source)
       SELECT $1, ex::date, pay::date, amt, $5, $6
       FROM unnest($2::text[], $3::text[], $4::numeric[]) AS t(ex, pay, amt)
       ON CONFLICT (company_id, ex_date) DO UPDATE SET amount = EXCLUDED.amount, pay_date = EXCLUDED.pay_date, source = EXCLUDED.source`,
      [
        companyId,
        divs.map((d) => d.exDate),
        divs.map((d) => d.payDate),
        divs.map((d) => d.amount.toString()),
        c.currency ?? "USD",
        source,
      ]
    );
  }

  return { ticker, bars: written, newSplits, dividends: divs.length, refetchedHistory, source };
}
