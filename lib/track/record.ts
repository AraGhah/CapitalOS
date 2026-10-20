import type { DecisionRating } from "../decision/rating";
import { PLAN_RULES } from "../decision/plan";
import { mean, median, standardError, wilson } from "../stats";
import { reflect, type StoredDecision } from "./reflect";
import { DIRECTION, SETTLE_RULES, type Direction, type Outcome } from "./settle";

/* ---------------------------------------------------------------------------
   The desk's track record: how its recorded decisions have done.

   FinGPT-Forecaster and TradingAgents both show a model's calls beside what
   happened. This is that for the calls this desk's rules made, in three parts:

     calls    every recorded decision with the outcomes it has so far and the
              sentences the stored record supports (reflect.ts);
     hit rate for each horizon, the share of Buy/Overweight calls that beat the
              market and of Underweight/Sell calls that trailed it, with a 95%
              interval, because a handful of calls cannot tell skill from luck;
     plan     of the entries that filled, how many were stopped out and how many
              reached each reward level first.

   Only graded outcomes count towards a hit rate. A call inside the flat band is
   not a hit and not a miss, and is left out of the rate, so a rating cannot
   score by being too close to call. The verdict compares the rate with a coin
   toss, which is what a rating with no skill would score against the market;
   below RECORD_RULES.minDecided decided calls it declines to compare at all.

   The intervals assume the calls are independent. Calls made on the same days,
   in the same sector, in one kind of market are not, so they are narrower than
   they should be, and a record built in a rising market says little about a
   falling one. It measures the past and is not a forecast.

   Pure: calls in, a record out.
--------------------------------------------------------------------------- */

export const RECORD_RULES = {
  // decided (right or wrong) calls a group needs before its rate is compared with a coin toss
  minDecided: 10,
  // how many calls the record lists
  listed: 25,
} as const;

export interface RecordedCall {
  id: string;
  ticker: string;
  createdAt: string;
  asOf: string | null;
  rating: DecisionRating;
  action: string;
  refPrice: number | null;
  headline: string;
  decision: StoredDecision;
  outcomes: Outcome[];
}

export type RateVerdict = "better" | "worse" | "no_different" | "not_enough";

export interface GroupStat {
  // graded outcomes: right, wrong and flat
  n: number;
  right: number;
  wrong: number;
  flat: number;
  decided: number;
  hitRate: number | null;
  interval: [number, number] | null;
  // mean return less the market's, whatever the direction of the call
  meanAlpha: number | null;
  // that, signed by the call: positive when following the rating beat the market
  meanEdge: number | null;
  edgeSe: number | null;
  verdict: RateVerdict;
}

export interface HorizonRecord {
  horizon: number;
  bullish: GroupStat;
  bearish: GroupStat;
  hold: { n: number; meanAlpha: number | null };
  all: { n: number; meanAlpha: number | null };
}

export interface PlanRecord {
  horizon: number;
  entries: number;
  filled: number;
  stopped: number;
  // of the filled entries, how many touched each reward level before any stop
  reached: Array<{ multiple: number; count: number }>;
  meanR: number | null;
  medianR: number | null;
}

export interface CallView {
  id: string;
  ticker: string;
  createdAt: string;
  asOf: string | null;
  rating: DecisionRating;
  action: string;
  headline: string;
  outcomes: Outcome[];
  // horizons that have not closed yet
  waiting: number[];
  reflection: string[];
}

export interface TrackRecord {
  decisions: number;
  // decisions with at least one outcome row, excluded ones included
  withOutcome: number;
  awaiting: number;
  // outcome rows that were excluded as not fairly measurable
  excluded: number;
  horizons: HorizonRecord[];
  plan: PlanRecord[];
  calls: CallView[];
}

const graded = (o: Outcome) => o.verdict === "right" || o.verdict === "wrong" || o.verdict === "flat";

export function groupStat(outcomes: Outcome[], direction: Exclude<Direction, "none">): GroupStat {
  const g = outcomes.filter(graded);
  const right = g.filter((o) => o.verdict === "right").length;
  const wrong = g.filter((o) => o.verdict === "wrong").length;
  const flat = g.length - right - wrong;
  const decided = right + wrong;
  const sign = direction === "bullish" ? 1 : -1;
  const alphas = g.map((o) => o.alpha as number);
  const edges = alphas.map((a) => a * sign);

  const interval = decided === 0 ? null : wilson(right, decided);
  let verdict: RateVerdict = "not_enough";
  if (interval && decided >= RECORD_RULES.minDecided) verdict = interval[0] > 0.5 ? "better" : interval[1] < 0.5 ? "worse" : "no_different";

  return {
    n: g.length,
    right,
    wrong,
    flat,
    decided,
    hitRate: decided === 0 ? null : right / decided,
    interval,
    meanAlpha: mean(alphas),
    meanEdge: mean(edges),
    edgeSe: standardError(edges),
    verdict,
  };
}

function horizonRecord(calls: RecordedCall[], horizon: number): HorizonRecord {
  const at = (direction: Direction) =>
    calls.filter((c) => DIRECTION[c.rating] === direction).flatMap((c) => c.outcomes.filter((o) => o.horizon === horizon));
  const hold = at("none").filter((o) => o.verdict === "no_claim");
  const every = calls.flatMap((c) => c.outcomes.filter((o) => o.horizon === horizon && o.alpha !== null));
  return {
    horizon,
    bullish: groupStat(at("bullish"), "bullish"),
    bearish: groupStat(at("bearish"), "bearish"),
    hold: { n: hold.length, meanAlpha: mean(hold.map((o) => o.alpha as number)) },
    all: { n: every.length, meanAlpha: mean(every.map((o) => o.alpha as number)) },
  };
}

export function planRecord(paths: Array<NonNullable<Outcome["path"]>>, horizon: number): PlanRecord {
  const filled = paths.filter((p) => p.filled);
  const rs = filled.flatMap((p) => (p.r === null ? [] : [p.r]));
  return {
    horizon,
    entries: paths.length,
    filled: filled.length,
    stopped: filled.filter((p) => p.stopped).length,
    reached: PLAN_RULES.rewardMultiples.map((multiple) => ({ multiple, count: filled.filter((p) => p.reached.includes(multiple)).length })),
    meanR: mean(rs),
    medianR: median(rs),
  };
}

export function trackRecord(calls: RecordedCall[], opts: { listed?: number } = {}): TrackRecord {
  const horizons = [...SETTLE_RULES.horizons];
  const sorted = [...calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const withOutcome = calls.filter((c) => c.outcomes.length > 0).length;

  return {
    decisions: calls.length,
    withOutcome,
    awaiting: calls.length - withOutcome,
    excluded: calls.reduce((n, c) => n + c.outcomes.filter((o) => o.verdict === "excluded").length, 0),
    horizons: horizons.map((h) => horizonRecord(calls, h)),
    plan: horizons.map((h) =>
      planRecord(
        calls.flatMap((c) => c.outcomes.filter((o) => o.horizon === h && o.path !== null).map((o) => o.path as NonNullable<Outcome["path"]>)),
        h
      )
    ),
    calls: sorted.slice(0, opts.listed ?? RECORD_RULES.listed).map((c) => ({
      id: c.id,
      ticker: c.ticker,
      createdAt: c.createdAt,
      asOf: c.asOf,
      rating: c.rating,
      action: c.action,
      headline: c.headline,
      outcomes: [...c.outcomes].sort((a, b) => a.horizon - b.horizon),
      waiting: horizons.filter((h) => !c.outcomes.some((o) => o.horizon === h)),
      reflection: reflect({ rating: c.rating, asOf: c.asOf, refPrice: c.refPrice, decision: c.decision, outcomes: c.outcomes }),
    })),
  };
}
