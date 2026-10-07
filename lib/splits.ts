import Decimal from "decimal.js";
import { pool, type Db } from "./db";
import { splits as providerSplits } from "./market/data";
import type { Split } from "./market/types";

/* ---------------------------------------------------------------------------
   Stock splits.

   Every price the desk stores or fetches is split-adjusted, but a transaction
   is recorded in the shares and price of its own day. A 4-for-1 split after a
   buy of 10 shares at $800 means the position is now 40 shares at $200; without
   that adjustment the ledger values it at 10 × today's $200. The splits table
   is what lets quantities and prices be put on the same basis.
--------------------------------------------------------------------------- */

export type { Split } from "./market/types";

// From the configured market-data provider.
export async function fetchSplits(ticker: string): Promise<Split[]> {
  return providerSplits(ticker);
}

export async function storeSplits(companyId: string, splits: Split[]): Promise<void> {
  for (const s of splits) {
    await pool.query(
      `INSERT INTO splits (company_id, date, ratio) VALUES ($1, $2, $3)
       ON CONFLICT (company_id, date) DO UPDATE SET ratio = EXCLUDED.ratio`,
      [companyId, s.date, s.ratio.toString()]
    );
  }
}

export async function getSplits(companyIds: string[], db: Db = pool): Promise<Map<string, Split[]>> {
  const out = new Map<string, Split[]>();
  if (companyIds.length === 0) return out;
  // No catch here: a failed read must not be mistaken for "no splits", which
  // would silently mis-state every quantity across a split.
  const { rows } = await db.query(
    `SELECT company_id, date, ratio FROM splits WHERE company_id = ANY($1) ORDER BY date`,
    [companyIds]
  );
  for (const r of rows) {
    const list = out.get(r.company_id) ?? [];
    list.push({ date: (r.date as Date).toISOString().slice(0, 10), ratio: new Decimal(r.ratio) });
    out.set(r.company_id, list);
  }
  return out;
}

// The factor that turns shares held on `from` into shares held on `to`: the
// product of every split whose ex-date falls after `from` and on or before `to`.
// A trade on the ex-date itself is already in post-split shares.
export function splitFactor(splits: Split[] | undefined, from: string, to: string = "9999-12-31"): Decimal {
  let factor = new Decimal(1);
  for (const s of splits ?? []) {
    if (s.date > from && s.date <= to) factor = factor.mul(s.ratio);
  }
  return factor;
}

// A share count reported for a period, restated in today's shares. Every price
// the desk uses is back-adjusted for every split up to today, so a market cap
// is shares-as-filed × the splits since the period ended × that price. Without
// this, a 10-for-1 split makes every earlier period's market cap ten times too
// small (and every P/E ten times too cheap).
export function sharesOnPriceBasis(shares: Decimal, periodEnd: string, splits: Split[] | undefined): Decimal {
  return shares.mul(splitFactor(splits, periodEnd));
}
