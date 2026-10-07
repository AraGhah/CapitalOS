import Decimal from "decimal.js";
import { pool } from "./db";
import { take } from "./ratelimit";

/* ---------------------------------------------------------------------------
   Foreign-exchange rates, from the Bank of Canada's Valet API — the central
   bank's published daily rates, free, documented and meant to be used:
   https://www.bankofcanada.ca/valet/docs

   Valet publishes every currency against the Canadian dollar (FXUSDCAD,
   FXEURCAD, …), so any pair is a cross through CAD. Rates are stored by date
   in fx_rates; a valuation for any past day uses the rate of that day (or the
   last published one before it — there are none on weekends and holidays).
--------------------------------------------------------------------------- */

const BOC = { key: "upstream:bankofcanada", capacity: 4, perSecond: 2 };
const STALE_DAYS = 10;

export class FxUnavailableError extends Error {
  readonly status = 503;
  constructor(from: string, to: string, date: string) {
    super(`no ${from}/${to} rate on or before ${date}`);
    this.name = "FxUnavailableError";
  }
}

// Units of CAD per one unit of `ccy`, by date, oldest first.
export type CadSeries = Array<{ date: string; rate: Decimal }>;

export async function fetchCadSeries(ccy: string, start: string): Promise<CadSeries> {
  if (ccy === "CAD") return [];
  await take(BOC);
  const url = `https://www.bankofcanada.ca/valet/observations/FX${ccy}CAD/json?start_date=${start}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new Error(`the Bank of Canada does not publish a ${ccy}/CAD rate`);
  if (!res.ok) throw new Error(`Bank of Canada Valet ${res.status}`);
  const body = (await res.json()) as { observations?: Array<Record<string, unknown> & { d: string }> };
  const key = `FX${ccy}CAD`;
  return (body.observations ?? [])
    .map((o) => ({ date: o.d, value: (o[key] as { v?: string } | undefined)?.v }))
    .filter((o): o is { date: string; value: string } => typeof o.value === "string" && Number(o.value) > 0)
    .map((o) => ({ date: o.date, rate: new Decimal(o.value) }));
}

export async function storeCadSeries(ccy: string, series: CadSeries): Promise<number> {
  if (series.length === 0) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO fx_rates (base, quote, date, rate, source)
     SELECT $1, 'CAD', d::date, r, 'bankofcanada'
     FROM unnest($2::text[], $3::numeric[]) AS t(d, r)
     ON CONFLICT (base, quote, date) DO UPDATE SET rate = EXCLUDED.rate`,
    [ccy, series.map((s) => s.date), series.map((s) => s.rate.toString())]
  );
  return rowCount ?? 0;
}

// Brings the stored series for each currency up to date: from its last stored
// date (or `since`) to today.
export async function refreshFx(currencies: string[], since: string): Promise<void> {
  for (const ccy of new Set(currencies)) {
    if (ccy === "CAD") continue;
    const { rows } = await pool.query(`SELECT max(date) AS last FROM fx_rates WHERE base = $1 AND quote = 'CAD'`, [ccy]);
    const last = rows[0].last as Date | null;
    const today = new Date().toISOString().slice(0, 10);
    if (last && today.localeCompare(last.toISOString().slice(0, 10)) <= 0) continue;
    const start = last && last.toISOString().slice(0, 10) > since ? last.toISOString().slice(0, 10) : since;
    await storeCadSeries(ccy, await fetchCadSeries(ccy, start));
  }
}

/* -------------------------------------------------------------- lookups */

// An in-memory view of stored rates for a set of currencies, for valuing a
// whole history without a query per day.
export class FxTable {
  private constructor(private readonly series: Map<string, CadSeries>) {}

  static async load(currencies: string[], since: string): Promise<FxTable> {
    const wanted = [...new Set(currencies)].filter((c) => c !== "CAD");
    const map = new Map<string, CadSeries>();
    if (wanted.length > 0) {
      const { rows } = await pool.query(
        `SELECT base, date, rate FROM fx_rates
         WHERE quote = 'CAD' AND base = ANY($1) AND date >= ($2::date - 14)
         ORDER BY base, date`,
        [wanted, since]
      );
      for (const r of rows) {
        const list = map.get(r.base) ?? [];
        list.push({ date: (r.date as Date).toISOString().slice(0, 10), rate: new Decimal(r.rate) });
        map.set(r.base, list);
      }
    }
    return new FxTable(map);
  }

  static fromSeries(series: Record<string, CadSeries>): FxTable {
    return new FxTable(new Map(Object.entries(series)));
  }

  // CAD per unit of ccy on date: the last rate on or before it, within STALE_DAYS.
  private cad(ccy: string, date: string): Decimal | null {
    if (ccy === "CAD") return new Decimal(1);
    const list = this.series.get(ccy);
    if (!list || list.length === 0) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const age = (Date.parse(date) - Date.parse(list[found].date)) / 86_400_000;
    return age <= STALE_DAYS ? list[found].rate : null;
  }

  // Units of `to` per one unit of `from` on `date`.
  rate(from: string, to: string, date: string): Decimal {
    if (from === to) return new Decimal(1);
    const a = this.cad(from, date);
    const b = this.cad(to, date);
    if (!a || !b) throw new FxUnavailableError(from, to, date);
    return a.div(b);
  }

  convert(amount: Decimal, from: string, to: string, date: string): Decimal {
    return amount.mul(this.rate(from, to, date));
  }
}
