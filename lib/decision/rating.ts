import type { Confidence } from "../ai/consensus";
import type { DimensionKey } from "../ai/roster";

/* ---------------------------------------------------------------------------
   The Research Manager: the committee's eight dimension scores turned into one
   of five ratings.

   TradingAgents has a model write this judgement. Here it is arithmetic, so the
   same committee report always gives the same rating and the page can show the
   sum: a weighted mean of the dimensions the committee resolved, mapped onto
   buy / overweight / hold / underweight / sell, then held back by the things a
   mean hides — thin conviction, a fragile balance sheet, a price the committee
   called expensive, figures the checker could not find.

   Pure: the report's numbers go in, a rating and every step that shaped it
   come out. No model, no database, no clock.
--------------------------------------------------------------------------- */

export type DecisionRating = "buy" | "overweight" | "hold" | "underweight" | "sell";

// Worst to best, so a rating's index minus 2 is its place on the -2..+2 scale.
export const RATINGS: readonly DecisionRating[] = ["sell", "underweight", "hold", "overweight", "buy"];

export const RATING_LABEL: Record<DecisionRating, string> = {
  buy: "Buy",
  overweight: "Overweight",
  hold: "Hold",
  underweight: "Underweight",
  sell: "Sell",
};

// What each rating asks of a long-only investor.
export const RATING_MEANING: Record<DecisionRating, string> = {
  buy: "open or build a full position",
  overweight: "open or add, at half the size a buy would get",
  hold: "keep what you own; no new money",
  underweight: "cut what you own by half",
  sell: "exit the position",
};

// Valuation counts a little more than the rest (what you pay decides the
// return); news flow and the macro backdrop count half, because they move
// faster than the business does.
export const WEIGHTS: Record<DimensionKey, number> = {
  business_quality: 1,
  growth: 1,
  profitability: 1,
  balance_sheet: 1,
  valuation: 1.25,
  competitive_position: 1,
  news_flow: 0.5,
  macro: 0.5,
};

export const RATING_RULES = {
  // composite score cut-offs on the committee's -2..+2 scale
  buy: 1,
  overweight: 0.4,
  underweight: -0.4,
  sell: -1,
  // the share of the total weight that must be scored before a rating is given
  minWeightShare: 0.6,
  // a dimension at or below this resolved score is "weak" (see ratingOf in consensus.ts)
  weakAt: -1.25,
} as const;

export interface RatingDimension {
  key: DimensionKey;
  label: string;
  // the judge's score when there was one, otherwise the seats' mean
  resolved: number | null;
  contested: boolean;
}

export interface RatingInput {
  dimensions: RatingDimension[];
  confidence: { score: number; label: Confidence["label"] };
  // figures in the committee's conclusion that the checker never found
  unverifiedFigures: string[];
}

export interface RatingStep {
  rule: string;
  from: DecisionRating;
  to: DecisionRating;
  reason: string;
}

export interface Contribution {
  key: DimensionKey;
  label: string;
  resolved: number | null;
  weight: number;
  contested: boolean;
}

export interface RatingResult {
  // weighted mean of the scored dimensions; null when none was scored
  composite: number | null;
  // the share of the total weight that was scored
  weightShare: number;
  contributions: Contribution[];
  // the rating the composite alone gives
  raw: DecisionRating;
  final: DecisionRating;
  steps: RatingStep[];
}

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);

const place = (r: DecisionRating) => RATINGS.indexOf(r) - 2;
const fromPlace = (n: number): DecisionRating => RATINGS[Math.max(0, Math.min(4, n + 2))];

export function ratingOfComposite(composite: number): DecisionRating {
  if (composite >= RATING_RULES.buy) return "buy";
  if (composite >= RATING_RULES.overweight) return "overweight";
  if (composite > RATING_RULES.underweight) return "hold";
  if (composite > RATING_RULES.sell) return "underweight";
  return "sell";
}

export function compositeOf(dimensions: RatingDimension[]): { composite: number | null; weightShare: number; contributions: Contribution[] } {
  const contributions = dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    resolved: d.resolved,
    weight: WEIGHTS[d.key] ?? 0,
    contested: d.contested,
  }));
  const scored = contributions.filter((c) => c.resolved !== null && c.weight > 0);
  const weight = scored.reduce((s, c) => s + c.weight, 0);
  const composite = weight > 0 ? scored.reduce((s, c) => s + (c.resolved as number) * c.weight, 0) / weight : null;
  return { composite, weightShare: weight / TOTAL_WEIGHT, contributions };
}

// Holds a rating inside [lowest, highest] and records the step if it moved.
function clamp(
  steps: RatingStep[],
  current: DecisionRating,
  bounds: { lowest?: DecisionRating; highest?: DecisionRating },
  rule: string,
  reason: string
): DecisionRating {
  const lo = bounds.lowest ? place(bounds.lowest) : -2;
  const hi = bounds.highest ? place(bounds.highest) : 2;
  const next = fromPlace(Math.max(lo, Math.min(hi, place(current))));
  if (next !== current) steps.push({ rule, from: current, to: next, reason });
  return next;
}

export function rate(input: RatingInput): RatingResult {
  const { composite, weightShare, contributions } = compositeOf(input.dimensions);
  const steps: RatingStep[] = [];

  if (composite === null || weightShare < RATING_RULES.minWeightShare) {
    const scored = contributions.filter((c) => c.resolved !== null).length;
    const raw = composite === null ? "hold" : ratingOfComposite(composite);
    if (raw !== "hold") {
      steps.push({
        rule: "coverage",
        from: raw,
        to: "hold",
        reason: `Only ${scored} of ${contributions.length} dimensions were scored (${Math.round(weightShare * 100)}% of the weight, ${Math.round(RATING_RULES.minWeightShare * 100)}% needed), too few to rate beyond hold.`,
      });
    }
    return { composite, weightShare, contributions, raw, final: "hold", steps };
  }

  const raw = ratingOfComposite(composite);
  let current = raw;

  // Conviction. A committee that is unsure, or that checked little, does not
  // get to call an extreme: one tier either way at medium confidence, none at low.
  const { label, score } = input.confidence;
  if (label === "Low") {
    current = clamp(steps, current, { lowest: "hold", highest: "hold" }, "confidence", `Committee confidence is Low (${Math.round(score * 100)}%); a rating other than hold needs more than that.`);
  } else if (label === "Medium") {
    current = clamp(steps, current, { lowest: "underweight", highest: "overweight" }, "confidence", `Committee confidence is Medium (${Math.round(score * 100)}%); buy and sell need Medium-high or better.`);
  }

  const dim = (key: DimensionKey) => input.dimensions.find((d) => d.key === key);

  const sheet = dim("balance_sheet");
  if (sheet && sheet.resolved !== null && sheet.resolved <= RATING_RULES.weakAt) {
    current = clamp(steps, current, { highest: "hold" }, "balance sheet", `The balance sheet scored ${sheet.resolved.toFixed(2)} (fragile): no new money however the rest looks.`);
  }

  const valuation = dim("valuation");
  if (valuation && valuation.resolved !== null && valuation.resolved <= RATING_RULES.weakAt) {
    current = clamp(steps, current, { highest: "overweight" }, "valuation", `Valuation scored ${valuation.resolved.toFixed(2)} (expensive): not a full-size buy at this price.`);
  } else if (valuation?.contested) {
    current = clamp(steps, current, { highest: "overweight" }, "valuation", "The committee could not agree on valuation: not a full-size buy while the price is disputed.");
  }

  if (input.unverifiedFigures.length > 0) {
    current = clamp(
      steps,
      current,
      { highest: "overweight" },
      "unverified figures",
      `${input.unverifiedFigures.length} ${input.unverifiedFigures.length === 1 ? "figure" : "figures"} in the conclusion could not be found in the evidence (${input.unverifiedFigures.slice(0, 3).join(", ")}).`
    );
  }

  return { composite, weightShare, contributions, raw, final: current, steps };
}
