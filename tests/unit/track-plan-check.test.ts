import { describe, expect, it } from "vitest";
import { PLAN_RULES } from "../../lib/decision/plan";
import type { OhlcvBar } from "../../lib/technicals";
import { PLAN_CHECK_RULES, planCheck, trialsOf, type PlanCheckSeries } from "../../lib/track/plan-check";

// Consecutive weekdays from Monday 2025-01-06.
function weekdays(n: number): string[] {
  const out: string[] = [];
  let t = Date.parse("2025-01-06T00:00:00Z");
  while (out.length < n) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

// A wandering stock: a slow wave with a ±1 daily range, so the average true
// range is a couple of points and plans have a real stop.
function bars(n: number, phase = 0): OhlcvBar[] {
  return weekdays(n).map((date, i) => {
    const close = 100 + 5 * Math.sin((i + phase) / 8) + i * 0.05;
    return { date, open: close - 0.3, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

const series = (ticker: string, n: number, phase = 0, splits: string[] = []): PlanCheckSeries => ({ ticker, bars: bars(n, phase), splits });

describe("trialsOf", () => {
  it("draws a plan every step sessions from the warm-up and walks each through the horizon", () => {
    const s = series("AAA", 200);
    const trials = trialsOf(s);
    // starts at 60, 80, ... while a full window still follows
    expect(trials.map((t) => t.date)).toEqual([60, 80, 100, 120, 140, 160].map((i) => s.bars[i].date));
    for (const t of trials) {
      expect(["market", "pullback"]).toContain(t.kind);
      expect(t.riskShare).toBeGreaterThan(0);
      expect(t.riskShare).toBeLessThan(0.2);
      expect(t.path.kind).toBe(t.kind);
    }
  });

  it("walks a market entry from the day it was drawn, and a pullback only if the stock trades down to it", () => {
    for (const t of trialsOf(series("AAA", 200))) {
      if (t.kind === "market") expect(t.path.filled).toBe(true);
      if (t.path.filled) expect(t.holdR).not.toBeNull();
      else expect(t.holdR).toBeNull();
    }
  });

  it("has nothing to draw from too little history", () => {
    expect(trialsOf(series("AAA", PLAN_CHECK_RULES.warmup + PLAN_CHECK_RULES.horizon))).toEqual([]);
    expect(trialsOf(series("AAA", PLAN_CHECK_RULES.warmup + PLAN_CHECK_RULES.horizon + 1))).toHaveLength(1);
  });

  it("leaves out a window with a split in it", () => {
    const s = series("AAA", 200);
    const withSplit = trialsOf({ ...s, splits: [s.bars[75].date] });
    expect(withSplit.map((t) => t.date)).toEqual([80, 100, 120, 140, 160].map((i) => s.bars[i].date));
  });

  it("leaves out a window with a hole in the stored prices", () => {
    const s = series("AAA", 200);
    // a quarter missing between session 70 and 71
    const shifted = s.bars.map((b, i) => (i > 70 ? { ...b, date: new Date(Date.parse(`${b.date}T00:00:00Z`) + 120 * 86_400_000).toISOString().slice(0, 10) } : b));
    const trials = trialsOf({ ...s, bars: shifted });
    expect(trials.some((t) => t.date === s.bars[60].date)).toBe(false);
    expect(trials.length).toBeGreaterThan(0);
  });
});

describe("planCheck", () => {
  it("is unmeasured, and says to fetch prices, when no stock has any", () => {
    const c = planCheck([]);
    expect(c.status).toBe("unmeasured");
    expect(c.reason).toContain("npm run fetch-prices");
    expect(c).toMatchObject({ tickers: 0, from: null, to: null, enough: false, medianRiskShare: null });
    expect(c.all.entries).toBe(0);
  });

  it("is unmeasured, and says how much history the longest stock has, when none is long enough", () => {
    const c = planCheck([series("AAA", 50), series("BBB", 30)]);
    expect(c.status).toBe("unmeasured");
    expect(c.reason).toContain(`${PLAN_CHECK_RULES.warmup + PLAN_CHECK_RULES.horizon + 1} sessions`);
    expect(c.reason).toContain("the longest has 50");
  });

  it("carries the plan's own rules so the page quotes what was tested", () => {
    const c = planCheck([series("AAA", 200)]);
    expect(c).toMatchObject({ horizon: 20, stopAtrs: PLAN_RULES.stopAtrs, rewardMultiples: PLAN_RULES.rewardMultiples });
  });

  it("pools the entries across stocks and splits them by kind of entry", () => {
    const c = planCheck([series("AAA", 200), series("BBB", 200, 5), series("CCC", 50)]);
    expect(c.status).toBe("measured");
    // two stocks long enough, six entries each; the short one adds none
    expect(c.tickers).toBe(2);
    expect(c.all.entries).toBe(12);
    expect(c.market.entries + c.pullback.entries).toBe(12);
    expect(c.all.filled).toBe(c.market.filled + c.pullback.filled);
    expect(c.all.stopped).toBe(c.market.stopped + c.pullback.stopped);
    expect(c.market.filled).toBe(c.market.entries);
    expect(c.pullback.filled).toBeLessThanOrEqual(c.pullback.entries);
  });

  it("reports the first and last entry dates and the stop's distance as a share of the price", () => {
    const a = series("AAA", 200);
    const c = planCheck([a]);
    expect(c.from).toBe(a.bars[60].date);
    expect(c.to).toBe(a.bars[160].date);
    expect(c.medianRiskShare).toBeGreaterThan(0);
    expect(c.medianRiskShare).toBeLessThan(0.2);
  });

  it("counts, of the filled entries, how many reached each reward level before any stop", () => {
    const c = planCheck([series("AAA", 400)]);
    expect(c.all.reached.map((r) => r.multiple)).toEqual([...PLAN_RULES.rewardMultiples]);
    // a higher level cannot be reached by more entries than a lower one
    const counts = c.all.reached.map((r) => r.count);
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2]);
    expect(counts[0]).toBeLessThanOrEqual(c.all.filled);
    expect(c.all.meanR).not.toBeNull();
    expect(c.all.meanHoldR).not.toBeNull();
  });

  it("reaches 'enough' only once the pooled entries reach the minimum", () => {
    expect(planCheck([series("AAA", 200)]).enough).toBe(false);
    const many = Array.from({ length: 6 }, (_, i) => series(`S${i}`, 200, i * 3));
    const c = planCheck(many);
    expect(c.all.entries).toBe(36);
    expect(c.enough).toBe(true);
  });
});
