import type { Sentiment } from "../sentiment";

/* ---------------------------------------------------------------------------
   Did the labels line up with what the stock then did?

   FinGPT's news-and-returns dataset pairs headline sentiment with the price
   move that followed it. This is the same question asked of the desk's own
   headlines and prices: for the days a company's news read bullish, bearish or
   neither, what was the stock's return less the S&P 500's?

   - The unit is a company-day, not a headline, because a story is printed a
     dozen times and a dozen copies are one observation. A day reads bullish if
     it has more bullish headlines than bearish, bearish if more bearish, and
     neutral otherwise.
   - The day is the UTC date the headline was published. The entry is the close
     of the last session on or before that date, so the windows start after the
     close of the day the news appeared. They leave out most of the reaction to
     it, which is the point: a label that only agrees with the move that
     already happened is not telling you anything you could have used. The
     same-day column is shown beside them, for reading, not for use.
   - A window that spans a split, or a gap in the stored prices, is dropped.

   It measures; it does not forecast, and a label that "followed" returns once
   may not do it again. The intervals assume the observations are independent,
   which overlapping five-day windows and news that moves whole sectors at once
   make untrue, so they are narrower than they should be. With few headlines
   the study says so instead of reporting a number.
--------------------------------------------------------------------------- */

export const STUDY_RULES = {
  // sessions after the entry close
  horizons: [1, 5],
  // a group needs this many company-days before it is compared
  minPerGroup: 30,
  // the bullish-minus-bearish spread must be this many standard errors from zero
  z: 2,
  // a window may span this many calendar days per session before it is called a gap in the data
  gapDaysPerSession: 4,
} as const;

export interface Close {
  date: string;
  close: number;
}

export interface TaggedHeadline {
  companyId: string;
  // the UTC date it was published, YYYY-MM-DD
  date: string;
  label: Sentiment;
}

export interface StudyInput {
  headlines: TaggedHeadline[];
  // each company's closes, oldest first
  bars: Map<string, Close[]>;
  // the S&P 500's closes, oldest first
  market: Close[] | null;
  // each company's split dates
  splits: Map<string, string[]>;
}

export interface Group {
  n: number;
  // mean return less the market's
  mean: number | null;
  // standard error of that mean
  se: number | null;
  // the share of company-days whose abnormal return was above zero
  positive: number | null;
}

export type Verdict = "not_enough" | "followed" | "reversed" | "no_difference";

export interface Window {
  key: "sameDay" | "d1" | "d5";
  label: string;
  // the same-day window is concurrent with the news, so it is shown but never read as a test
  concurrent: boolean;
  groups: Record<Sentiment, Group>;
  // bullish minus bearish
  spread: { value: number; se: number; z: number } | null;
  verdict: Verdict;
  // what is missing, when there is not enough to compare
  note: string | null;
}

export interface StudyResult {
  status: "measured" | "unmeasured";
  reason: string | null;
  // company-days with a label and prices, and the companies and dates they span
  days: number;
  companies: number;
  from: string | null;
  to: string | null;
  windows: Window[];
}

/* ------------------------------------------------------------------ the days */

export function dayLabels(headlines: TaggedHeadline[]): Array<{ companyId: string; date: string; label: Sentiment }> {
  const net = new Map<string, { companyId: string; date: string; net: number }>();
  for (const h of headlines) {
    const key = `${h.companyId}|${h.date}`;
    const day = net.get(key) ?? { companyId: h.companyId, date: h.date, net: 0 };
    day.net += h.label === "bullish" ? 1 : h.label === "bearish" ? -1 : 0;
    net.set(key, day);
  }
  return [...net.values()].map((d) => ({ companyId: d.companyId, date: d.date, label: d.net > 0 ? "bullish" : d.net < 0 ? "bearish" : "neutral" }));
}

// The last bar on or before a date, or -1.
export function indexOnOrBefore(bars: Close[], date: string): number {
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

const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/* ------------------------------------------------------------------ the maths */

export function groupOf(values: number[]): Group {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, se: null, positive: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, se: n > 1 ? Math.sqrt(variance / n) : null, positive: values.filter((v) => v > 0).length / n };
}

export function windowOf(
  key: Window["key"],
  label: string,
  concurrent: boolean,
  samples: Record<Sentiment, number[]>
): Window {
  const groups: Record<Sentiment, Group> = { bullish: groupOf(samples.bullish), neutral: groupOf(samples.neutral), bearish: groupOf(samples.bearish) };
  const { bullish, bearish } = groups;
  const { minPerGroup, z: bar } = STUDY_RULES;

  let spread: Window["spread"] = null;
  if (bullish.mean !== null && bearish.mean !== null && bullish.se !== null && bearish.se !== null) {
    const value = bullish.mean - bearish.mean;
    const se = Math.sqrt(bullish.se ** 2 + bearish.se ** 2);
    spread = { value, se, z: se === 0 ? 0 : value / se };
  }

  if (bullish.n < minPerGroup || bearish.n < minPerGroup || spread === null) {
    const short = [bullish.n < minPerGroup ? `${minPerGroup - bullish.n} more bullish days` : null, bearish.n < minPerGroup ? `${minPerGroup - bearish.n} more bearish days` : null]
      .filter(Boolean)
      .join(" and ");
    return { key, label, concurrent, groups, spread, verdict: "not_enough", note: short ? `needs ${short} before the two can be compared` : "too few observations to compare" };
  }
  const verdict: Verdict = spread.z >= bar ? "followed" : spread.z <= -bar ? "reversed" : "no_difference";
  return { key, label, concurrent, groups, spread, verdict, note: null };
}

/* ------------------------------------------------------------------ the study */

export function studyOf(input: StudyInput): StudyResult {
  const empty = (reason: string): StudyResult => ({ status: "unmeasured", reason, days: 0, companies: 0, from: null, to: null, windows: [] });
  if (input.headlines.length === 0) return empty("no headline has a label yet; run a research page's pipeline (the Run the desk button) to gather and label some");
  if (!input.market || input.market.length < 2) return empty("the S&P 500 benchmark has no stored prices; run npm run fetch-prices");

  const marketAt = new Map(input.market.map((b) => [b.date, b.close]));
  const days = dayLabels(input.headlines);

  const same: Record<Sentiment, number[]> = { bullish: [], neutral: [], bearish: [] };
  const ahead = new Map<number, Record<Sentiment, number[]>>(STUDY_RULES.horizons.map((h) => [h, { bullish: [], neutral: [], bearish: [] }]));
  const covered = new Set<string>();
  let used = 0;
  let from: string | null = null;
  let to: string | null = null;

  // abnormal return between two bars, or null when the market, a split or a gap in the data forbids it
  const between = (companyId: string, bars: Close[], a: number, b: number, sessions: number): number | null => {
    const start = bars[a];
    const end = bars[b];
    if (daysBetween(start.date, end.date) > sessions * STUDY_RULES.gapDaysPerSession) return null;
    if ((input.splits.get(companyId) ?? []).some((s) => s > start.date && s <= end.date)) return null;
    const m0 = marketAt.get(start.date);
    const m1 = marketAt.get(end.date);
    if (m0 === undefined || m1 === undefined) return null;
    return end.close / start.close - 1 - (m1 / m0 - 1);
  };

  for (const day of days) {
    const bars = input.bars.get(day.companyId);
    if (!bars || bars.length < 2) continue;
    const at = indexOnOrBefore(bars, day.date);
    if (at < 0) continue;

    let counted = false;
    if (bars[at].date === day.date && at > 0) {
      const r = between(day.companyId, bars, at - 1, at, 1);
      if (r !== null) {
        same[day.label].push(r);
        counted = true;
      }
    }
    for (const h of STUDY_RULES.horizons) {
      if (at + h >= bars.length) continue;
      const r = between(day.companyId, bars, at, at + h, h);
      if (r !== null) {
        ahead.get(h)![day.label].push(r);
        counted = true;
      }
    }
    if (counted) {
      used += 1;
      covered.add(day.companyId);
      if (from === null || day.date < from) from = day.date;
      if (to === null || day.date > to) to = day.date;
    }
  }

  if (used === 0) return empty("none of the labelled days has stored prices around it; run npm run fetch-prices");

  const windows: Window[] = [
    windowOf("sameDay", "Same day (concurrent with the news)", true, same),
    ...STUDY_RULES.horizons.map((h) => windowOf(h === 1 ? "d1" : "d5", `Next ${h === 1 ? "session" : `${h} sessions`} after that day's close`, false, ahead.get(h)!)),
  ];
  return { status: "measured", reason: null, days: used, companies: covered.size, from, to, windows };
}
