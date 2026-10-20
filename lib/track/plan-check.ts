import { PLAN_RULES, tradePlan } from "../decision/plan";
import { mean, median } from "../stats";
import { technicalSnapshot, type OhlcvBar } from "../technicals";
import { planShapeOf, walkPlan, type PathResult } from "./paths";
import { planRecord, type PlanRecord } from "./record";
import { SETTLE_RULES } from "./settle";

/* ---------------------------------------------------------------------------
   Is the plan's arithmetic sensible on the stocks this desk follows?

   Recorded decisions are few and take months to settle, so they cannot yet say
   whether a stop two average true ranges below the entry is too tight, or how
   often a 1.5 times reward is reached before the stop. Stored price history
   can. For each stock, every PLAN_CHECK_RULES.step sessions this draws the plan
   the Trader would have drawn from the bars up to that day (the same
   tradePlan, on the same technical snapshot) and walks it forward through the
   next PLAN_CHECK_RULES.horizon sessions (paths.ts).

   It tests the stop and the reward levels, not the committee: there is no
   rating behind these entries, only the plan's own rules, applied on a fixed
   calendar so nothing is picked for having worked. A stop that is touched
   within a month in most entries is a stop that says "the market breathed", and
   the plan's own notes say that is what it is meant not to do.

   The starts are spaced by the horizon so no entry's window overlaps the next
   one's on the same stock, but stocks move together, so the pooled entries are
   fewer independent observations than they look. Windows that span a split are
   left out. This describes the past on these stocks; it is not a forecast.

   Pure: stored bars in, a check out.
--------------------------------------------------------------------------- */

export const PLAN_CHECK_RULES = {
  horizon: SETTLE_RULES.primaryHorizon,
  // sessions of history before the first entry, so the indicators have something to read
  warmup: 60,
  // sessions between one entry and the next on the same stock
  step: SETTLE_RULES.primaryHorizon,
  // sessions of history a snapshot reads
  lookback: 260,
  // pooled entries before the shares are offered as a reading
  minEntries: 30,
} as const;

export interface PlanCheckSeries {
  ticker: string;
  // oldest first
  bars: OhlcvBar[];
  splits: string[];
}

export interface PlanGroup extends Omit<PlanRecord, "horizon"> {
  // the same entries held to the horizon with no stop, in units of the risk the plan took
  meanHoldR: number | null;
}

export interface PlanCheck {
  status: "measured" | "unmeasured";
  reason: string | null;
  horizon: number;
  stopAtrs: number;
  rewardMultiples: readonly number[];
  tickers: number;
  from: string | null;
  to: string | null;
  all: PlanGroup;
  market: PlanGroup;
  pullback: PlanGroup;
  // the stop's distance as a share of the entry price
  medianRiskShare: number | null;
  // true once the pooled entries reach PLAN_CHECK_RULES.minEntries
  enough: boolean;
}

interface Trial {
  kind: "market" | "pullback";
  date: string;
  path: PathResult;
  riskShare: number;
  holdR: number | null;
}

const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export function trialsOf(series: PlanCheckSeries): Trial[] {
  const { bars, splits } = series;
  const { horizon, warmup, step, lookback } = PLAN_CHECK_RULES;
  const out: Trial[] = [];

  for (let i = warmup; i + horizon < bars.length; i += step) {
    const entryDate = bars[i].date;
    const exitDate = bars[i + horizon].date;
    if (daysBetween(entryDate, exitDate) > horizon * SETTLE_RULES.gapDaysPerSession) continue;
    if (splits.some((s) => s > entryDate && s <= exitDate)) continue;

    const snapshot = technicalSnapshot(bars.slice(Math.max(0, i - lookback + 1), i + 1));
    const plan = tradePlan({ side: "enter", snapshot, last: bars[i].close });
    const shape = planShapeOf(plan);
    if (!shape || plan.riskShare === null) continue;

    const path = walkPlan(shape, bars, i, i + horizon);
    out.push({
      kind: shape.entry.kind,
      date: entryDate,
      path,
      riskShare: plan.riskShare,
      holdR: path.filled && path.fillPrice !== null ? (bars[i + horizon].close - path.fillPrice) / shape.riskPerShare : null,
    });
  }
  return out;
}

function groupOf(trials: Trial[]): PlanGroup {
  const record = planRecord(
    trials.map((t) => t.path),
    PLAN_CHECK_RULES.horizon
  );
  return { entries: record.entries, filled: record.filled, stopped: record.stopped, reached: record.reached, meanR: record.meanR, medianR: record.medianR, meanHoldR: mean(trials.flatMap((t) => (t.holdR === null ? [] : [t.holdR]))) };
}

export function planCheck(series: PlanCheckSeries[]): PlanCheck {
  const perStock = series.map(trialsOf);
  const trials = perStock.flat();
  const base = {
    horizon: PLAN_CHECK_RULES.horizon,
    stopAtrs: PLAN_RULES.stopAtrs,
    rewardMultiples: PLAN_RULES.rewardMultiples,
  };

  if (trials.length === 0) {
    const empty = groupOf([]);
    const longest = Math.max(0, ...series.map((s) => s.bars.length));
    return {
      status: "unmeasured",
      reason:
        series.length === 0
          ? "no stock has stored prices; run npm run fetch-prices (RANGE=5y gives it more history to work with)"
          : `no stock has the ${PLAN_CHECK_RULES.warmup + PLAN_CHECK_RULES.horizon + 1} sessions of stored prices a plan and its ${PLAN_CHECK_RULES.horizon}-session window need (the longest has ${longest}); run npm run fetch-prices with RANGE=5y`,
      ...base,
      tickers: 0,
      from: null,
      to: null,
      all: empty,
      market: empty,
      pullback: empty,
      medianRiskShare: null,
      enough: false,
    };
  }

  const dates = trials.map((t) => t.date).sort();
  return {
    status: "measured",
    reason: null,
    ...base,
    tickers: perStock.filter((t) => t.length > 0).length,
    from: dates[0],
    to: dates.at(-1) ?? null,
    all: groupOf(trials),
    market: groupOf(trials.filter((t) => t.kind === "market")),
    pullback: groupOf(trials.filter((t) => t.kind === "pullback")),
    medianRiskShare: median(trials.map((t) => t.riskShare)),
    enough: trials.length >= PLAN_CHECK_RULES.minEntries,
  };
}
