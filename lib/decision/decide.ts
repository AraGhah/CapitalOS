import { stressLoss, type VerdictLevel } from "../checklist";
import type { RiskTolerance } from "../profile-fields";
import type { TechnicalSnapshot } from "../technicals";
import { tradePlan, type PlanSide, type TradePlan } from "./plan";
import { RATING_LABEL, rate, type RatingInput, type RatingResult } from "./rating";
import { sizePosition, type Sizing } from "./sizing";

/* ---------------------------------------------------------------------------
   The Portfolio Manager: the final call on one stock for one person.

   It takes the rating the committee's numbers earn (rating.ts), puts it
   through the person's own pre-investment checklist and open thesis, asks the
   Trader for a plan (plan.ts) and sizes it against the person's capital and
   risk tolerance (sizing.ts). The answer is one of seven actions:

     buy / add    new money, with a size, an entry and a stop
     hold         nothing to do (including: the plan asks for what you hold)
     trim / sell  take money out, with the number of shares
     watch        not held, and not a buy; keep an eye on it
     avoid        not held, and something says stay out (a Sell or Underweight
                  rating, or a blocker)

   A rating of Buy or Overweight never turns into buy or add while the checklist
   says "not ready" or an open thesis rule is breached: the person comes before
   the stock. Everything is computed: no model is called, and the same inputs
   give the same decision.

   Pure: gatherDecisionInput (lib/decision/data.ts) fetches the inputs.
--------------------------------------------------------------------------- */

export type Action = "buy" | "add" | "hold" | "trim" | "sell" | "watch" | "avoid";

export interface ChecklistDigest {
  level: VerdictLevel;
  headline: string;
  blocking: string[];
  unverified: string[];
  risks: string[];
}

export interface DecisionInput {
  runId: string | null;
  ticker: string;
  name: string;
  // the date the decision is for
  asOf: string;
  rating: RatingInput;
  // null when the checklist could not be built
  checklist: ChecklistDigest | null;
  thesisBreached: boolean;
  technical: TechnicalSnapshot | null;
  // last close from the checklist's price history, used when there is no snapshot
  last: number | null;
  listingCurrency: string;
  baseCurrency: string;
  // base currency per one unit of the listing currency; null when no rate is stored
  fxToBase: number | null;
  profile: {
    tolerance: RiskTolerance | null;
    plannedSize: number | null;
    investableAmount: number | null;
    maxLossShare: number | null;
  };
  portfolio: {
    // everything held, base currency
    holdingsValue: number;
    // this company: base currency and shares
    heldValue: number;
    heldQty: number;
    // holdings in this company's sector, this company included; null when it has none recorded
    sectorValue: number | null;
  };
  volatility: number | null;
  maxDrawdown: number | null;
  avgDollarVolume: number | null;
}

export interface Decision {
  version: 1;
  ticker: string;
  name: string;
  asOf: string;
  runId: string | null;
  rating: RatingResult;
  confidence: RatingInput["confidence"];
  action: Action;
  headline: string;
  // what stopped a buy; empty when nothing did
  blockers: string[];
  cautions: string[];
  plan: TradePlan;
  sizing: Sizing;
  checklist: ChecklistDigest | null;
  currency: { listing: string; base: string; fxToBase: number | null };
}

export const ACTION_LABEL: Record<Action, string> = {
  buy: "Buy",
  add: "Add",
  hold: "Hold",
  trim: "Trim",
  sell: "Sell",
  watch: "Watch",
  avoid: "Avoid",
};

const money = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export function decide(input: DecisionInput): Decision {
  const result = rate(input.rating);
  const final = result.final;
  const positive = final === "buy" || final === "overweight";
  const held = input.portfolio.heldQty > 0;
  const blockers: string[] = [];
  const cautions: string[] = [];

  // ---- the person comes before the stock
  if (positive) {
    if (!input.checklist) {
      blockers.push("The pre-investment checklist could not be built, so nothing can be recommended for purchase.");
    } else if (input.checklist.level === "not_ready") {
      blockers.push(input.checklist.headline);
    }
    if (input.thesisBreached) blockers.push("A rule in your open thesis for this stock is breached. Resolve it before adding money.");
    if (input.checklist && input.checklist.level === "incomplete") {
      cautions.push(`${input.checklist.unverified.length} checklist ${input.checklist.unverified.length === 1 ? "question is" : "questions are"} unanswered (${input.checklist.unverified.slice(0, 4).join(", ").toLowerCase()}), so the size is halved.`);
    } else if (input.checklist && input.checklist.level === "material_risks") {
      cautions.push(`The checklist found material risks (${input.checklist.risks.join(", ").toLowerCase()}), so the size is halved.`);
    }
  }
  const blocked = positive && blockers.length > 0;

  const side: PlanSide = positive ? (blocked ? "none" : "enter") : (final === "underweight" || final === "sell") && held ? "exit" : "none";
  const plan = tradePlan({ side, snapshot: input.technical, last: input.last });

  const capital = input.portfolio.holdingsValue + (input.profile.investableAmount ?? 0);
  const affordableLoss =
    input.profile.maxLossShare !== null && input.profile.investableAmount !== null ? input.profile.maxLossShare * input.profile.investableAmount : null;
  const sizing = sizePosition({
    // a blocked buy sizes as a hold: keep what is held, add nothing
    rating: blocked ? "hold" : final,
    confidence: input.rating.confidence.label,
    tolerance: input.profile.tolerance,
    capital: capital > 0 ? capital : null,
    heldValue: input.portfolio.heldValue,
    heldQty: input.portfolio.heldQty,
    sectorValue: input.portfolio.sectorValue,
    plannedSize: input.profile.plannedSize,
    affordableLoss,
    stress: stressLoss(input.volatility, input.maxDrawdown),
    entry: plan.entry?.price ?? null,
    riskShare: plan.riskShare,
    avgDollarVolume: input.avgDollarVolume,
    fxToBase: input.fxToBase,
    checklist: input.checklist?.level ?? null,
    downtrend: plan.downtrend,
  });

  // ---- the action
  let action: Action;
  if (positive) {
    if (blocked) action = held ? "hold" : "avoid";
    else if (sizing.shares !== null && sizing.shares >= 1) action = held ? "add" : "buy";
    else action = held ? "hold" : "watch";
  } else if (final === "hold") {
    action = held ? "hold" : "watch";
  } else if (final === "underweight") {
    action = held ? (sizing.shares !== null && sizing.shares < 0 ? "trim" : "hold") : "avoid";
  } else {
    action = held ? "sell" : "avoid";
  }

  if (positive && !blocked && action !== "buy" && action !== "add") {
    cautions.push(
      sizing.shares === null
        ? "The rating is positive, but the position could not be sized (see the sizing notes), so there is nothing to buy yet."
        : "The rating is positive, but the position the plan asks for is no larger than what you hold, or under one share."
    );
  }
  cautions.push(...sizing.notes);
  cautions.push(...plan.notes);

  return {
    version: 1,
    ticker: input.ticker,
    name: input.name,
    asOf: input.asOf,
    runId: input.runId,
    rating: result,
    confidence: input.rating.confidence,
    action,
    headline: headlineOf(action, final, input, plan, sizing, blockers),
    blockers,
    cautions,
    plan,
    sizing,
    checklist: input.checklist,
    currency: { listing: input.listingCurrency, base: input.baseCurrency, fxToBase: input.fxToBase },
  };
}

function headlineOf(action: Action, rating: RatingResult["final"], input: DecisionInput, plan: TradePlan, sizing: Sizing, blockers: string[]): string {
  const label = RATING_LABEL[rating];
  const t = input.ticker;
  switch (action) {
    case "buy":
    case "add": {
      const shares = sizing.shares as number;
      let line = `${label}: ${action} ${shares} ${shares === 1 ? "share" : "shares"} of ${t}`;
      if (plan.entry) line += ` at about ${plan.entry.price.toFixed(2)}${plan.entry.kind === "pullback" ? " (on a pullback)" : ""}`;
      if (plan.entry && input.fxToBase !== null) line += ` (about ${money(shares * plan.entry.price * input.fxToBase)} ${input.baseCurrency})`;
      if (plan.stop) line += `, stop ${plan.stop.price.toFixed(2)}`;
      if (sizing.targetWeight !== null) line += `, taking the position to ${pct(sizing.targetWeight)} of your capital`;
      return `${line}.`;
    }
    case "trim":
      return `${label}: trim ${Math.abs(sizing.shares ?? 0)} of your ${input.portfolio.heldQty} shares of ${t}, half the position.`;
    case "sell":
      return `${label}: sell your ${input.portfolio.heldQty} ${input.portfolio.heldQty === 1 ? "share" : "shares"} of ${t}.`;
    case "hold":
      return blockers.length > 0
        ? `${label}, but held back: keep your ${t} and add nothing. ${blockers[0]}`
        : `${label}: keep your ${t}; there is no change to make.`;
    case "watch":
      return `${label}: ${t} is not a purchase today. Keep it on the watchlist.`;
    case "avoid":
      return blockers.length > 0 ? `${label}, but not for you right now: ${blockers[0]}` : `${label}: stay out of ${t}.`;
  }
}
