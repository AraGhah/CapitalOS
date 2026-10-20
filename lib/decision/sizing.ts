import type { Confidence } from "../ai/consensus";
import { T, type VerdictLevel } from "../checklist";
import type { RiskTolerance } from "../profile-fields";
import type { DecisionRating } from "./rating";

/* ---------------------------------------------------------------------------
   The Portfolio Manager's arithmetic: how much, given who is investing.

   ai-hedge-fund's portfolio manager asks a model how many shares to trade,
   inside limits its risk manager computes. Here the limits are the whole
   answer. A buy is sized by the smallest of six ceilings, each of which says in
   words what it protects:

     risk budget      the stop being hit costs no more than a set share of
                      your capital (0.5% / 1% / 1.5% for low / medium / high
                      risk tolerance)
     position cap     no single stock above 5% / 8% / 10% of capital
     affordable loss  a fall of the size the checklist plans for (never less
                      than half) costs no more than you said you could lose
     sector room      the sector stays under the checklist's 40% bar
     liquidity        the position can be sold within 5 sessions at 10% of the
                      stock's average daily dollar volume
     planned size     what you wrote on your profile as the position you intend

   and then trimmed by factors for conviction, an unfinished checklist, a
   downtrend and an overweight (rather than buy) rating. Money amounts are in
   the account's base currency; prices are in the stock's own currency, so
   shares need the exchange rate between them.

   Pure: every input is passed in.
--------------------------------------------------------------------------- */

export const SIZING_RULES = {
  riskBudget: { low: 0.005, medium: 0.01, high: 0.015 },
  positionCap: { low: 0.05, medium: 0.08, high: 0.1 },
  sectorCap: T.sectorCaution,
  exitSessions: 5,
  participation: T.participation,
  // how much of a full-size position each confidence label earns
  confidence: { High: 1, "Medium-high": 1, Medium: 0.75, Low: 0 } as Record<Confidence["label"], number>,
  overweight: 0.5,
  unfinishedChecklist: 0.5,
  downtrend: 0.5,
  // an underweight cuts the position by this share
  trimShare: 0.5,
} as const;

export interface SizingInput {
  rating: DecisionRating;
  confidence: Confidence["label"];
  tolerance: RiskTolerance | null;
  // base currency: holdings plus the money set aside to invest
  capital: number | null;
  // what is held in this company now: base currency, and shares
  heldValue: number;
  heldQty: number;
  // everything held in the company's sector (this company included), base currency
  sectorValue: number | null;
  plannedSize: number | null;
  // the loss the person said they could absorb, base currency
  affordableLoss: number | null;
  // the fall the checklist plans for on one stock, as a share
  stress: number;
  // the plan's entry price, in the stock's currency
  entry: number | null;
  // the stop's distance from the entry as a share of it; null without a stop
  riskShare: number | null;
  avgDollarVolume: number | null;
  // base currency per one unit of the stock's currency; null when unknown
  fxToBase: number | null;
  checklist: VerdictLevel | null;
  downtrend: boolean;
}

export interface Constraint {
  name: string;
  // the most this ceiling allows in the stock, base currency
  limit: number;
  note: string;
}

export interface Multiplier {
  name: string;
  factor: number;
  reason: string;
}

export interface Sizing {
  capital: number | null;
  constraints: Constraint[];
  // the ceiling that was lowest
  binding: string | null;
  baseTarget: number | null;
  multipliers: Multiplier[];
  // the position the plan asks for, base currency and share of capital
  targetValue: number | null;
  targetWeight: number | null;
  currentValue: number;
  // targetValue − currentValue: positive buys, negative sells
  deltaValue: number | null;
  // whole shares to trade at the entry (negative sells); null when unknown
  shares: number | null;
  notes: string[];
}

const money = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const roundDown4 = (x: number) => Math.floor(x * 10_000 + 1e-9) / 10_000;

function empty(input: SizingInput): Sizing {
  return {
    capital: input.capital,
    constraints: [],
    binding: null,
    baseTarget: null,
    multipliers: [],
    targetValue: null,
    targetWeight: null,
    currentValue: input.heldValue,
    deltaValue: null,
    shares: null,
    notes: [],
  };
}

export function sizePosition(input: SizingInput): Sizing {
  const out = empty(input);
  const { rating } = input;
  const weight = (v: number) => (input.capital && input.capital > 0 ? v / input.capital : null);

  if (rating === "hold") {
    out.targetValue = input.heldValue;
    out.targetWeight = weight(input.heldValue);
    out.deltaValue = 0;
    out.shares = 0;
    return out;
  }

  if (rating === "sell") {
    out.targetValue = 0;
    out.targetWeight = 0;
    // `|| 0` keeps an empty position at 0 rather than -0, which JSON would not keep
    out.deltaValue = -input.heldValue || 0;
    out.shares = -input.heldQty || 0;
    return out;
  }

  if (rating === "underweight") {
    out.targetValue = input.heldValue * (1 - SIZING_RULES.trimShare);
    out.targetWeight = weight(out.targetValue);
    out.deltaValue = out.targetValue - input.heldValue || 0;
    out.shares = -roundDown4(input.heldQty * SIZING_RULES.trimShare) || 0;
    return out;
  }

  // ---- buy or overweight: the ceilings
  const capital = input.capital;
  if (capital === null || !(capital > 0)) {
    out.notes.push("The desk does not know your capital. Add the money you set aside to invest on your profile (or record holdings) and a size can be worked out.");
    return out;
  }

  const tolerance = input.tolerance ?? "low";
  if (input.tolerance === null) out.notes.push("Your risk tolerance is not set on your profile, so the lowest one (low) is used.");

  const hasStop = input.riskShare !== null && input.riskShare > 0;
  const riskFraction = hasStop ? (input.riskShare as number) : input.stress;
  const riskBasis =
    hasStop
      ? `the stop, ${pct(riskFraction)} below the entry,`
      : `the ${pct(input.stress, 0)} fall the checklist plans for (there is no stop to measure from),`;
  const budget = SIZING_RULES.riskBudget[tolerance];
  const cap = SIZING_RULES.positionCap[tolerance];

  out.constraints.push({
    name: "risk budget",
    limit: (budget * capital) / riskFraction,
    note: `If ${riskBasis} is hit, the loss stays within ${pct(budget)} of your ${money(capital)} (${tolerance} tolerance).`,
  });
  out.constraints.push({
    name: "position cap",
    limit: cap * capital,
    note: `No single stock above ${pct(cap, 0)} of your ${money(capital)} (${tolerance} tolerance).`,
  });
  if (input.affordableLoss !== null) {
    out.constraints.push({
      name: "affordable loss",
      limit: input.affordableLoss / input.stress,
      note: `A ${pct(input.stress, 0)} fall must cost no more than the ${money(input.affordableLoss)} you said you could lose.`,
    });
  }
  if (input.sectorValue !== null) {
    const others = Math.max(0, input.sectorValue - input.heldValue);
    out.constraints.push({
      name: "sector room",
      limit: Math.max(0, SIZING_RULES.sectorCap * capital - others),
      note: `The sector stays under ${pct(SIZING_RULES.sectorCap, 0)} of your capital; ${money(others)} is already in other stocks there.`,
    });
  }
  if (input.avgDollarVolume !== null && input.fxToBase !== null) {
    out.constraints.push({
      name: "liquidity",
      limit: SIZING_RULES.exitSessions * SIZING_RULES.participation * input.avgDollarVolume * input.fxToBase,
      note: `Sellable within ${SIZING_RULES.exitSessions} sessions at ${pct(SIZING_RULES.participation, 0)} of its average daily dollar volume.`,
    });
  } else if (input.avgDollarVolume === null) {
    out.notes.push("The desk has no volume history for this stock, so the liquidity ceiling is not applied.");
  }
  if (input.plannedSize !== null && input.plannedSize > 0) {
    out.constraints.push({
      name: "planned size",
      limit: input.plannedSize,
      note: `The position size you wrote on your profile, ${money(input.plannedSize)}.`,
    });
  }

  const lowest = out.constraints.reduce((a, b) => (b.limit < a.limit ? b : a));
  out.binding = lowest.name;
  out.baseTarget = lowest.limit;

  // ---- factors
  if (rating === "overweight") {
    out.multipliers.push({ name: "overweight", factor: SIZING_RULES.overweight, reason: "An overweight gets half the size a buy would." });
  }
  const conviction = SIZING_RULES.confidence[input.confidence];
  if (conviction < 1) {
    out.multipliers.push({ name: "confidence", factor: conviction, reason: `Committee confidence is ${input.confidence}.` });
  }
  if (input.checklist === "incomplete" || input.checklist === "material_risks") {
    out.multipliers.push({
      name: "checklist",
      factor: SIZING_RULES.unfinishedChecklist,
      reason: input.checklist === "incomplete" ? "The pre-investment checklist still has unanswered questions." : "The pre-investment checklist found material risks.",
    });
  }
  if (input.downtrend) {
    out.multipliers.push({ name: "downtrend", factor: SIZING_RULES.downtrend, reason: "The price is in a downtrend." });
  }

  const factor = out.multipliers.reduce((p, m) => p * m.factor, 1);
  out.targetValue = out.baseTarget * factor;
  out.targetWeight = out.targetValue / capital;
  out.deltaValue = out.targetValue - input.heldValue;

  if (input.entry !== null && input.entry > 0 && input.fxToBase !== null && input.fxToBase > 0) {
    out.shares = Math.max(0, Math.floor(out.deltaValue / (input.entry * input.fxToBase)));
  } else {
    out.notes.push("Shares need a price and the exchange rate into your base currency; one of them is missing, so only the amount is given.");
  }
  if (out.deltaValue <= 0) out.notes.push("You already hold at least the size this plan asks for.");

  return out;
}
