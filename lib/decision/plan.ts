import { THRESHOLDS, type TechnicalSnapshot } from "../technicals";

/* ---------------------------------------------------------------------------
   The Trader: where to get in, where the idea is wrong, and what a win has to
   be worth to repay the risk.

   TradingAgents has a model propose the transaction with its own price
   targets. A model's price target is a forecast, and this desk's committee is
   forbidden to make one, so none is made here either. What is computed instead
   is arithmetic on figures already measured:

     entry  the last close, or the 20-day average when the price is stretched
            (overbought, or above its upper Bollinger band), where waiting for
            a pullback is the conventional reading;
     stop   STOP_ATRS average true ranges below the entry: the distance the
            stock moves on an ordinary bad day, repeated, so a stop there says
            "the idea is wrong" rather than "the market breathed";
     levels the prices at which a win equals 1.5, 2 and 3 times the risk taken.
            These are planning levels — what the reward must be to repay the
            risk — not predictions of where the price will go.

   Pure: a technical snapshot in, a plan out.
--------------------------------------------------------------------------- */

export const PLAN_RULES = {
  stopAtrs: 2,
  rewardMultiples: [1.5, 2, 3],
  // ATR above this share of the price is a stock that moves a lot in a day
  volatileAtrShare: 0.06,
} as const;

export type PlanSide = "enter" | "exit" | "none";

export interface PlanEntry {
  price: number;
  kind: "market" | "pullback";
  note: string;
}

export interface PlanLevel {
  multiple: number;
  price: number;
}

export interface TradePlan {
  side: PlanSide;
  // the last close the plan was drawn from
  reference: number | null;
  asOf: string | null;
  entry: PlanEntry | null;
  stop: { price: number; atrs: number; note: string } | null;
  // currency per share put at risk between entry and stop
  riskPerShare: number | null;
  // that, as a share of the entry price
  riskShare: number | null;
  levels: PlanLevel[];
  // true while the price is below its 50-day average, itself below the 200-day
  downtrend: boolean;
  notes: string[];
}

export function tradePlan(input: { side: PlanSide; snapshot: TechnicalSnapshot | null; last: number | null }): TradePlan {
  const { side, snapshot } = input;
  const last = snapshot?.last ?? input.last;
  const plan: TradePlan = {
    side,
    reference: last,
    asOf: snapshot?.asOf ?? null,
    entry: null,
    stop: null,
    riskPerShare: null,
    riskShare: null,
    levels: [],
    downtrend: false,
    notes: [],
  };

  if (side === "none") return plan;
  if (last === null || !(last > 0)) {
    plan.notes.push("The desk has no price for this stock, so no plan can be drawn.");
    return plan;
  }

  if (side === "exit") {
    plan.notes.push(`Reference price ${last.toFixed(2)}. An exit has no entry, stop or reward levels; sell at the next regular session.`);
    return plan;
  }

  // ---- entry
  const stretched = snapshot?.readings.rsiZone === "overbought" || snapshot?.readings.bandPosition === "above the upper band";
  const middle = snapshot?.bollinger?.middle ?? null;
  if (stretched && middle !== null && middle > 0 && middle < last) {
    const why =
      snapshot?.readings.rsiZone === "overbought"
        ? `RSI(14) is ${snapshot.rsi14?.toFixed(1)}, at or above ${THRESHOLDS.rsiOverbought}`
        : "the price is above its upper Bollinger band";
    plan.entry = {
      price: middle,
      kind: "pullback",
      note: `The stock looks stretched (${why}): the plan waits for a pullback to the 20-day average, ${middle.toFixed(2)}, instead of paying ${last.toFixed(2)}.`,
    };
  } else {
    plan.entry = { price: last, kind: "market", note: `Enter at about the last close, ${last.toFixed(2)}.` };
  }

  // ---- stop and risk
  const atr = snapshot?.atr14 ?? null;
  if (atr !== null && atr > 0) {
    const stopPrice = plan.entry.price - PLAN_RULES.stopAtrs * atr;
    if (stopPrice > 0) {
      plan.stop = {
        price: stopPrice,
        atrs: PLAN_RULES.stopAtrs,
        note: `${PLAN_RULES.stopAtrs} × ATR(14) of ${atr.toFixed(2)} below the entry.`,
      };
      plan.riskPerShare = PLAN_RULES.stopAtrs * atr;
      plan.riskShare = plan.riskPerShare / plan.entry.price;
      plan.levels = PLAN_RULES.rewardMultiples.map((m) => ({ multiple: m, price: plan.entry!.price + m * (plan.riskPerShare as number) }));
    } else {
      plan.notes.push("The stock is so volatile that two ATRs below the entry would be zero or less; no stop is drawn.");
    }
    if (snapshot?.atrPct != null && snapshot.atrPct > PLAN_RULES.volatileAtrShare) {
      plan.notes.push(`ATR is ${(snapshot.atrPct * 100).toFixed(1)}% of the price: an ordinary day moves this stock a lot, so the stop is wide and the position is sized smaller to match.`);
    }
  } else {
    plan.notes.push("There is not enough price history to compute ATR, so no stop is drawn; the size falls back on the stress loss the checklist plans for.");
  }

  // ---- trend
  plan.downtrend = snapshot?.readings.trend === "downtrend";
  if (plan.downtrend) {
    plan.notes.push("The price is below its 50-day average, which is below its 200-day average (a downtrend): the size is halved until that turns.");
  }

  return plan;
}
