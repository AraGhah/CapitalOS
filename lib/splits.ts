import Decimal from "decimal.js";
import { pool } from "./db";

/* ---------------------------------------------------------------------------
   Stock splits.

   Every price the desk stores or fetches is split-adjusted, but a transaction
   is recorded in the shares and price of its own day. A 4-for-1 split after a
   buy of 10 shares at $800 means the position is now 40 shares at $200; without
   that adjustment the ledger values it at 10 × today's $200. The splits table
   is what lets quantities and prices be put on the same basis.
--------------------------------------------------------------------------- */

export interface Split {
  date: string;
  // new shares per old share: 4 for a 4-for-1 split, 0.1 for a 1-for-10 reverse
  ratio: Decimal;
}

interface YahooSplits {
  chart: {
    result?: Array<{
      events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }> };
    }>;
  };
}

export async function fetchSplits(ticker: string): Promise<Split[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=max&interval=1mo&events=split`;
  const res = await fetch(url, {
    headers: { "User-Agent": "CapitalOS/1.0 (personal research desk)", Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Yahoo splits ${res.status} ${res.statusText}`);
  const body = (await res.json()) as YahooSplits;
  const raw = body.chart.result?.[0]?.events?.splits ?? {};

  return Object.values(raw)
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({
      date: new Date(s.date * 1000).toISOString().slice(0, 10),
      ratio: new Decimal(s.numerator).div(s.denominator),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
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

// Missing table (migration not run yet) reads as "no splits", which is what the
// desk assumed before the table existed.
export async function getSplits(companyIds: string[]): Promise<Map<string, Split[]>> {
  const out = new Map<string, Split[]>();
  if (companyIds.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `SELECT company_id, date, ratio FROM splits WHERE company_id = ANY($1) ORDER BY date`,
      [companyIds]
    );
    for (const r of rows) {
      const list = out.get(r.company_id) ?? [];
      list.push({ date: (r.date as Date).toISOString().slice(0, 10), ratio: new Decimal(r.ratio) });
      out.set(r.company_id, list);
    }
  } catch {
    // no splits table
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
