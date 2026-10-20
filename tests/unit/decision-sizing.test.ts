import { describe, expect, it } from "vitest";
import { SIZING_RULES, sizePosition, type SizingInput } from "../../lib/decision/sizing";

// 100,000 of capital, medium tolerance, a stop 5% below a 100 entry, nothing held:
//   risk budget  1% of 100,000 / 0.05           = 20,000
//   position cap 8% of 100,000                  =  8,000   <- lowest
function input(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    rating: "buy",
    confidence: "High",
    tolerance: "medium",
    capital: 100_000,
    heldValue: 0,
    heldQty: 0,
    sectorValue: null,
    plannedSize: null,
    affordableLoss: null,
    stress: 0.5,
    entry: 100,
    riskShare: 0.05,
    avgDollarVolume: null,
    fxToBase: 1,
    checklist: "ready",
    downtrend: false,
    ...overrides,
  };
}

const limit = (s: ReturnType<typeof sizePosition>, name: string) => s.constraints.find((c) => c.name === name)?.limit;

describe("sizing a buy", () => {
  it("takes the lowest of the ceilings: the 8% position cap here, 80 shares at 100", () => {
    const s = sizePosition(input());
    expect(limit(s, "risk budget")).toBeCloseTo(20_000, 6);
    expect(limit(s, "position cap")).toBe(8_000);
    expect(s.binding).toBe("position cap");
    expect(s.baseTarget).toBe(8_000);
    expect(s.multipliers).toEqual([]);
    expect(s.targetValue).toBe(8_000);
    expect(s.targetWeight).toBe(0.08);
    expect(s.deltaValue).toBe(8_000);
    expect(s.shares).toBe(80);
  });

  it("scales both ceilings with risk tolerance: low is 0.5% / 5%, high is 1.5% / 10%", () => {
    const low = sizePosition(input({ tolerance: "low" }));
    expect(limit(low, "risk budget")).toBeCloseTo(10_000, 6);
    expect(limit(low, "position cap")).toBe(5_000);
    expect(low.shares).toBe(50);

    const high = sizePosition(input({ tolerance: "high" }));
    expect(limit(high, "risk budget")).toBeCloseTo(30_000, 6);
    expect(limit(high, "position cap")).toBe(10_000);
    expect(high.shares).toBe(100);
  });

  it("uses the lowest tolerance, and says so, when none is set", () => {
    const s = sizePosition(input({ tolerance: null }));
    expect(s.shares).toBe(50);
    expect(s.notes.join(" ")).toContain("risk tolerance is not set");
  });

  it("lets a wide stop bind: a 20% stop risks 1% of capital on at most 5,000", () => {
    // 1,000 / 0.20 = 5,000, under the 8,000 cap
    const s = sizePosition(input({ riskShare: 0.2 }));
    expect(s.binding).toBe("risk budget");
    expect(s.targetValue).toBeCloseTo(5_000, 6);
    expect(s.shares).toBe(50);
  });

  it("falls back on the stress loss when there is no stop", () => {
    // 1,000 / 0.5 = 2,000
    const s = sizePosition(input({ riskShare: null }));
    expect(s.binding).toBe("risk budget");
    expect(s.targetValue).toBeCloseTo(2_000, 6);
    expect(s.shares).toBe(20);
    expect(s.constraints[0].note).toContain("50% fall the checklist plans for");
  });

  it("keeps a fall of the planned size within the loss the person said they could absorb", () => {
    // 2,500 can be lost; a 50% fall means at most 5,000 in the stock
    const s = sizePosition(input({ affordableLoss: 2_500 }));
    expect(limit(s, "affordable loss")).toBe(5_000);
    expect(s.binding).toBe("affordable loss");
    expect(s.shares).toBe(50);
  });

  it("keeps the sector under 40% of capital: 38,000 already in other stocks leaves room for 2,000", () => {
    const s = sizePosition(input({ sectorValue: 38_000 }));
    expect(limit(s, "sector room")).toBeCloseTo(2_000, 6);
    expect(s.binding).toBe("sector room");
    expect(s.shares).toBe(20);
  });

  it("does not count what is already held in the stock against its own sector room", () => {
    // 5,000 held, all of it in this sector: other stocks hold 0, so room is the full 40,000
    const s = sizePosition(input({ sectorValue: 5_000, heldValue: 5_000, heldQty: 50 }));
    expect(limit(s, "sector room")).toBe(40_000);
  });

  it("keeps the position sellable within 5 sessions at 10% of average daily dollar volume", () => {
    // 5 * 0.1 * 10,000 = 5,000
    const s = sizePosition(input({ avgDollarVolume: 10_000 }));
    expect(limit(s, "liquidity")).toBe(5_000);
    expect(s.binding).toBe("liquidity");
    expect(SIZING_RULES.exitSessions).toBe(5);
    expect(SIZING_RULES.participation).toBe(0.1);
  });

  it("skips the liquidity ceiling, and says so, without volume history", () => {
    const s = sizePosition(input({ avgDollarVolume: null }));
    expect(s.constraints.map((c) => c.name)).not.toContain("liquidity");
    expect(s.notes.join(" ")).toContain("liquidity ceiling is not applied");
  });

  it("never exceeds the size the person planned on their profile", () => {
    const s = sizePosition(input({ plannedSize: 3_000 }));
    expect(s.binding).toBe("planned size");
    expect(s.shares).toBe(30);
  });
});

describe("the factors that trim a size", () => {
  it("an overweight gets half a buy: 4,000, 40 shares", () => {
    const s = sizePosition(input({ rating: "overweight" }));
    expect(s.multipliers).toEqual([{ name: "overweight", factor: 0.5, reason: expect.any(String) }]);
    expect(s.targetValue).toBe(4_000);
    expect(s.shares).toBe(40);
  });

  it("Medium confidence earns 75%, Medium-high and High earn all of it, Low earns none", () => {
    expect(sizePosition(input({ confidence: "Medium" })).shares).toBe(60);
    expect(sizePosition(input({ confidence: "Medium-high" })).shares).toBe(80);
    expect(sizePosition(input({ confidence: "High" })).shares).toBe(80);
    expect(sizePosition(input({ confidence: "Low" })).shares).toBe(0);
  });

  it("halves the size while the checklist is incomplete or has found material risks, not when it is clear", () => {
    expect(sizePosition(input({ checklist: "incomplete" })).shares).toBe(40);
    expect(sizePosition(input({ checklist: "material_risks" })).shares).toBe(40);
    expect(sizePosition(input({ checklist: "caution" })).shares).toBe(80);
    expect(sizePosition(input({ checklist: "ready" })).shares).toBe(80);
  });

  it("halves the size in a downtrend", () => {
    expect(sizePosition(input({ downtrend: true })).shares).toBe(40);
  });

  it("multiplies them: 8,000 x 0.5 x 0.75 x 0.5 x 0.5 = 750, which is 7 whole shares", () => {
    const s = sizePosition(input({ rating: "overweight", confidence: "Medium", checklist: "incomplete", downtrend: true }));
    expect(s.multipliers.map((m) => m.name)).toEqual(["overweight", "confidence", "checklist", "downtrend"]);
    expect(s.targetValue).toBeCloseTo(750, 6);
    expect(s.shares).toBe(7);
  });
});

describe("what is already held", () => {
  it("buys only the difference: 5,000 held against a target of 8,000 is 30 more shares", () => {
    const s = sizePosition(input({ heldValue: 5_000, heldQty: 50, sectorValue: 5_000 }));
    expect(s.deltaValue).toBe(3_000);
    expect(s.shares).toBe(30);
  });

  it("buys nothing, and says so, when the position is already past the target", () => {
    const s = sizePosition(input({ heldValue: 10_000, heldQty: 100, sectorValue: 10_000 }));
    expect(s.deltaValue).toBe(-2_000);
    expect(s.shares).toBe(0);
    expect(s.notes.join(" ")).toContain("already hold at least");
  });
});

describe("currency and missing inputs", () => {
  it("converts shares through the exchange rate: 8,000 CAD at 100 USD x 1.35 is 59 whole shares", () => {
    // 135 CAD a share; 8,000 / 135 = 59.26
    expect(sizePosition(input({ fxToBase: 1.35 })).shares).toBe(59);
  });

  it("converts the liquidity ceiling too", () => {
    // 5 * 0.1 * 10,000 USD * 1.35 = 6,750 CAD
    expect(limit(sizePosition(input({ fxToBase: 1.35, avgDollarVolume: 10_000 })), "liquidity")).toBeCloseTo(6_750, 6);
  });

  it("gives the amount but not the shares when there is no exchange rate", () => {
    const s = sizePosition(input({ fxToBase: null }));
    expect(s.targetValue).toBe(8_000);
    expect(s.shares).toBeNull();
    expect(s.notes.join(" ")).toContain("exchange rate");
  });

  it("cannot size without capital", () => {
    const s = sizePosition(input({ capital: null }));
    expect(s.targetValue).toBeNull();
    expect(s.shares).toBeNull();
    expect(s.constraints).toEqual([]);
    expect(s.notes.join(" ")).toContain("money you set aside to invest");
  });
});

describe("the other ratings", () => {
  const held = { heldValue: 10_000, heldQty: 100 };

  it("hold keeps what is held", () => {
    const s = sizePosition(input({ rating: "hold", ...held }));
    expect(s).toMatchObject({ targetValue: 10_000, deltaValue: 0, shares: 0 });
  });

  it("underweight cuts the position by half", () => {
    const s = sizePosition(input({ rating: "underweight", ...held }));
    expect(s).toMatchObject({ targetValue: 5_000, deltaValue: -5_000, shares: -50 });
  });

  it("underweight on fractional shares rounds the trim down", () => {
    expect(sizePosition(input({ rating: "underweight", heldValue: 100, heldQty: 0.333 })).shares).toBe(-0.1665);
  });

  it("sell exits everything", () => {
    const s = sizePosition(input({ rating: "sell", ...held }));
    expect(s).toMatchObject({ targetValue: 0, targetWeight: 0, deltaValue: -10_000, shares: -100 });
  });
});
