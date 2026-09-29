import Decimal from "decimal.js";
import { pool } from "./db";
import { resolveCompany } from "./resolve";
import { fetchChart } from "./quote";
import { buildPosition, type Txn } from "./portfolio";
import { addJournal } from "./ai/journal";

/* ---------------------------------------------------------------------------
   Paper trading.

   Simulated money, filled at the live price, kept apart from the real ledger.
   Every trade stores SPY's price when it was placed, so the portfolio is
   compared with the same dollars put into SPY on the same days. Trades placed
   from a committee's conclusion carry the run id, which is how each AI
   hypothesis gets a running score.
--------------------------------------------------------------------------- */

export const STARTING_CAPITAL = Number(process.env.PAPER_STARTING_CAPITAL ?? 100_000);
// A flat commission per trade, so a strategy that trades constantly pays for it.
const FEE = 1;

export class PaperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperError";
  }
}

async function livePrice(ticker: string): Promise<number> {
  const chart = await fetchChart(ticker, "5d");
  if (chart.price === null || !(chart.price > 0)) throw new PaperError(`no live price for ${ticker}`);
  return chart.price;
}

interface TradeRow {
  id: string;
  createdAt: string;
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fees: number;
  spyPrice: number | null;
  runId: string | null;
  rationale: string | null;
}

async function trades(): Promise<TradeRow[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.created_at, c.ticker, p.side, p.qty, p.price, p.fees, p.spy_price, p.run_id, p.rationale
     FROM paper_trades p JOIN companies c ON c.id = p.company_id
     ORDER BY p.created_at, p.id`
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: (r.created_at as Date).toISOString(),
    ticker: r.ticker,
    side: r.side,
    qty: Number(r.qty),
    price: Number(r.price),
    fees: Number(r.fees),
    spyPrice: r.spy_price === null ? null : Number(r.spy_price),
    runId: r.run_id,
    rationale: r.rationale,
  }));
}

function cashAfter(list: TradeRow[]): Decimal {
  return list.reduce((cash, t) => {
    const gross = new Decimal(t.qty).mul(t.price);
    return t.side === "buy" ? cash.sub(gross).sub(t.fees) : cash.add(gross).sub(t.fees);
  }, new Decimal(STARTING_CAPITAL));
}

export async function placeOrder(input: {
  ticker: string;
  side: "buy" | "sell";
  dollars?: number;
  qty?: number;
  runId?: string | null;
  rationale?: string | null;
}): Promise<TradeRow> {
  const company = await resolveCompany(input.ticker);
  const [price, spy] = await Promise.all([livePrice(company.ticker), livePrice("SPY").catch(() => null)]);

  let qty = input.qty ?? (input.dollars !== undefined ? input.dollars / price : NaN);
  if (!Number.isFinite(qty) || qty <= 0) throw new PaperError("an order needs a positive quantity or dollar amount");
  qty = Math.floor(qty * 1e6) / 1e6;

  const history = await trades();
  if (input.side === "buy") {
    const cash = cashAfter(history);
    const cost = new Decimal(qty).mul(price).add(FEE);
    if (cost.gt(cash)) throw new PaperError(`not enough paper cash: the order costs ${cost.toFixed(2)}, ${cash.toFixed(2)} is available`);
  } else {
    const held = history
      .filter((t) => t.ticker === company.ticker)
      .reduce((q, t) => q + (t.side === "buy" ? t.qty : -t.qty), 0);
    if (qty > held + 1e-9) throw new PaperError(`only ${held} ${company.ticker} is held on paper`);
  }

  const { rows } = await pool.query(
    `INSERT INTO paper_trades (company_id, side, qty, price, fees, spy_price, run_id, rationale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [company.id, input.side, qty, price, FEE, spy, input.runId ?? null, input.rationale?.slice(0, 500) ?? null]
  );

  await addJournal({
    companyId: company.id,
    kind: "paper-trade",
    title: `Paper ${input.side} ${qty} ${company.ticker} at ${price.toFixed(2)}`,
    detail: input.rationale ?? null,
    refId: input.runId ?? rows[0].id,
  });

  return {
    id: rows[0].id,
    createdAt: (rows[0].created_at as Date).toISOString(),
    ticker: company.ticker,
    side: input.side,
    qty,
    price,
    fees: FEE,
    spyPrice: spy,
    runId: input.runId ?? null,
    rationale: input.rationale ?? null,
  };
}

export interface PaperPosition {
  ticker: string;
  qty: number;
  avgCost: number;
  price: number | null;
  value: number;
  unrealized: number;
  realized: number;
  weight: number;
}

export interface Hypothesis {
  tradeId: string;
  ticker: string;
  runId: string;
  rationale: string | null;
  enteredAt: string;
  entryPrice: number;
  price: number | null;
  return: number | null;
  spyReturn: number | null;
}

export interface PaperPortfolio {
  startingCapital: number;
  cash: number;
  value: number;
  totalReturn: number;
  benchmarkValue: number | null;
  benchmarkReturn: number | null;
  positions: PaperPosition[];
  hypotheses: Hypothesis[];
  trades: TradeRow[];
  priceErrors: string[];
}

export async function paperPortfolio(): Promise<PaperPortfolio> {
  const list = await trades();
  const tickers = [...new Set(list.map((t) => t.ticker))];
  const priceErrors: string[] = [];
  const prices = new Map<string, number>();
  await Promise.all(
    [...tickers, "SPY"].map(async (t) => {
      try {
        prices.set(t, await livePrice(t));
      } catch {
        priceErrors.push(t);
      }
    })
  );

  const positions: PaperPosition[] = [];
  for (const ticker of tickers) {
    const txns: Txn[] = list
      .filter((t) => t.ticker === ticker)
      .map((t) => ({ side: t.side, qty: t.qty, price: t.price, fees: t.fees, executedAt: new Date(t.createdAt) }));
    const p = buildPosition(txns);
    const price = prices.get(ticker) ?? null;
    const mark = price ?? p.avgCost.toNumber();
    positions.push({
      ticker,
      qty: p.qty.toNumber(),
      avgCost: p.avgCost.toNumber(),
      price,
      value: p.qty.mul(mark).toNumber(),
      unrealized: p.qty.mul(mark).sub(p.qty.mul(p.avgCost)).toNumber(),
      realized: p.realizedPL.toNumber(),
      weight: 0,
    });
  }

  const cash = cashAfter(list).toNumber();
  const invested = positions.reduce((s, p) => s + p.value, 0);
  const value = cash + invested;
  for (const p of positions) p.weight = value > 0 ? p.value / value : 0;

  // The same cash flows into SPY: each buy buys SPY, each sell sells SPY, at the
  // SPY price recorded with the trade.
  const spyNow = prices.get("SPY") ?? null;
  let spyShares = 0;
  let spyCash = STARTING_CAPITAL;
  let benchmarkComplete = spyNow !== null;
  for (const t of list) {
    if (t.spyPrice === null) {
      benchmarkComplete = false;
      break;
    }
    const dollars = t.qty * t.price;
    if (t.side === "buy") {
      spyShares += dollars / t.spyPrice;
      spyCash -= dollars + t.fees;
    } else {
      spyShares -= dollars / t.spyPrice;
      spyCash += dollars - t.fees;
    }
  }
  const benchmarkValue = benchmarkComplete && spyNow !== null ? spyCash + spyShares * spyNow : null;

  const hypotheses: Hypothesis[] = list
    .filter((t) => t.runId && t.side === "buy")
    .map((t) => {
      const price = prices.get(t.ticker) ?? null;
      return {
        tradeId: t.id,
        ticker: t.ticker,
        runId: t.runId as string,
        rationale: t.rationale,
        enteredAt: t.createdAt,
        entryPrice: t.price,
        price,
        return: price === null ? null : price / t.price - 1,
        spyReturn: spyNow !== null && t.spyPrice ? spyNow / t.spyPrice - 1 : null,
      };
    });

  return {
    startingCapital: STARTING_CAPITAL,
    cash,
    value,
    totalReturn: value / STARTING_CAPITAL - 1,
    benchmarkValue,
    benchmarkReturn: benchmarkValue === null ? null : benchmarkValue / STARTING_CAPITAL - 1,
    positions: positions.filter((p) => p.qty > 0 || p.realized !== 0).sort((a, b) => b.value - a.value),
    hypotheses,
    trades: [...list].reverse(),
    priceErrors,
  };
}
