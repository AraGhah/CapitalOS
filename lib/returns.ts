/* ---------------------------------------------------------------------------
   Investment returns, the two standard ways.

   Time-weighted return (TWR) measures the investments: each day's return is
   computed with the day's external cash flow taken out, and the days are
   chained. Money put in or taken out does not move it. This is how a fund or
   a manager is compared with a benchmark.

   Money-weighted return (MWR, as an XIRR) measures the investor: the single
   annual rate at which every contribution and withdrawal, plus what is left
   today, discounts to zero. Putting more in just before a fall lowers it.

   Pure functions: no database, so both are tested against known answers.
--------------------------------------------------------------------------- */

export interface DayPoint {
  date: string; // YYYY-MM-DD
  // value at the end of the day, after the day's flow
  value: number;
  // external flow during the day: money in is positive, money out negative
  flow: number;
}

export interface TwrResult {
  cumulative: number;
  annualized: number | null;
  index: Array<{ date: string; value: number }>;
}

// A flow is taken as arriving at the end of the day, so the day's return is
// (V_t − F_t) / V_{t−1} − 1. A day that starts from nothing (the first
// deposit, or after everything was sold) has no return and only resets the base.
export function timeWeightedReturn(points: DayPoint[]): TwrResult {
  let growth = 1;
  const index: TwrResult["index"] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = i > 0 ? points[i - 1].value : 0;
    if (prev > 0) growth *= (p.value - p.flow) / prev;
    if (prev > 0 || p.value > 0) index.push({ date: p.date, value: growth * 100 });
  }
  const first = points.find((p) => p.value > 0);
  const last = points.at(-1);
  let annualized: number | null = null;
  if (first && last) {
    const years = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86_400_000);
    // A return over less than a year is not annualised: a 3% month is not a 42% year.
    if (years >= 1) annualized = growth ** (1 / years) - 1;
  }
  return { cumulative: growth - 1, annualized, index };
}

export interface Flow {
  date: string;
  // from the investor's side: money put in is negative, money received positive
  amount: number;
}

function npv(rate: number, flows: Flow[], t0: number): number {
  return flows.reduce((sum, f) => sum + f.amount / (1 + rate) ** ((Date.parse(f.date) - t0) / (365.25 * 86_400_000)), 0);
}

// The annual rate r with Σ amount / (1+r)^(years since the first flow) = 0,
// by bisection — slower than Newton's method and never diverges. Null when the
// flows do not change sign (nothing was ever put in, or nothing came back).
export function xirr(flows: Flow[]): number | null {
  const sorted = [...flows].filter((f) => f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.some((f) => f.amount < 0) || !sorted.some((f) => f.amount > 0)) return null;
  const t0 = Date.parse(sorted[0].date);

  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo, sorted, t0);
  // A large gain over a few weeks annualises to thousands of percent; the
  // bracket is widened until it holds the root.
  while (Math.sign(npv(hi, sorted, t0)) === Math.sign(fLo) && hi < 1e9) hi *= 10;
  if (Math.sign(npv(hi, sorted, t0)) === Math.sign(fLo)) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, sorted, t0);
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-12) return mid;
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}
