import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { metricsAsOf, periodsAsOf, type FactRow } from "../../lib/strategy/backtest";
import { valuation } from "../../lib/ai/evidence";
import { sharesOnPriceBasis } from "../../lib/splits";

// A company with 100 shares and $1,000 of net income at FY2023, trading at
// $200 a share before a 10-for-1 split in mid-2024. Its true P/E is
// 100 × 200 / 1000 = 20. Yahoo's back-adjusted close for that date is $20.
const facts: FactRow[] = [
  { metric: "net_income", periodEnd: "2023-12-31", value: new Decimal(1000), knownFrom: "2024-02-15" },
  { metric: "revenue", periodEnd: "2023-12-31", value: new Decimal(5000), knownFrom: "2024-02-15" },
  { metric: "shares_outstanding", periodEnd: "2023-12-31", value: new Decimal(100), knownFrom: "2024-02-15" },
];
const split = [{ date: "2024-06-10", ratio: new Decimal(10) }];
const bars = Array.from({ length: 300 }, (_, i) => ({
  date: new Date(Date.UTC(2023, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
  close: 20,
  volume: null,
}));

describe("split-consistent valuation (BT-01)", () => {
  it("restates filed shares onto today's split basis", () => {
    expect(sharesOnPriceBasis(new Decimal(100), "2023-12-31", split).toNumber()).toBe(1000);
    expect(sharesOnPriceBasis(new Decimal(100), "2024-12-31", split).toNumber()).toBe(100);
  });

  it("gives the true P/E before the split, not one ten times too cheap", () => {
    const upto = bars.findIndex((b) => b.date === "2024-03-01");
    const m = metricsAsOf(facts, bars, upto, "2024-03-01", split);
    expect(m.pe).toBeCloseTo(20, 6);
    expect(m.ps).toBeCloseTo(4, 6);
  });

  it("matches the old arithmetic when there was no split", () => {
    const upto = bars.findIndex((b) => b.date === "2024-03-01");
    const m = metricsAsOf(facts, bars, upto, "2024-03-01", []);
    expect(m.pe).toBeCloseTo(2, 6);
  });

  it("does not see a filing before its filing date", () => {
    expect(periodsAsOf(facts, "2024-02-14")).toHaveLength(0);
    expect(periodsAsOf(facts, "2024-02-15")).toHaveLength(1);
  });

  it("labels evidence-pack market caps that were restated", () => {
    const latest = new Map([
      ["shares_outstanding", 1000],
      ["net_income", 1000],
    ]);
    const [cap, pe] = valuation(20, latest, 10);
    expect(cap.value).toBe(20_000);
    expect(cap.label).toMatch(/restated ×10/);
    expect(pe.value).toBe(20);
  });
});
