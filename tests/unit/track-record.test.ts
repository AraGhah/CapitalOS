import { describe, expect, it } from "vitest";
import type { DecisionRating } from "../../lib/decision/rating";
import type { PathResult } from "../../lib/track/paths";
import { outcomeLine, reflect } from "../../lib/track/reflect";
import { RECORD_RULES, groupStat, planRecord, trackRecord, type RecordedCall } from "../../lib/track/record";
import type { Outcome, Verdict } from "../../lib/track/settle";
import { mean, median, standardError, wilson } from "../../lib/stats";

/* ------------------------------------------------------------------ the statistics */

describe("the shared statistics", () => {
  it("gives the Wilson interval of a share, inside 0..1 even at the extremes", () => {
    expect(wilson(0, 0)).toEqual([0, 0]);
    const [lo, hi] = wilson(12, 12);
    expect(lo).toBeCloseTo(0.7575, 3);
    expect(hi).toBeCloseTo(1, 10);
    const [lo2, hi2] = wilson(0, 12);
    expect(lo2).toBeCloseTo(0, 10);
    expect(hi2).toBeCloseTo(0.2425, 3);
    const [lo3, hi3] = wilson(6, 12);
    expect(lo3).toBeLessThan(0.5);
    expect(hi3).toBeGreaterThan(0.5);
  });

  it("takes means, medians and the standard error of the mean", () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(standardError([1])).toBeNull();
    // values 1,2,3: variance 1, n 3
    expect(standardError([1, 2, 3])).toBeCloseTo(Math.sqrt(1 / 3), 10);
  });
});

/* ------------------------------------------------------------------ fixtures */

const outcome = (verdict: Verdict, alpha: number | null, over: Partial<Outcome> = {}): Outcome => ({
  horizon: 20,
  verdict,
  reason: verdict === "excluded" ? "a split fell in the window" : null,
  entryDate: verdict === "excluded" ? null : "2026-01-05",
  entryClose: verdict === "excluded" ? null : 100,
  exitDate: verdict === "excluded" ? null : "2026-02-02",
  exitClose: verdict === "excluded" ? null : 100 * (1 + (alpha ?? 0)),
  stockReturn: alpha,
  marketReturn: alpha === null ? null : 0,
  alpha,
  path: null,
  ...over,
});

const path = (over: Partial<PathResult> = {}): PathResult => ({
  kind: "market",
  filled: true,
  fillDate: "2026-01-05",
  fillPrice: 100,
  stopped: false,
  stopDate: null,
  exitPrice: 104,
  exitKind: "horizon",
  sessionsToStop: null,
  r: 0.8,
  reached: [],
  ambiguous: false,
  ...over,
});

let seq = 0;
const call = (rating: DecisionRating, outcomes: Outcome[], over: Partial<RecordedCall> = {}): RecordedCall => ({
  id: `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`,
  ticker: "AAA",
  createdAt: `2026-01-${String(5 + (seq % 20)).padStart(2, "0")}T12:00:00.000Z`,
  asOf: "2026-01-05",
  rating,
  action: rating === "buy" ? "buy" : "hold",
  refPrice: 100,
  headline: `${rating} on AAA`,
  decision: {},
  outcomes,
  ...over,
});

const many = (verdict: Verdict, alpha: number, n: number) => Array.from({ length: n }, () => outcome(verdict, alpha));

/* ------------------------------------------------------------------ hit rates */

describe("groupStat", () => {
  it("has nothing to say about no calls", () => {
    expect(groupStat([], "bullish")).toEqual({
      n: 0, right: 0, wrong: 0, flat: 0, decided: 0, hitRate: null, interval: null, meanAlpha: null, meanEdge: null, edgeSe: null, verdict: "not_enough",
    });
  });

  it("declines to compare with a coin toss below the minimum of decided calls, however well they did", () => {
    const g = groupStat(many("right", 0.05, RECORD_RULES.minDecided - 1), "bullish");
    expect(g).toMatchObject({ decided: 9, hitRate: 1, verdict: "not_enough" });
  });

  it("says better than a coin toss only when the whole interval is above one half", () => {
    const g = groupStat(many("right", 0.05, 12), "bullish");
    expect(g.hitRate).toBe(1);
    expect(g.interval![0]).toBeCloseTo(wilson(12, 12)[0], 10);
    expect(g.verdict).toBe("better");
  });

  it("says worse when the whole interval is below one half", () => {
    const g = groupStat([...many("right", 0.05, 1), ...many("wrong", -0.05, 11)], "bullish");
    expect(g.hitRate).toBeCloseTo(1 / 12, 10);
    expect(g.verdict).toBe("worse");
  });

  it("says no different when the interval straddles one half", () => {
    const g = groupStat([...many("right", 0.05, 6), ...many("wrong", -0.05, 6)], "bullish");
    expect(g).toMatchObject({ right: 6, wrong: 6, hitRate: 0.5, verdict: "no_different" });
  });

  it("leaves flat calls out of the rate but keeps them in the count", () => {
    const g = groupStat([...many("right", 0.05, 3), ...many("wrong", -0.05, 1), ...many("flat", 0.001, 4)], "bullish");
    expect(g).toMatchObject({ n: 8, right: 3, wrong: 1, flat: 4, decided: 4, hitRate: 0.75 });
  });

  it("does not count a hold or an excluded outcome as graded at all", () => {
    const g = groupStat([outcome("no_claim", 0.2), outcome("excluded", null), outcome("right", 0.05)], "bullish");
    expect(g).toMatchObject({ n: 1, right: 1, decided: 1 });
  });

  it("signs the edge by the call: a bearish call that trailed the market has a positive edge", () => {
    const g = groupStat([outcome("right", -0.04), outcome("right", -0.06)], "bearish");
    expect(g.meanAlpha).toBeCloseTo(-0.05, 10);
    expect(g.meanEdge).toBeCloseTo(0.05, 10);
    expect(g.edgeSe).toBeCloseTo(standardError([0.04, 0.06])!, 10);
    expect(groupStat([outcome("right", 0.04)], "bullish").edgeSe).toBeNull();
  });
});

/* ------------------------------------------------------------------ the plan */

describe("planRecord", () => {
  it("counts fills, stops and the reward levels reached first, and the R of the filled entries", () => {
    const r = planRecord(
      [
        path({ stopped: true, exitKind: "stop", r: -1 }),
        path({ reached: [1.5], r: 1.5 }),
        path({ reached: [1.5, 2], r: 2 }),
        path({ filled: false, fillDate: null, fillPrice: null, r: null, exitKind: null, exitPrice: null, kind: "pullback" }),
      ],
      20
    );
    expect(r).toMatchObject({ horizon: 20, entries: 4, filled: 3, stopped: 1 });
    expect(r.reached).toEqual([
      { multiple: 1.5, count: 2 },
      { multiple: 2, count: 1 },
      { multiple: 3, count: 0 },
    ]);
    expect(r.meanR).toBeCloseTo((-1 + 1.5 + 2) / 3, 10);
    expect(r.medianR).toBe(1.5);
  });

  it("has no mean or median for no entries", () => {
    expect(planRecord([], 20)).toMatchObject({ entries: 0, filled: 0, stopped: 0, meanR: null, medianR: null });
  });
});

/* ------------------------------------------------------------------ the whole record */

describe("trackRecord", () => {
  it("counts decisions by whether any horizon has been settled, and the outcomes that were excluded", () => {
    const t = trackRecord([
      call("buy", [outcome("right", 0.05, { horizon: 5 }), outcome("excluded", null, { horizon: 20 })]),
      call("buy", []),
      call("sell", [outcome("excluded", null, { horizon: 5 })]),
    ]);
    expect(t).toMatchObject({ decisions: 3, withOutcome: 2, awaiting: 1, excluded: 2 });
  });

  it("separates bullish, bearish and hold calls at each of the three horizons", () => {
    const t = trackRecord([
      call("buy", [outcome("right", 0.05, { horizon: 5 }), outcome("wrong", -0.05, { horizon: 20 })]),
      call("overweight", [outcome("right", 0.06, { horizon: 20 })]),
      call("sell", [outcome("right", -0.05, { horizon: 20 })]),
      call("hold", [outcome("no_claim", 0.2, { horizon: 20 })]),
    ]);
    expect(t.horizons.map((h) => h.horizon)).toEqual([5, 20, 60]);
    const [h5, h20, h60] = t.horizons;
    expect(h5.bullish).toMatchObject({ n: 1, right: 1 });
    expect(h20.bullish).toMatchObject({ n: 2, right: 1, wrong: 1 });
    expect(h20.bearish).toMatchObject({ n: 1, right: 1 });
    expect(h20.hold.n).toBe(1);
    expect(h20.hold.meanAlpha).toBeCloseTo(0.2, 10);
    expect(h20.all.n).toBe(4);
    expect(h60.bullish.n).toBe(0);
    expect(h60.all).toEqual({ n: 0, meanAlpha: null });
  });

  it("folds the walked plans of each horizon into the plan record", () => {
    const t = trackRecord([
      call("buy", [outcome("right", 0.05, { horizon: 20, path: path({ reached: [1.5], r: 1.5 }) }), outcome("right", 0.05, { horizon: 5 })]),
      call("buy", [outcome("wrong", -0.05, { horizon: 20, path: path({ stopped: true, exitKind: "stop", r: -1 }) })]),
    ]);
    expect(t.plan.map((p) => [p.horizon, p.entries])).toEqual([[5, 0], [20, 2], [60, 0]]);
    expect(t.plan[1]).toMatchObject({ filled: 2, stopped: 1 });
  });

  it("lists the newest calls first, with the horizons still waiting and what the record shows", () => {
    const older = call("buy", [outcome("right", 0.05, { horizon: 5 })], { createdAt: "2026-01-06T12:00:00.000Z", ticker: "OLD" });
    const newer = call("sell", [], { createdAt: "2026-02-06T12:00:00.000Z", ticker: "NEW" });
    const t = trackRecord([older, newer]);
    expect(t.calls.map((c) => c.ticker)).toEqual(["NEW", "OLD"]);
    expect(t.calls[0].waiting).toEqual([5, 20, 60]);
    expect(t.calls[1].waiting).toEqual([20, 60]);
    expect(t.calls[1].reflection[0]).toBe("Buy, drawn from the 2026-01-05 close of 100.00.");
  });

  it("orders a call's outcomes by horizon and limits the list, but not the totals", () => {
    const calls = Array.from({ length: 30 }, (_, i) => call("buy", [outcome("right", 0.05, { horizon: 20 }), outcome("right", 0.05, { horizon: 5 })], { createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const t = trackRecord(calls);
    expect(t.calls).toHaveLength(RECORD_RULES.listed);
    expect(t.calls[0].outcomes.map((o) => o.horizon)).toEqual([5, 20]);
    expect(t.horizons[1].bullish.n).toBe(30);
    expect(trackRecord(calls, { listed: 3 }).calls).toHaveLength(3);
  });

  it("is empty for no decisions", () => {
    const t = trackRecord([]);
    expect(t).toMatchObject({ decisions: 0, withOutcome: 0, awaiting: 0, excluded: 0, calls: [] });
    expect(t.horizons.every((h) => h.bullish.verdict === "not_enough")).toBe(true);
  });
});

/* ------------------------------------------------------------------ in words */

describe("outcomeLine", () => {
  it("states the stock's move, the market's and the difference, with the verdict", () => {
    expect(outcomeLine(outcome("right", 0.05, { stockReturn: 0.08, marketReturn: 0.03 }))).toBe(
      "After 20 sessions the stock was +8.0% and the S&P 500 +3.0%, so +5.0% against the market: the call was right."
    );
    expect(outcomeLine(outcome("wrong", -0.05, { stockReturn: -0.02, marketReturn: 0.03 }))).toBe(
      "After 20 sessions the stock was −2.0% and the S&P 500 +3.0%, so −5.0% against the market: the call was wrong."
    );
  });

  it("shows the band a flat call fell inside", () => {
    expect(outcomeLine(outcome("flat", 0.01, { stockReturn: 0.02, marketReturn: 0.01 }))).toContain("too close to call (inside ±2.2%)");
    expect(outcomeLine(outcome("flat", 0.01, { horizon: 5, stockReturn: 0.02, marketReturn: 0.01 }))).toContain("(inside ±1.1%)");
  });

  it("says a hold makes no call against the market", () => {
    expect(outcomeLine(outcome("no_claim", 0.02, { stockReturn: 0.03, marketReturn: 0.01 }))).toContain("a hold makes no call against the market");
  });

  it("gives the reason an excluded outcome was not measured", () => {
    expect(outcomeLine(outcome("excluded", null))).toBe("After 20 sessions: not measured, because a split fell in the window.");
  });
});

describe("reflect", () => {
  const decision = {
    rating: {
      contributions: [
        { label: "Valuation", resolved: -1.5 },
        { label: "Growth", resolved: 2, contested: true },
        { label: "Macro", resolved: 1 },
        { label: "Quality", resolved: 0.5 },
        { label: "News flow", resolved: null },
      ],
      steps: [
        { rule: "checklist", from: "buy", to: "overweight", reason: "the checklist has open questions." },
        { rule: "none", from: "x", to: "y" },
      ],
    },
    blockers: ["the stock is stretched", "earnings are due", "no stop could be drawn"],
  };

  it("opens with the rating, the date and price it was drawn from", () => {
    const lines = reflect({ rating: "overweight", asOf: "2026-01-05", refPrice: 123.456, decision: {}, outcomes: [] });
    expect(lines).toEqual(["Overweight, drawn from the 2026-01-05 close of 123.46."]);
    expect(reflect({ rating: "buy", asOf: null, refPrice: null, decision: {}, outcomes: [] })).toEqual(["Buy."]);
  });

  it("says what held the rating back, which dimensions it leaned on, and what the desk held back from", () => {
    const lines = reflect({ rating: "overweight", asOf: "2026-01-05", refPrice: 100, decision, outcomes: [] });
    expect(lines).toContain("Held to Overweight from Buy: the checklist has open questions.");
    expect(lines).toContain("The committee scored growth (+2.0, contested) and macro (+1.0) highest.");
    expect(lines).toContain("It scored valuation (−1.5) lowest.");
    expect(lines).toContain("At the time the desk held back from buying: the stock is stretched, earnings are due and no stop could be drawn.");
    // a step with no reason says nothing; an unscored dimension is not described
    expect(lines.join(" ")).not.toContain("news flow");
    expect(lines.filter((l) => l.startsWith("Held to"))).toHaveLength(1);
  });

  it("states each outcome in horizon order", () => {
    const lines = reflect({ rating: "buy", asOf: "2026-01-05", refPrice: 100, decision: {}, outcomes: [outcome("right", 0.05, { horizon: 20, stockReturn: 0.05, marketReturn: 0 }), outcome("wrong", -0.05, { horizon: 5, stockReturn: -0.05, marketReturn: 0 })] });
    expect(lines[1]).toContain("After 5 sessions");
    expect(lines[2]).toContain("After 20 sessions");
  });

  it("describes a plan that hit its stop, after reaching a level", () => {
    const lines = reflect({
      rating: "buy", asOf: "2026-01-05", refPrice: 100, decision: {},
      outcomes: [outcome("wrong", -0.05, { path: path({ stopped: true, stopDate: "2026-02-02", sessionsToStop: 12, exitKind: "stop", exitPrice: 95, r: -1, reached: [1.5] }) })],
    });
    expect(lines.at(-1)).toBe("The plan reached 1.5R, then hit its stop on 2026-02-02, 12 sessions in (−1.0R).");
  });

  it("explains that a level touched in the stop's session is not counted", () => {
    const lines = reflect({
      rating: "buy", asOf: "2026-01-05", refPrice: 100, decision: {},
      outcomes: [outcome("wrong", -0.05, { path: path({ stopped: true, stopDate: "2026-01-09", sessionsToStop: 3, exitKind: "stop", r: -1, ambiguous: true }) })],
    });
    expect(lines.at(-1)).toContain("the order within a day is unknown, so it is not counted.");
    expect(lines.at(-1)).toContain("The plan hit its stop on 2026-01-09");
  });

  it("describes a plan that neither stopped nor reached a level, and one that reached levels", () => {
    const quiet = reflect({ rating: "buy", asOf: null, refPrice: null, decision: {}, outcomes: [outcome("flat", 0.01, { path: path({ r: 0.4 }) })] });
    expect(quiet.at(-1)).toBe("The plan did not hit its stop or any reward level in the 20 sessions (+0.4R).");
    const won = reflect({ rating: "buy", asOf: null, refPrice: null, decision: {}, outcomes: [outcome("right", 0.05, { path: path({ reached: [1.5, 2], r: 2.1 }) })] });
    expect(won.at(-1)).toBe("The plan reached 1.5R and 2R without hitting its stop in the 20 sessions (+2.1R).");
  });

  it("says a pullback entry would not have filled", () => {
    const lines = reflect({ rating: "buy", asOf: null, refPrice: null, decision: {}, outcomes: [outcome("right", 0.05, { path: path({ kind: "pullback", filled: false, r: null }) })] });
    expect(lines.at(-1)).toBe("The plan's pullback entry was never reached in the 20 sessions, so it would not have filled.");
  });

  it("describes the plan at the longest horizon that has one", () => {
    const lines = reflect({
      rating: "buy", asOf: null, refPrice: null, decision: {},
      outcomes: [outcome("right", 0.05, { horizon: 5, path: path({ r: 0.1 }) }), outcome("right", 0.05, { horizon: 60, path: path({ r: 3 }) }), outcome("right", 0.05, { horizon: 20 })],
    });
    expect(lines.at(-1)).toContain("in the 60 sessions (+3.0R)");
  });

  it("reads records that lack parts without failing", () => {
    expect(() => reflect({ rating: "hold", asOf: null, refPrice: null, decision: { rating: { contributions: [{}, { label: "x" }], steps: [{}] }, blockers: undefined }, outcomes: [] })).not.toThrow();
  });
});
