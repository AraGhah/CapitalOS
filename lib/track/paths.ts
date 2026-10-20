/* ---------------------------------------------------------------------------
   What happened to a plan's entry, stop and reward levels in the sessions after
   it was drawn.

   lib/decision/plan.ts draws an entry, a stop two average true ranges below it
   and the prices at which a win equals 1.5, 2 and 3 times the risk. This walks
   those levels through the daily bars that followed and reports what was
   touched, so the plan can be judged by what the stock did and not by how it
   reads.

   Daily bars do not say what order a session's high and low came in, so every
   ambiguity is settled against the plan:

     - a stop and a reward level touched in the same session count as the stop;
     - a pullback entry that fills in a session is not credited with a reward
       level touched in that same session (the high may have come before the dip),
       but is stopped out if that session's low reached the stop;
     - a gap through the stop exits at the open, not at the stop.

   A pullback entry is a limit order: it fills only when a session trades down to
   it, at the open if the stock gaps below it. Fills are assumed to be possible
   at the bar's price, so a real fill can only be worse.

   Pure: bars in, a result out.
--------------------------------------------------------------------------- */

export interface PathBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

// The part of a stored trade plan the walk needs.
export interface PlanShape {
  entry: { price: number; kind: "market" | "pullback" };
  stop: number;
  riskPerShare: number;
  levels: Array<{ multiple: number; price: number }>;
}

export interface PathResult {
  kind: "market" | "pullback";
  filled: boolean;
  fillDate: string | null;
  fillPrice: number | null;
  stopped: boolean;
  stopDate: string | null;
  // the stop price (or the open, on a gap through it) when stopped, otherwise the close at the horizon
  exitPrice: number | null;
  exitKind: "stop" | "horizon" | null;
  // sessions from the decision's price date to the stop
  sessionsToStop: number | null;
  // profit or loss in units of the risk the plan took: (exit - fill) / riskPerShare
  r: number | null;
  // the reward multiples touched before any stop
  reached: number[];
  // a reward level and the stop were both touched in the session the stop was hit
  ambiguous: boolean;
}

const open = (b: PathBar) => b.open ?? b.close;
const high = (b: PathBar) => b.high ?? b.close;
const low = (b: PathBar) => b.low ?? b.close;

// Walks the sessions after bars[from] up to and including bars[to].
export function walkPlan(plan: PlanShape, bars: readonly PathBar[], from: number, to: number): PathResult {
  const result: PathResult = {
    kind: plan.entry.kind,
    filled: false,
    fillDate: null,
    fillPrice: null,
    stopped: false,
    stopDate: null,
    exitPrice: null,
    exitKind: null,
    sessionsToStop: null,
    r: null,
    reached: [],
    ambiguous: false,
  };
  const last = Math.min(to, bars.length - 1);

  // ---- the fill
  let first = from + 1;
  let fillSession = -1;
  if (plan.entry.kind === "market") {
    result.filled = true;
    result.fillDate = bars[from].date;
    result.fillPrice = plan.entry.price;
  } else {
    for (let k = from + 1; k <= last; k++) {
      if (low(bars[k]) <= plan.entry.price) {
        fillSession = k;
        result.filled = true;
        result.fillDate = bars[k].date;
        // a stock that opens below the limit fills at the open
        result.fillPrice = Math.min(open(bars[k]), plan.entry.price);
        first = k;
        break;
      }
    }
    if (!result.filled) return result;
  }

  const fill = result.fillPrice as number;
  const reached = new Set<number>();

  // ---- the walk
  for (let k = first; k <= last; k++) {
    const bar = bars[k];
    const gapped = open(bar) <= plan.stop;
    const stopHit = gapped || low(bar) <= plan.stop;
    // levels touched this session, unless it is the session the pullback filled in
    const touched = k === fillSession ? [] : plan.levels.filter((l) => high(bar) >= l.price).map((l) => l.multiple);

    if (stopHit) {
      result.stopped = true;
      result.stopDate = bar.date;
      result.sessionsToStop = k - from;
      result.exitKind = "stop";
      result.exitPrice = gapped ? open(bar) : plan.stop;
      result.ambiguous = touched.some((m) => !reached.has(m));
      break;
    }
    for (const m of touched) reached.add(m);
  }

  result.reached = [...reached].sort((a, b) => a - b);
  if (!result.stopped) {
    result.exitKind = "horizon";
    result.exitPrice = bars[last].close;
  }
  result.r = ((result.exitPrice as number) - fill) / plan.riskPerShare;
  return result;
}

// A stored plan, checked for the fields a walk needs. Plans recorded by older
// versions, or exits and no-plans, have none of them and are not walked.
export function planShapeOf(plan: unknown): PlanShape | null {
  const p = (plan ?? {}) as {
    side?: unknown;
    entry?: { price?: unknown; kind?: unknown } | null;
    stop?: { price?: unknown } | null;
    riskPerShare?: unknown;
    levels?: unknown;
  };
  if (p.side !== "enter") return null;
  const price = Number(p.entry?.price);
  const stop = Number(p.stop?.price);
  const risk = Number(p.riskPerShare);
  const kind = p.entry?.kind;
  if (!(price > 0) || !(stop > 0) || !(risk > 0) || (kind !== "market" && kind !== "pullback")) return null;
  if (!(stop < price)) return null;
  const levels = Array.isArray(p.levels)
    ? p.levels.flatMap((l: { multiple?: unknown; price?: unknown }) => (Number(l?.multiple) > 0 && Number(l?.price) > price ? [{ multiple: Number(l.multiple), price: Number(l.price) }] : []))
    : [];
  return { entry: { price, kind }, stop, riskPerShare: risk, levels };
}
