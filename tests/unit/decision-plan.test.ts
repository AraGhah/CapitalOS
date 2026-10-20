import { describe, expect, it } from "vitest";
import { PLAN_RULES, tradePlan } from "../../lib/decision/plan";
import { snapshot } from "./decision-fixtures";

describe("the trader's plan to enter", () => {
  it("enters at the last close, stops two ATRs below it and prices 1.5, 2 and 3 times the risk", () => {
    // last 100, ATR 2.5: stop 100 - 2*2.5 = 95, risk 5 a share (5% of 100)
    const plan = tradePlan({ side: "enter", snapshot: snapshot(), last: null });
    expect(plan.entry).toMatchObject({ price: 100, kind: "market" });
    expect(plan.stop?.price).toBe(95);
    expect(plan.riskPerShare).toBe(5);
    expect(plan.riskShare).toBe(0.05);
    expect(plan.levels).toEqual([
      { multiple: 1.5, price: 107.5 },
      { multiple: 2, price: 110 },
      { multiple: 3, price: 115 },
    ]);
    expect(plan.asOf).toBe("2026-10-20");
    expect(plan.downtrend).toBe(false);
    expect(PLAN_RULES.stopAtrs).toBe(2);
  });

  it("waits for a pullback to the 20-day average when RSI says the stock is stretched", () => {
    // RSI 74 is overbought; the middle band is 96, so the entry is 96 and the stop 96 - 5 = 91
    const plan = tradePlan({
      side: "enter",
      snapshot: snapshot({ rsi14: 74, readings: { ...snapshot().readings, rsiZone: "overbought" } }),
      last: null,
    });
    expect(plan.entry).toMatchObject({ price: 96, kind: "pullback" });
    expect(plan.entry?.note).toContain("74.0");
    expect(plan.stop?.price).toBe(91);
    expect(plan.riskShare).toBeCloseTo(5 / 96, 12);
    expect(plan.levels.map((l) => l.price)).toEqual([103.5, 106, 111]);
  });

  it("also waits when the price is above its upper Bollinger band", () => {
    const plan = tradePlan({
      side: "enter",
      snapshot: snapshot({ readings: { ...snapshot().readings, bandPosition: "above the upper band" } }),
      last: null,
    });
    expect(plan.entry).toMatchObject({ price: 96, kind: "pullback" });
    expect(plan.entry?.note).toContain("upper Bollinger band");
  });

  it("does not wait for a pullback to an average that is above the price", () => {
    const plan = tradePlan({
      side: "enter",
      snapshot: snapshot({
        rsi14: 74,
        readings: { ...snapshot().readings, rsiZone: "overbought" },
        bollinger: { middle: 101, upper: 110, lower: 92, percentB: 0.5, bandwidth: 0.18 },
      }),
      last: null,
    });
    expect(plan.entry).toMatchObject({ price: 100, kind: "market" });
  });

  it("flags a downtrend, to halve the size", () => {
    const plan = tradePlan({ side: "enter", snapshot: snapshot({ readings: { ...snapshot().readings, trend: "downtrend" } }), last: null });
    expect(plan.downtrend).toBe(true);
    expect(plan.notes.join(" ")).toContain("halved");
  });

  it("notes a stock that moves a lot in a day", () => {
    const plan = tradePlan({ side: "enter", snapshot: snapshot({ atr14: 8, atrPct: 0.08 }), last: null });
    expect(plan.notes.join(" ")).toContain("8.0% of the price");
  });

  it("draws no stop without enough history, and says what the size falls back on", () => {
    const plan = tradePlan({ side: "enter", snapshot: null, last: 50 });
    expect(plan.entry).toMatchObject({ price: 50, kind: "market" });
    expect(plan.stop).toBeNull();
    expect(plan.riskShare).toBeNull();
    expect(plan.levels).toEqual([]);
    expect(plan.notes.join(" ")).toContain("not enough price history");
  });

  it("draws no stop that would sit at or below zero", () => {
    // 2 * 60 = 120 below an entry of 100
    const plan = tradePlan({ side: "enter", snapshot: snapshot({ atr14: 60, atrPct: 0.6 }), last: null });
    expect(plan.stop).toBeNull();
    expect(plan.levels).toEqual([]);
    expect(plan.notes.join(" ")).toContain("no stop is drawn");
  });

  it("has nothing to draw without a price", () => {
    const plan = tradePlan({ side: "enter", snapshot: null, last: null });
    expect(plan.entry).toBeNull();
    expect(plan.notes.join(" ")).toContain("no price");
  });
});

describe("the other sides", () => {
  it("an exit has a reference price and no entry, stop or levels", () => {
    const plan = tradePlan({ side: "exit", snapshot: snapshot(), last: null });
    expect(plan.reference).toBe(100);
    expect(plan.entry).toBeNull();
    expect(plan.stop).toBeNull();
    expect(plan.levels).toEqual([]);
    expect(plan.notes[0]).toContain("100.00");
  });

  it("no side draws nothing", () => {
    const plan = tradePlan({ side: "none", snapshot: snapshot(), last: null });
    expect(plan).toMatchObject({ entry: null, stop: null, levels: [], notes: [] });
  });
});
