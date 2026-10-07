import Decimal from "decimal.js";
import { buildPosition, compareTxns, type Txn } from "./portfolio";
import { splitFactor, type Split } from "./splits";
import { timeWeightedReturn, xirr, type DayPoint, type Flow } from "./returns";
import type { FxTable } from "./fx";

/* ---------------------------------------------------------------------------
   Account valuation: the whole history replayed one calendar day at a time.

   Each day, in order: dividends go ex on the shares held at the start of the
   day, the day's trades fill at its close, cash moves, and everything is
   valued at that day's prices and FX rates in the account's base currency.
   From that daily path come the time-weighted return, the money-weighted
   return, the benchmark comparison and today's holdings.

   Two kinds of account:
   - tracks_cash: deposits and withdrawals are the money moving in and out;
     the value is positions plus cash in every currency; dividends, interest
     and fees are recorded cash movements (from the broker's statements).
   - not tracking cash: each trade's cash is money moving in or out, the value
     is the positions alone, and dividends are computed from the dividends
     table on the shares held at each ex-date and counted as paid out.

   Pure: every input is passed in, so it is tested without a database.
--------------------------------------------------------------------------- */

const ZERO = new Decimal(0);

export interface Company {
  ticker: string;
  name: string;
  currency: string;
}

export interface TradeIn {
  companyId: string;
  side: "buy" | "sell";
  qty: Decimal; // as recorded, in the shares of its day
  price: Decimal; // per share, in the trade's currency
  fees: Decimal;
  currency: string;
  executedAt: Date;
}

export interface CashIn {
  kind: "deposit" | "withdrawal" | "dividend" | "interest" | "fee" | "tax";
  amount: Decimal;
  currency: string;
  occurredAt: Date;
}

export interface DividendIn {
  exDate: string;
  amount: Decimal;
  basis: "as_paid" | "split_adjusted";
}

export interface ValuationInput {
  baseCurrency: string;
  tracksCash: boolean;
  today: string;
  companies: Map<string, Company>;
  trades: TradeIn[];
  cash: CashIn[];
  splits: Map<string, Split[]>;
  // split-adjusted closes in the listing currency, oldest first
  prices: Map<string, Array<{ date: string; close: Decimal }>>;
  dividends: Map<string, DividendIn[]>;
  benchmark: { currency: string; closes: Array<{ date: string; close: Decimal }> } | null;
  fx: FxTable;
}

export interface HoldingView {
  companyId: string;
  ticker: string;
  name: string;
  currency: string;
  qty: Decimal; // today's shares
  avgCost: Decimal; // listing currency, per today's share
  price: Decimal; // listing currency
  priceDate: string | null;
  priced: boolean;
  stale: boolean;
  marketValue: Decimal; // base currency
  costBasis: Decimal; // base currency, at the FX of each purchase
  unrealizedPL: Decimal; // base
  realizedPL: Decimal; // base, at the FX of each trade
  weight: Decimal;
}

export interface Valuation {
  baseCurrency: string;
  tracksCash: boolean;
  asOf: string;
  holdings: HoldingView[];
  cash: Array<{ currency: string; amount: Decimal; amountBase: Decimal }>;
  positionsValue: Decimal;
  totalValue: Decimal;
  twr: { cumulative: number; annualized: number | null };
  mwr: number | null;
  dividendIncome: Decimal;
  netContributions: Decimal;
  integrity: Array<{ ticker: string; oversold: string }>;
  series: Array<{ date: string; value: number; portfolioIndex: number; benchmarkIndex: number | null }>;
  warnings: string[];
}

// A close older than this, in calendar days, is shown as stale.
const STALE_PRICE_DAYS = 6;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The last close on or before `date`, walking forward with a cursor.
class PriceCursor {
  private idx = -1;
  constructor(private readonly closes: Array<{ date: string; close: Decimal }>) {}
  at(date: string): { date: string; close: Decimal } | null {
    while (this.idx + 1 < this.closes.length && this.closes[this.idx + 1].date <= date) this.idx++;
    return this.idx >= 0 ? this.closes[this.idx] : null;
  }
}

export function valueAccount(input: ValuationInput): Valuation {
  const warnings: string[] = [];
  const base = input.baseCurrency;
  const day = (d: Date) => d.toISOString().slice(0, 10);

  // FX that never throws mid-history: the last rate that worked for a pair
  // stands in for a missing day, and the gap is reported once.
  const lastRate = new Map<string, Decimal>();
  const missingFx = new Set<string>();
  const rate = (from: string, to: string, date: string): Decimal => {
    if (from === to) return new Decimal(1);
    const key = `${from}/${to}`;
    try {
      const r = input.fx.rate(from, to, date);
      lastRate.set(key, r);
      return r;
    } catch {
      const fallback = lastRate.get(key);
      if (fallback) return fallback;
      missingFx.add(key);
      return new Decimal(1);
    }
  };

  // Trades restated in today's shares, to match split-adjusted prices.
  const trades = input.trades
    .map((t, seq) => {
      const f = splitFactor(input.splits.get(t.companyId), day(t.executedAt));
      return { ...t, seq, date: day(t.executedAt), qtyToday: t.qty.mul(f), priceToday: t.price.div(f) };
    })
    .sort((a, b) => compareTxns(a, b) || a.seq - b.seq);
  const cash = [...input.cash].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const starts = [...trades.map((t) => t.date), ...cash.map((c) => day(c.occurredAt))].sort();
  const empty: Valuation = {
    baseCurrency: base,
    tracksCash: input.tracksCash,
    asOf: input.today,
    holdings: [],
    cash: [],
    positionsValue: ZERO,
    totalValue: ZERO,
    twr: { cumulative: 0, annualized: null },
    mwr: null,
    dividendIncome: ZERO,
    netContributions: ZERO,
    integrity: [],
    series: [],
    warnings,
  };
  if (starts.length === 0) return empty;

  const qty = new Map<string, Decimal>();
  const cashBy = new Map<string, Decimal>();
  const oversold = new Map<string, Decimal>();
  const cursors = new Map<string, PriceCursor>();
  const lastTradePrice = new Map<string, Decimal>();
  const cursorFor = (id: string) => {
    let c = cursors.get(id);
    if (!c) {
      c = new PriceCursor(input.prices.get(id) ?? []);
      cursors.set(id, c);
    }
    return c;
  };
  const benchCursor = input.benchmark ? new PriceCursor(input.benchmark.closes) : null;

  const points: DayPoint[] = [];
  const flows: Flow[] = [];
  const series: Valuation["series"] = [];
  let dividendIncome = ZERO;
  let netContributions = ZERO;
  let benchBase: Decimal | null = null;

  let ti = 0;
  let ci = 0;
  for (let d = starts[0]; d <= input.today; d = addDays(d, 1)) {
    let flow = ZERO; // external, in base currency: in positive

    // 1. Dividends go ex on the shares held as the day opens.
    if (!input.tracksCash) {
      for (const [companyId, held] of qty) {
        if (held.lte(0)) continue;
        for (const div of input.dividends.get(companyId) ?? []) {
          if (div.exDate !== d) continue;
          const sharesThen =
            div.basis === "split_adjusted" ? held : held.div(splitFactor(input.splits.get(companyId), d));
          const ccy = input.companies.get(companyId)?.currency ?? "USD";
          const income = sharesThen.mul(div.amount).mul(rate(ccy, base, d));
          dividendIncome = dividendIncome.add(income);
          flow = flow.sub(income); // paid out to the investor
        }
      }
    }

    // 2. The day's trades, at its close.
    while (ti < trades.length && trades[ti].date <= d) {
      const t = trades[ti++];
      const held = qty.get(t.companyId) ?? ZERO;
      const fx = rate(t.currency, base, d);
      lastTradePrice.set(t.companyId, t.priceToday);
      if (t.side === "buy") {
        qty.set(t.companyId, held.add(t.qtyToday));
        const cost = t.qtyToday.mul(t.priceToday).add(t.fees);
        if (input.tracksCash) cashBy.set(t.currency, (cashBy.get(t.currency) ?? ZERO).sub(cost));
        else flow = flow.add(cost.mul(fx));
      } else {
        const sold = Decimal.min(t.qtyToday, held);
        if (t.qtyToday.gt(held)) oversold.set(t.companyId, (oversold.get(t.companyId) ?? ZERO).add(t.qtyToday.sub(held)));
        qty.set(t.companyId, held.sub(sold));
        const proceeds = sold.mul(t.priceToday).sub(t.fees);
        if (input.tracksCash) cashBy.set(t.currency, (cashBy.get(t.currency) ?? ZERO).add(proceeds));
        else flow = flow.sub(proceeds.mul(fx));
      }
    }

    // 3. Cash movements.
    while (ci < cash.length && day(cash[ci].occurredAt) <= d) {
      const c = cash[ci++];
      if (!input.tracksCash) continue;
      const sign = c.kind === "deposit" || c.kind === "dividend" || c.kind === "interest" ? 1 : -1;
      cashBy.set(c.currency, (cashBy.get(c.currency) ?? ZERO).add(c.amount.mul(sign)));
      if (c.kind === "deposit" || c.kind === "withdrawal") flow = flow.add(c.amount.mul(sign).mul(rate(c.currency, base, d)));
      if (c.kind === "dividend") dividendIncome = dividendIncome.add(c.amount.mul(rate(c.currency, base, d)));
    }

    // 4. Value at the day's prices.
    let value = ZERO;
    for (const [companyId, held] of qty) {
      if (held.lte(0)) continue;
      const ccy = input.companies.get(companyId)?.currency ?? "USD";
      const px = cursorFor(companyId).at(d)?.close ?? lastTradePrice.get(companyId) ?? ZERO;
      value = value.add(held.mul(px).mul(rate(ccy, base, d)));
    }
    if (input.tracksCash) {
      for (const [ccy, amount] of cashBy) value = value.add(amount.mul(rate(ccy, base, d)));
    }

    netContributions = netContributions.add(flow);
    points.push({ date: d, value: value.toNumber(), flow: flow.toNumber() });
    if (!flow.isZero()) flows.push({ date: d, amount: -flow.toNumber() });

    let benchmarkIndex: number | null = null;
    const b = benchCursor?.at(d);
    if (b && input.benchmark) {
      const inBase = b.close.mul(rate(input.benchmark.currency, base, d));
      benchBase ??= inBase;
      benchmarkIndex = inBase.div(benchBase).mul(100).toNumber();
    }
    series.push({ date: d, value: value.toNumber(), portfolioIndex: 0, benchmarkIndex });
  }

  const twr = timeWeightedReturn(points);
  const indexByDate = new Map(twr.index.map((p) => [p.date, p.value]));
  const trimmed = series
    .filter((p) => indexByDate.has(p.date))
    .map((p) => ({ ...p, portfolioIndex: indexByDate.get(p.date) as number }));
  // The benchmark is re-based to 100 on the first day the portfolio held anything.
  const first = trimmed.find((p) => p.benchmarkIndex !== null);
  if (first?.benchmarkIndex) {
    const b0 = first.benchmarkIndex;
    for (const p of trimmed) if (p.benchmarkIndex !== null) p.benchmarkIndex = (p.benchmarkIndex / b0) * 100;
  }

  const finalValue = points.at(-1)?.value ?? 0;
  const mwr = xirr([...flows, { date: input.today, amount: finalValue }]);

  /* ---- today's holdings */

  const holdings: HoldingView[] = [];
  let positionsValue = ZERO;
  for (const [companyId, info] of input.companies) {
    const own = trades.filter((t) => t.companyId === companyId);
    if (own.length === 0) continue;
    const local: Txn[] = own.map((t) => ({ side: t.side, qty: t.qtyToday, price: t.priceToday, fees: t.fees, executedAt: t.executedAt }));
    // The same trades at the FX of each trade's day: the cost basis (and the
    // realised gain) in the base currency, as a Canadian ACB is computed.
    const inBase: Txn[] = own.map((t) => {
      const fx = rate(t.currency, base, t.date);
      return { side: t.side, qty: t.qtyToday, price: t.priceToday.mul(fx), fees: t.fees.mul(fx), executedAt: t.executedAt };
    });
    const p = buildPosition(local);
    const pBase = buildPosition(inBase);
    if (p.qty.lte(0) && pBase.realizedPL.isZero()) continue;

    const last = cursorFor(companyId).at(input.today);
    const price = last?.close ?? p.avgCost;
    const fxNow = rate(info.currency, base, input.today);
    const marketValue = p.qty.mul(price).mul(fxNow);
    const costBasis = pBase.avgCost.mul(p.qty);
    positionsValue = positionsValue.add(marketValue);
    holdings.push({
      companyId,
      ticker: info.ticker,
      name: info.name,
      currency: info.currency,
      qty: p.qty,
      avgCost: p.avgCost,
      price,
      priceDate: last?.date ?? null,
      priced: Boolean(last),
      stale: last ? (Date.parse(input.today) - Date.parse(last.date)) / 86_400_000 > STALE_PRICE_DAYS : true,
      marketValue,
      costBasis,
      unrealizedPL: marketValue.sub(costBasis),
      realizedPL: pBase.realizedPL,
      weight: ZERO,
    });
  }
  const open = holdings.filter((h) => h.qty.gt(0));
  for (const h of open) h.weight = positionsValue.isZero() ? ZERO : h.marketValue.div(positionsValue);

  const cashRows = input.tracksCash
    ? [...cashBy.entries()].map(([currency, amount]) => ({ currency, amount, amountBase: amount.mul(rate(currency, base, input.today)) }))
    : [];
  const cashTotal = cashRows.reduce((s, c) => s.add(c.amountBase), ZERO);

  for (const key of missingFx) warnings.push(`no ${key} exchange rate was stored for part of the history; refresh FX rates`);
  if (input.tracksCash && cashRows.some((c) => c.amount.lt(0))) {
    warnings.push("a cash balance is negative: a deposit is probably missing from the ledger");
  }

  return {
    baseCurrency: base,
    tracksCash: input.tracksCash,
    asOf: input.today,
    holdings: [...open.sort((a, b) => b.marketValue.comparedTo(a.marketValue)), ...holdings.filter((h) => h.qty.lte(0))],
    cash: cashRows,
    positionsValue,
    totalValue: positionsValue.add(cashTotal),
    twr: { cumulative: twr.cumulative, annualized: twr.annualized },
    mwr,
    dividendIncome,
    netContributions,
    integrity: [...oversold.entries()].map(([id, n]) => ({ ticker: input.companies.get(id)?.ticker ?? "?", oversold: n.toString() })),
    series: trimmed,
    warnings,
  };
}
