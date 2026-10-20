import { describe, expect, it } from "vitest";
import { RATINGS, RATING_RULES, WEIGHTS, compositeOf, rate, ratingOfComposite } from "../../lib/decision/rating";
import { dims } from "./decision-fixtures";

const high = { score: 0.8, label: "High" as const };

describe("the weights", () => {
  it("sum to 7.25, with valuation heaviest and news flow and macro at half", () => {
    expect(Object.values(WEIGHTS).reduce((s, w) => s + w, 0)).toBeCloseTo(7.25, 10);
    expect(WEIGHTS.valuation).toBe(1.25);
    expect(WEIGHTS.news_flow).toBe(0.5);
    expect(WEIGHTS.macro).toBe(0.5);
  });
});

describe("ratingOfComposite", () => {
  it("cuts the -2..+2 scale at 1, 0.4, -0.4 and -1, symmetrically", () => {
    expect(ratingOfComposite(2)).toBe("buy");
    expect(ratingOfComposite(1)).toBe("buy");
    expect(ratingOfComposite(0.99)).toBe("overweight");
    expect(ratingOfComposite(0.4)).toBe("overweight");
    expect(ratingOfComposite(0.39)).toBe("hold");
    expect(ratingOfComposite(0)).toBe("hold");
    expect(ratingOfComposite(-0.39)).toBe("hold");
    expect(ratingOfComposite(-0.4)).toBe("underweight");
    expect(ratingOfComposite(-0.99)).toBe("underweight");
    expect(ratingOfComposite(-1)).toBe("sell");
    expect(ratingOfComposite(-2)).toBe("sell");
  });

  it("lists the ratings from worst to best", () => {
    expect(RATINGS).toEqual(["sell", "underweight", "hold", "overweight", "buy"]);
  });
});

describe("compositeOf", () => {
  it("is the weighted mean: (2+1+2+1+0+2+0.5+0) / 7.25 for these scores", () => {
    // business 2, growth 1, profitability 2, balance sheet 1, valuation 0 (x1.25),
    // competitive 2, news 1 (x0.5), macro 0 (x0.5)
    const { composite, weightShare } = compositeOf(
      dims({ business_quality: 2, growth: 1, profitability: 2, balance_sheet: 1, valuation: 0, competitive_position: 2, news_flow: 1, macro: 0 })
    );
    expect(composite).toBeCloseTo(8.5 / 7.25, 10);
    expect(weightShare).toBe(1);
  });

  it("leaves out a dimension nobody scored instead of counting it as neutral", () => {
    // only business 2 and growth 0 are scored: (2*1 + 0*1) / 2 = 1, over 2 of 7.25 of the weight
    const { composite, weightShare } = compositeOf(dims({}, null).map((d) => (d.key === "business_quality" ? { ...d, resolved: 2 } : d.key === "growth" ? { ...d, resolved: 0 } : d)));
    expect(composite).toBe(1);
    expect(weightShare).toBeCloseTo(2 / 7.25, 10);
  });

  it("is null when nothing was scored", () => {
    expect(compositeOf(dims({}, null)).composite).toBeNull();
  });
});

describe("rate", () => {
  it("gives a buy to a strong, confident, clean committee, with no steps", () => {
    const r = rate({
      dimensions: dims({ business_quality: 2, growth: 1, profitability: 2, balance_sheet: 1, valuation: 0, competitive_position: 2, news_flow: 1, macro: 0 }),
      confidence: high,
      unverifiedFigures: [],
    });
    expect(r.raw).toBe("buy");
    expect(r.final).toBe("buy");
    expect(r.steps).toEqual([]);
  });

  it("refuses anything but hold at Low confidence, and says why", () => {
    const r = rate({ dimensions: dims({}, 2), confidence: { score: 0.4, label: "Low" }, unverifiedFigures: [] });
    expect(r.raw).toBe("buy");
    expect(r.final).toBe("hold");
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ rule: "confidence", from: "buy", to: "hold" });
    expect(r.steps[0].reason).toContain("Low");
    expect(rate({ dimensions: dims({}, -2), confidence: { score: 0.4, label: "Low" }, unverifiedFigures: [] }).final).toBe("hold");
  });

  it("holds Medium confidence to one tier either side of hold", () => {
    const medium = { score: 0.5, label: "Medium" as const };
    expect(rate({ dimensions: dims({}, 2), confidence: medium, unverifiedFigures: [] }).final).toBe("overweight");
    expect(rate({ dimensions: dims({}, -2), confidence: medium, unverifiedFigures: [] }).final).toBe("underweight");
    expect(rate({ dimensions: dims({}, 0.6), confidence: medium, unverifiedFigures: [] }).final).toBe("overweight");
  });

  it("lets Medium-high and High confidence through untouched", () => {
    for (const label of ["Medium-high", "High"] as const) {
      expect(rate({ dimensions: dims({}, 2), confidence: { score: 0.7, label }, unverifiedFigures: [] }).steps).toEqual([]);
      expect(rate({ dimensions: dims({}, -2), confidence: { score: 0.7, label }, unverifiedFigures: [] }).final).toBe("sell");
    }
  });

  it("will not call anything above hold on a fragile balance sheet, however good the rest", () => {
    // 2+2+2-1.5+(2*1.25)+2+1+1 -> wait: rest at 2 except balance sheet -1.5 and news/macro 2 (x0.5 each)
    // = 2+2+2-1.5+2.5+2+1+1 = 11 over 7.25 = 1.517, a buy by the numbers
    const r = rate({ dimensions: dims({ balance_sheet: -1.5 }, 2), confidence: high, unverifiedFigures: [] });
    expect(r.composite).toBeCloseTo(11 / 7.25, 10);
    expect(r.raw).toBe("buy");
    expect(r.final).toBe("hold");
    expect(r.steps.map((s) => s.rule)).toEqual(["balance sheet"]);
    expect(r.steps[0].reason).toContain("-1.50");
  });

  it("does not hold back a balance sheet that is merely weak-ish (-1.24)", () => {
    const r = rate({ dimensions: dims({ balance_sheet: -1.24 }, 2), confidence: high, unverifiedFigures: [] });
    expect(r.final).toBe("buy");
  });

  it("caps a buy at overweight when valuation is expensive, or disputed", () => {
    const expensive = rate({ dimensions: dims({ valuation: -1.5 }, 2), confidence: high, unverifiedFigures: [] });
    expect(expensive.raw).toBe("buy");
    expect(expensive.final).toBe("overweight");
    expect(expensive.steps).toMatchObject([{ rule: "valuation", from: "buy", to: "overweight" }]);

    const disputed = rate({ dimensions: dims({}, 2).map((d) => (d.key === "valuation" ? { ...d, contested: true } : d)), confidence: high, unverifiedFigures: [] });
    expect(disputed.final).toBe("overweight");
    expect(disputed.steps[0].reason).toContain("could not agree on valuation");
  });

  it("caps a buy at overweight when the conclusion has figures the checker never found", () => {
    const r = rate({ dimensions: dims({}, 2), confidence: high, unverifiedFigures: ["$4.2B", "31%"] });
    expect(r.final).toBe("overweight");
    expect(r.steps[0]).toMatchObject({ rule: "unverified figures", from: "buy", to: "overweight" });
    expect(r.steps[0].reason).toContain("2 figures");
    expect(r.steps[0].reason).toContain("$4.2B");
  });

  it("applies the caps in order and records each step that moved the rating", () => {
    // Medium confidence: buy -> overweight. Then fragile balance sheet: overweight -> hold.
    const r = rate({ dimensions: dims({ balance_sheet: -2 }, 2), confidence: { score: 0.5, label: "Medium" }, unverifiedFigures: ["9%"] });
    expect(r.raw).toBe("buy");
    expect(r.final).toBe("hold");
    expect(r.steps.map((s) => `${s.rule}: ${s.from}->${s.to}`)).toEqual(["confidence: buy->overweight", "balance sheet: overweight->hold"]);
  });

  it("never pushes a negative rating up, whatever the caps say", () => {
    const r = rate({ dimensions: dims({ balance_sheet: -2 }, -2), confidence: high, unverifiedFigures: ["9%"] });
    expect(r.final).toBe("sell");
    expect(r.steps).toEqual([]);
  });

  it("will not rate beyond hold when too few dimensions were scored", () => {
    // business, growth and profitability at +2: 3 of 7.25 is 41% of the weight, under the 60% needed
    const r = rate({ dimensions: dims({ business_quality: 2, growth: 2, profitability: 2 }, null), confidence: high, unverifiedFigures: [] });
    expect(r.weightShare).toBeCloseTo(3 / 7.25, 10);
    expect(r.weightShare).toBeLessThan(RATING_RULES.minWeightShare);
    expect(r.raw).toBe("buy");
    expect(r.final).toBe("hold");
    expect(r.steps).toMatchObject([{ rule: "coverage", from: "buy", to: "hold" }]);
    expect(r.steps[0].reason).toContain("3 of 8");
  });

  it("holds without a step when nothing was scored at all", () => {
    const r = rate({ dimensions: dims({}, null), confidence: high, unverifiedFigures: [] });
    expect(r.composite).toBeNull();
    expect(r.final).toBe("hold");
    expect(r.steps).toEqual([]);
  });

  it("is deterministic: the same report always gives the same rating", () => {
    const input = { dimensions: dims({ growth: 1.3, valuation: -0.4 }, 1.1), confidence: high, unverifiedFigures: [] };
    expect(rate(input)).toEqual(rate(structuredClone(input)));
  });
});
