import type { DecisionRating } from "../decision/rating";
import { planShapeOf, walkPlan, type PathBar, type PathResult } from "./paths";

/* ---------------------------------------------------------------------------
   Settling one recorded decision against what the stock did next.

   TradingAgents keeps a log of each decision and, once enough time has passed,
   resolves it with the realised return and the return less the market's. This
   does the same from the desk's own stored closes:

     return   the stock's close `horizon` sessions after the decision's price
              date, against that date's close;
     alpha    that, less the S&P 500's return between the same two dates.

   A rating is graded by its direction against the market, not by whether the
   stock went up: Buy and Overweight are right when the stock beat the market,
   Underweight and Sell when it trailed it. A Hold makes no claim about the stock
   against the market and is measured but not graded. Inside a band that widens
   with the square root of the horizon (a stock's noise does), the call is flat:
   neither right nor wrong.

   A decision is not measured when it cannot be fairly: a split inside the
   window (the plan's levels are on the old share count), a hole in the stored
   prices, or no stored close near the decision's date. It is recorded as
   excluded, with the reason, rather than guessed at.

   Pure: bars in, an outcome out. It reads no database and no clock; whether a
   horizon has closed yet is whether the bars reach it.
--------------------------------------------------------------------------- */

export const SETTLE_RULES = {
  // sessions after the decision's price date
  horizons: [5, 20, 60],
  // the one the journal and the committee's evidence quote
  primaryHorizon: 20,
  // alpha within this many percentage points per square-root session is flat: 0.5% at 1 session, 1.1% at 5, 2.2% at 20, 3.9% at 60
  flatBandPerRootSession: 0.005,
  // calendar days per session beyond which the stored prices have a hole in them
  gapDaysPerSession: 4,
  // how far the stored close may sit from the decision's price date
  entryGapDays: 4,
} as const;

export type Verdict = "right" | "wrong" | "flat" | "no_claim" | "excluded";

export type Direction = "bullish" | "bearish" | "none";

export const DIRECTION: Record<DecisionRating, Direction> = {
  buy: "bullish",
  overweight: "bullish",
  hold: "none",
  underweight: "bearish",
  sell: "bearish",
};

export interface Close {
  date: string;
  close: number;
}

export interface DecisionToSettle {
  rating: DecisionRating;
  // the date of the close the plan was drawn from (decisions.price_as_of)
  asOf: string | null;
  // decision.plan as stored
  plan: unknown;
}

export interface Outcome {
  horizon: number;
  verdict: Verdict;
  // why it was excluded
  reason: string | null;
  entryDate: string | null;
  entryClose: number | null;
  exitDate: string | null;
  exitClose: number | null;
  stockReturn: number | null;
  marketReturn: number | null;
  alpha: number | null;
  path: PathResult | null;
}

const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

// The last bar on or before a date, or -1.
export function indexOnOrBefore(bars: readonly { date: string }[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export const flatBand = (horizon: number) => SETTLE_RULES.flatBandPerRootSession * Math.sqrt(horizon);

export function verdictOf(rating: DecisionRating, alpha: number, horizon: number): Verdict {
  const direction = DIRECTION[rating];
  if (direction === "none") return "no_claim";
  const band = flatBand(horizon);
  if (Math.abs(alpha) < band) return "flat";
  return (direction === "bullish") === alpha > 0 ? "right" : "wrong";
}

const excluded = (horizon: number, reason: string): Outcome => ({
  horizon,
  verdict: "excluded",
  reason,
  entryDate: null,
  entryClose: null,
  exitDate: null,
  exitClose: null,
  stockReturn: null,
  marketReturn: null,
  alpha: null,
  path: null,
});

// The outcome at one horizon, or null while it has not closed (the stored bars
// do not reach it yet, or the market's closes for its two dates are missing).
// `bars` and `market` are oldest first; `splits` are the company's split dates.
export function settleAt(args: {
  decision: DecisionToSettle;
  horizon: number;
  bars: readonly PathBar[];
  market: readonly Close[];
  splits: readonly string[];
}): Outcome | null {
  const { decision, horizon, bars, market, splits } = args;
  // Without a price date no price can ever be matched to it, so this does not wait on the bars.
  if (decision.asOf === null) return excluded(horizon, "the decision was recorded without a price date");
  if (bars.length === 0) return null;

  const a = indexOnOrBefore(bars, decision.asOf);
  if (a < 0) {
    // The stored prices begin after the decision: they will never reach back to it.
    return bars.length > horizon ? excluded(horizon, `no price is stored from before ${decision.asOf}`) : null;
  }
  const e = a + horizon;
  if (e >= bars.length) return null;

  const entry = bars[a];
  const exit = bars[e];
  if (daysBetween(entry.date, decision.asOf) > SETTLE_RULES.entryGapDays) {
    return excluded(horizon, `the nearest stored close, ${entry.date}, is more than ${SETTLE_RULES.entryGapDays} days from the decision's price date ${decision.asOf}`);
  }
  if (daysBetween(entry.date, exit.date) > horizon * SETTLE_RULES.gapDaysPerSession) {
    return excluded(horizon, `the stored prices have a hole in them between ${entry.date} and ${exit.date}`);
  }
  if (splits.some((s) => s > entry.date && s <= exit.date)) {
    return excluded(horizon, `a split fell between ${entry.date} and ${exit.date}, so the plan's prices and the later closes are on different share counts`);
  }

  const m0 = market.find((m) => m.date === entry.date)?.close;
  const m1 = market.find((m) => m.date === exit.date)?.close;
  if (m0 === undefined || m1 === undefined) return null;

  const stockReturn = exit.close / entry.close - 1;
  const marketReturn = m1 / m0 - 1;
  const alpha = stockReturn - marketReturn;

  const plan = planShapeOf(decision.plan);
  return {
    horizon,
    verdict: verdictOf(decision.rating, alpha, horizon),
    reason: null,
    entryDate: entry.date,
    entryClose: entry.close,
    exitDate: exit.date,
    exitClose: exit.close,
    stockReturn,
    marketReturn,
    alpha,
    path: plan ? walkPlan(plan, bars, a, e) : null,
  };
}
