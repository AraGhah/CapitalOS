import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { timeWeightedReturn, xirr } from "../../lib/returns";

describe("time-weighted return (FIN-01)", () => {
  it("ignores money moving in and out", () => {
    // 100 → 110 (+10%), then 100 deposited, 210 → 231 (+10%): TWR is 21%,
    // although the account's value more than doubled.
    const r = timeWeightedReturn([
      { date: "2026-01-01", value: 100, flow: 100 },
      { date: "2026-01-02", value: 110, flow: 0 },
      { date: "2026-01-03", value: 210, flow: 100 },
      { date: "2026-01-04", value: 231, flow: 0 },
    ]);
    expect(r.cumulative).toBeCloseTo(0.21, 10);
    expect(r.annualized).toBeNull();
  });

  it("equals the plain return when nothing moves", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -0.2, max: 0.2, noNaN: true }), { minLength: 1, maxLength: 50 }), (rs) => {
        let v = 1000;
        const points = [{ date: "2026-01-01", value: v, flow: v }];
        rs.forEach((r, i) => {
          v *= 1 + r;
          points.push({ date: new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10), value: v, flow: 0 });
        });
        return Math.abs(timeWeightedReturn(points).cumulative - (v / 1000 - 1)) < 1e-9;
      })
    );
  });

  it("annualises only over a year or more", () => {
    const r = timeWeightedReturn([
      { date: "2024-01-01", value: 100, flow: 100 },
      { date: "2026-01-01", value: 121, flow: 0 },
    ]);
    expect(r.annualized).toBeCloseTo(0.1, 3);
  });
});

describe("money-weighted return / XIRR (FIN-01)", () => {
  it("matches a known answer", () => {
    // -1000 then +1100 a year later is 10%.
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }])).toBeCloseTo(0.1, 3);
  });

  it("falls when more money arrives just before a loss", () => {
    const steady = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 900 },
    ])!;
    const badTiming = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-12-01", amount: -5000 },
      { date: "2026-01-01", amount: 5400 },
    ])!;
    expect(badTiming).toBeLessThan(steady);
  });

  it("is undefined when money only went one way", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });

  it("discounts the flows to zero at the rate it returns", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000 }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        fc.integer({ min: 30, max: 2000 }),
        (put, multiple, days) => {
          const end = new Date(Date.UTC(2025, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);
          const flows = [
            { date: "2025-01-01", amount: -put },
            { date: end, amount: put * multiple },
          ];
          const r = xirr(flows);
          if (r === null) return false;
          const years = days / 365.25;
          return Math.abs(-put + (put * multiple) / (1 + r) ** years) < 1e-4 * put;
        }
      )
    );
  });
});
