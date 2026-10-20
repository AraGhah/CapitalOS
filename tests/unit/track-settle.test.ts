import { describe, expect, it } from "vitest";
import { planShapeOf, walkPlan, type PathBar, type PlanShape } from "../../lib/track/paths";
import { SETTLE_RULES, flatBand, indexOnOrBefore, settleAt, verdictOf, type Close } from "../../lib/track/settle";

/* ------------------------------------------------------------------ walking a plan */

// Bought at 100 with a stop at 95: 5 of risk, so 1.5R is 107.5, 2R 110 and 3R 115.
const MARKET: PlanShape = {
  entry: { price: 100, kind: "market" },
  stop: 95,
  riskPerShare: 5,
  levels: [
    { multiple: 1.5, price: 107.5 },
    { multiple: 2, price: 110 },
    { multiple: 3, price: 115 },
  ],
};

// A limit buy at 98 with a stop at 93: 5 of risk, so 1.5R is 105.5, 2R 108 and 3R 113.
const PULLBACK: PlanShape = {
  entry: { price: 98, kind: "pullback" },
  stop: 93,
  riskPerShare: 5,
  levels: [
    { multiple: 1.5, price: 105.5 },
    { multiple: 2, price: 108 },
    { multiple: 3, price: 113 },
  ],
};

// Day 0 is the decision's close of 100; the rest are what followed.
const bar = (n: number, o: number | null, h: number | null, l: number | null, c: number): PathBar => ({ date: `2026-02-${String(n).padStart(2, "0")}`, open: o, high: h, low: l, close: c });
const day0 = bar(2, 100, 101, 99, 100);

describe("walkPlan: a market entry", () => {
  it("fills at the plan's price on the decision's date", () => {
    const r = walkPlan(MARKET, [day0, bar(3, 100, 101, 99, 100)], 0, 1);
    expect(r).toMatchObject({ kind: "market", filled: true, fillDate: "2026-02-02", fillPrice: 100 });
  });

  it("holds to the horizon, reporting the reward levels touched and R from the close", () => {
    const bars = [day0, bar(3, 101, 108, 100, 107), bar(4, 107, 111, 106, 110)];
    const r = walkPlan(MARKET, bars, 0, 2);
    expect(r).toMatchObject({ stopped: false, exitKind: "horizon", exitPrice: 110, reached: [1.5, 2], ambiguous: false });
    expect(r.r).toBeCloseTo(2, 10);
    expect(r.sessionsToStop).toBeNull();
  });

  it("exits at the stop when a session's low reaches it, and counts what was touched before", () => {
    const bars = [day0, bar(3, 101, 108, 100, 107), bar(4, 106, 107, 94.9, 96), bar(5, 96, 120, 96, 118)];
    const r = walkPlan(MARKET, bars, 0, 3);
    expect(r).toMatchObject({ stopped: true, stopDate: "2026-02-04", sessionsToStop: 2, exitKind: "stop", exitPrice: 95, reached: [1.5], ambiguous: false });
    expect(r.r).toBeCloseTo(-1, 10);
  });

  it("does not credit a level reached after the stop", () => {
    const bars = [day0, bar(3, 100, 101, 94, 95), bar(4, 95, 130, 95, 128)];
    expect(walkPlan(MARKET, bars, 0, 2).reached).toEqual([]);
  });

  it("counts a stop and a reward level in one session as the stop, and says the order was unknown", () => {
    const bars = [day0, bar(3, 100, 108, 94, 100)];
    const r = walkPlan(MARKET, bars, 0, 1);
    expect(r).toMatchObject({ stopped: true, exitPrice: 95, reached: [], ambiguous: true });
    expect(r.r).toBeCloseTo(-1, 10);
  });

  it("is not ambiguous when the level in the stop's session had already been reached", () => {
    const bars = [day0, bar(3, 101, 108, 100, 107), bar(4, 107, 108, 94, 96)];
    expect(walkPlan(MARKET, bars, 0, 2)).toMatchObject({ stopped: true, reached: [1.5], ambiguous: false });
  });

  it("exits at the open, not the stop, when the stock gaps through the stop", () => {
    const bars = [day0, bar(3, 92, 93, 90, 91)];
    const r = walkPlan(MARKET, bars, 0, 1);
    expect(r).toMatchObject({ stopped: true, exitPrice: 92 });
    expect(r.r).toBeCloseTo(-1.6, 10);
  });

  it("treats a missing open, high or low as the close", () => {
    const r = walkPlan(MARKET, [day0, bar(3, null, null, null, 108)], 0, 1);
    expect(r).toMatchObject({ stopped: false, reached: [1.5], exitPrice: 108 });
  });

  it("stops at the last stored bar when the horizon runs past the data", () => {
    const r = walkPlan(MARKET, [day0, bar(3, 100, 101, 99, 103)], 0, 20);
    expect(r).toMatchObject({ exitPrice: 103, exitKind: "horizon" });
    expect(r.r).toBeCloseTo(0.6, 10);
  });
});

describe("walkPlan: a pullback entry", () => {
  it("never fills, and has no result, when no session trades down to it", () => {
    const bars = [day0, bar(3, 100, 104, 98.5, 103), bar(4, 103, 106, 99, 105)];
    expect(walkPlan(PULLBACK, bars, 0, 2)).toMatchObject({ kind: "pullback", filled: false, fillDate: null, r: null, exitKind: null, reached: [] });
  });

  it("fills at the limit when a session's low reaches it, and is not credited with that session's high", () => {
    const bars = [day0, bar(3, 100, 106, 97.5, 104), bar(4, 104, 106, 100, 105)];
    const r = walkPlan(PULLBACK, bars, 0, 2);
    expect(r).toMatchObject({ filled: true, fillDate: "2026-02-03", fillPrice: 98, stopped: false });
    // 106 touched 1.5R (105.5) in the fill session, which does not count; the next session's does
    expect(r.reached).toEqual([1.5]);
    expect(r.r).toBeCloseTo((105 - 98) / 5, 10);
  });

  it("fills at the open when the stock opens below the limit", () => {
    const bars = [day0, bar(3, 96, 99, 95, 98)];
    const r = walkPlan(PULLBACK, bars, 0, 1);
    expect(r.fillPrice).toBe(96);
    expect(r.r).toBeCloseTo((98 - 96) / 5, 10);
  });

  it("is stopped out in the session it filled when that session's low reached the stop", () => {
    const bars = [day0, bar(3, 100, 101, 92, 94)];
    const r = walkPlan(PULLBACK, bars, 0, 1);
    expect(r).toMatchObject({ filled: true, stopped: true, stopDate: "2026-02-03", sessionsToStop: 1, exitPrice: 93, ambiguous: false });
    expect(r.r).toBeCloseTo(-1, 10);
  });

  it("does not look past the horizon for a fill", () => {
    const bars = [day0, bar(3, 100, 104, 99, 103), bar(4, 103, 104, 97, 98)];
    expect(walkPlan(PULLBACK, bars, 0, 1).filled).toBe(false);
  });
});

describe("planShapeOf", () => {
  const stored = { side: "enter", entry: { price: "100", kind: "market" }, stop: { price: 95 }, riskPerShare: 5, levels: [{ multiple: 1.5, price: 107.5 }] };

  it("reads a stored entry plan", () => {
    expect(planShapeOf(stored)).toEqual({ entry: { price: 100, kind: "market" }, stop: 95, riskPerShare: 5, levels: [{ multiple: 1.5, price: 107.5 }] });
  });

  it("refuses plans that are not entries, or that are missing what a walk needs", () => {
    expect(planShapeOf(null)).toBeNull();
    expect(planShapeOf({ ...stored, side: "exit" })).toBeNull();
    expect(planShapeOf({ ...stored, side: "none" })).toBeNull();
    expect(planShapeOf({ ...stored, stop: null })).toBeNull();
    expect(planShapeOf({ ...stored, riskPerShare: 0 })).toBeNull();
    expect(planShapeOf({ ...stored, entry: { price: 100, kind: "limit" } })).toBeNull();
    expect(planShapeOf({ ...stored, entry: null })).toBeNull();
  });

  it("refuses a stop that is not below the entry", () => {
    expect(planShapeOf({ ...stored, stop: { price: 100 } })).toBeNull();
    expect(planShapeOf({ ...stored, stop: { price: 101 } })).toBeNull();
  });

  it("keeps only reward levels above the entry, and none when they are not a list", () => {
    expect(planShapeOf({ ...stored, levels: [{ multiple: 1, price: 100 }, { multiple: 2, price: 110 }, { multiple: 0, price: 120 }, null] })?.levels).toEqual([{ multiple: 2, price: 110 }]);
    expect(planShapeOf({ ...stored, levels: "none" })?.levels).toEqual([]);
  });
});

/* ------------------------------------------------------------------ settling */

describe("the grading band", () => {
  it("widens with the square root of the horizon", () => {
    expect(flatBand(1)).toBeCloseTo(0.005, 10);
    expect(flatBand(5)).toBeCloseTo(0.01118, 5);
    expect(flatBand(20)).toBeCloseTo(0.02236, 5);
    expect(flatBand(60)).toBeCloseTo(0.03873, 5);
  });

  it("is right for a Buy or Overweight that beat the market past the band, and wrong when it trailed", () => {
    for (const rating of ["buy", "overweight"] as const) {
      expect(verdictOf(rating, 0.03, 20)).toBe("right");
      expect(verdictOf(rating, -0.03, 20)).toBe("wrong");
    }
  });

  it("is right for an Underweight or Sell that trailed the market, and wrong when it beat it", () => {
    for (const rating of ["underweight", "sell"] as const) {
      expect(verdictOf(rating, -0.03, 20)).toBe("right");
      expect(verdictOf(rating, 0.03, 20)).toBe("wrong");
    }
  });

  it("calls anything inside the band flat, whichever way it points", () => {
    expect(verdictOf("buy", 0.02, 20)).toBe("flat");
    expect(verdictOf("buy", -0.02, 20)).toBe("flat");
    expect(verdictOf("sell", 0.02, 20)).toBe("flat");
    expect(verdictOf("buy", 0, 20)).toBe("flat");
  });

  it("holds the same move to a wider band at a longer horizon", () => {
    expect(verdictOf("buy", 0.03, 20)).toBe("right");
    expect(verdictOf("buy", 0.03, 60)).toBe("flat");
  });

  it("makes no call for a Hold, however far the stock moved", () => {
    expect(verdictOf("hold", 0.5, 20)).toBe("no_claim");
    expect(verdictOf("hold", 0, 5)).toBe("no_claim");
  });
});

describe("indexOnOrBefore", () => {
  const bars = [{ date: "2026-01-05" }, { date: "2026-01-06" }, { date: "2026-01-09" }];

  it("finds the last bar on or before a date", () => {
    expect(indexOnOrBefore(bars, "2026-01-06")).toBe(1);
    expect(indexOnOrBefore(bars, "2026-01-07")).toBe(1);
    expect(indexOnOrBefore(bars, "2026-02-01")).toBe(2);
  });

  it("is -1 before the first bar and for no bars", () => {
    expect(indexOnOrBefore(bars, "2026-01-04")).toBe(-1);
    expect(indexOnOrBefore([], "2026-01-04")).toBe(-1);
  });
});

// Consecutive weekdays from Monday 2026-01-05.
function weekdays(n: number, from = "2026-01-05"): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}
const flatBars = (dates: string[], closes: number[]): PathBar[] => dates.map((date, i) => ({ date, open: closes[i], high: closes[i], low: closes[i], close: closes[i] }));
const closes = (dates: string[], values: number[]): Close[] => dates.map((date, i) => ({ date, close: values[i] }));

describe("settleAt", () => {
  const dates = weekdays(70);
  const START = dates[0];
  // the stock goes 100 -> 110 over five sessions and holds; the market goes 400 -> 404
  const stock = flatBars(dates, [100, 102, 104, 106, 108, 110, ...Array(64).fill(110)]);
  const market = closes(dates, [400, 400, 401, 402, 403, 404, ...Array(64).fill(404)]);
  const decision = (rating: "buy" | "hold" | "sell" = "buy", asOf: string | null = START) => ({ rating, asOf, plan: null });

  it("waits while the horizon has not closed", () => {
    expect(settleAt({ decision: decision(), horizon: 5, bars: stock.slice(0, 5), market, splits: [] })).toBeNull();
    expect(settleAt({ decision: decision(), horizon: 5, bars: stock.slice(0, 6), market, splits: [] })).not.toBeNull();
    expect(settleAt({ decision: decision(), horizon: 5, bars: [], market, splits: [] })).toBeNull();
  });

  it("waits while the market has no close for either date", () => {
    expect(settleAt({ decision: decision(), horizon: 5, bars: stock, market: market.slice(1), splits: [] })).toBeNull();
    expect(settleAt({ decision: decision(), horizon: 5, bars: stock, market: market.filter((m) => m.date !== dates[5]), splits: [] })).toBeNull();
    expect(settleAt({ decision: decision(), horizon: 5, bars: stock, market: [], splits: [] })).toBeNull();
  });

  it("measures the stock, the market and the difference from the stored closes", () => {
    const o = settleAt({ decision: decision(), horizon: 5, bars: stock, market, splits: [] })!;
    expect(o).toMatchObject({ horizon: 5, verdict: "right", reason: null, entryDate: dates[0], entryClose: 100, exitDate: dates[5], exitClose: 110 });
    expect(o.stockReturn).toBeCloseTo(0.1, 10);
    expect(o.marketReturn).toBeCloseTo(0.01, 10);
    expect(o.alpha).toBeCloseTo(0.09, 10);
    expect(o.path).toBeNull();
  });

  it("enters at the last close on or before the decision's date", () => {
    // the decision was drawn on a Saturday: it used Friday's close
    const friday = dates.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5)!;
    const saturday = new Date(Date.parse(`${friday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const i = dates.indexOf(friday);
    const o = settleAt({ decision: decision("buy", saturday), horizon: 5, bars: stock, market, splits: [] })!;
    expect(o.entryDate).toBe(friday);
    expect(o.exitDate).toBe(dates[i + 5]);
  });

  it("grades each rating by its direction against the market", () => {
    const grade = (rating: "buy" | "hold" | "sell") => settleAt({ decision: decision(rating), horizon: 5, bars: stock, market, splits: [] })!.verdict;
    expect(grade("buy")).toBe("right");
    expect(grade("sell")).toBe("wrong");
    expect(grade("hold")).toBe("no_claim");
  });

  it("calls a move inside the band too close to call", () => {
    const slow = flatBars(dates, [100, 100, 100, 100, 100, 100.5, ...Array(64).fill(100.5)]);
    const flatMarket = closes(dates, Array(70).fill(400));
    const o = settleAt({ decision: decision(), horizon: 5, bars: slow, market: flatMarket, splits: [] })!;
    expect(o.alpha).toBeCloseTo(0.005, 10);
    expect(o.verdict).toBe("flat");
  });

  it("measures all three horizons from the same entry", () => {
    const out = SETTLE_RULES.horizons.map((horizon) => settleAt({ decision: decision(), horizon, bars: stock, market, splits: [] })!);
    expect(out.map((o) => o.exitDate)).toEqual([dates[5], dates[20], dates[60]]);
  });

  it("walks the plan over the same sessions when the decision had one", () => {
    const plan = { side: "enter", entry: { price: 100, kind: "market" }, stop: { price: 95 }, riskPerShare: 5, levels: [{ multiple: 1.5, price: 107.5 }] };
    const o = settleAt({ decision: { rating: "buy", asOf: START, plan }, horizon: 5, bars: stock, market, splits: [] })!;
    expect(o.path).toMatchObject({ filled: true, stopped: false, reached: [1.5], exitPrice: 110 });
    expect(o.path!.r).toBeCloseTo(2, 10);
  });

  describe("when it cannot be measured fairly", () => {
    it("excludes a decision recorded without a price date", () => {
      const o = settleAt({ decision: decision("buy", null), horizon: 5, bars: stock, market, splits: [] })!;
      expect(o).toMatchObject({ verdict: "excluded", alpha: null, path: null });
      expect(o.reason).toContain("without a price date");
    });

    it("does not wait on prices for a decision that has no price date to match them to", () => {
      expect(settleAt({ decision: decision("buy", null), horizon: 5, bars: [], market: [], splits: [] })).toMatchObject({ verdict: "excluded" });
    });

    it("excludes a decision the stored prices begin after, once they could have reached it, and waits before that", () => {
      const early = "2025-12-01";
      const o = settleAt({ decision: decision("buy", early), horizon: 5, bars: stock, market, splits: [] })!;
      expect(o.verdict).toBe("excluded");
      expect(o.reason).toContain("no price is stored from before 2025-12-01");
      expect(settleAt({ decision: decision("buy", early), horizon: 60, bars: stock.slice(0, 20), market, splits: [] })).toBeNull();
    });

    it("excludes a decision whose nearest stored close is days away", () => {
      const gapped = flatBars(["2026-01-05", ...weekdays(12, "2026-01-19")], Array(13).fill(100));
      const o = settleAt({ decision: decision("buy", "2026-01-14"), horizon: 5, bars: gapped, market: closes(gapped.map((b) => b.date), Array(13).fill(400)), splits: [] })!;
      expect(o.verdict).toBe("excluded");
      expect(o.reason).toContain("is more than 4 days from the decision's price date 2026-01-14");
    });

    it("excludes a window with a hole in the stored prices", () => {
      const holed = flatBars(["2026-01-05", "2026-01-06", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"], Array(6).fill(100));
      const o = settleAt({ decision: decision("buy", "2026-01-05"), horizon: 5, bars: holed, market: closes(holed.map((b) => b.date), Array(6).fill(400)), splits: [] })!;
      expect(o.verdict).toBe("excluded");
      expect(o.reason).toContain("hole");
    });

    it("excludes a window with a split in it, on the day or after the entry up to the exit", () => {
      const split = (date: string) => settleAt({ decision: decision(), horizon: 5, bars: stock, market, splits: [date] })!;
      expect(split(dates[3]).verdict).toBe("excluded");
      expect(split(dates[3]).reason).toContain("a split fell between");
      expect(split(dates[5]).verdict).toBe("excluded");
      // the entry date itself is already on the new share count; the day after the exit has not happened yet
      expect(split(dates[0]).verdict).toBe("right");
      expect(split(dates[6]).verdict).toBe("right");
    });

    it("gives an excluded outcome no figures", () => {
      const o = settleAt({ decision: decision("buy", null), horizon: 5, bars: stock, market, splits: [] })!;
      expect([o.entryDate, o.entryClose, o.exitDate, o.exitClose, o.stockReturn, o.marketReturn, o.alpha]).toEqual(Array(7).fill(null));
    });
  });
});
