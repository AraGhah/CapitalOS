import { describe, expect, it } from "vitest";
import { impliedGrowth } from "../../lib/checklist";
import { figuresOf, priceAssumes, shareChange, yearOf } from "../../lib/personas/figures";
import { LENSES, LENS_RULES, readLenses, viewOf, type LensId, type LensView } from "../../lib/personas/lenses";
import { compounder, struggler } from "./lens-fixtures";

const lens = (input: ReturnType<typeof compounder>, id: LensId): LensView => readLenses(input).lenses.find((l) => l.id === id)!;
const check = (view: LensView, id: string) => view.checks.find((c) => c.id === id)!;
const statuses = (view: LensView) => Object.fromEntries(view.checks.map((c) => [c.id, c.status]));

describe("the figures", () => {
  it("derives each year from the checklist's own conventions", () => {
    const f = figuresOf(compounder());
    expect(f.years).toHaveLength(5);
    const y = f.years[0];
    expect(y).toMatchObject({ revenue: 1000, netIncome: 200, equity: 1000, debt: 300, cash: 400, netDebt: -100, fcf: 200, dividends: 60 });
    expect(y.grossMargin).toBeCloseTo(0.6);
    expect(y.operatingMargin).toBeCloseTo(0.25);
    expect(y.roe).toBeCloseTo(0.2);
    // net income + depreciation − capital spending
    expect(y.ownerEarnings).toBe(210);
    // operating income + depreciation
    expect(y.ebitda).toBe(300);
  });

  it("prices the company from its market value and the last three years", () => {
    const f = figuresOf(compounder());
    expect(f.pe).toBeCloseTo(10);
    expect(f.peAverage).toBeCloseTo(2000 / ((200 + 180 + 162) / 3), 6);
    expect(f.pb).toBeCloseTo(2);
    expect(f.fcfYield).toBeCloseTo(0.1);
    expect(f.ownerYield).toBeCloseTo((210 + 190 + 172) / 3 / 2000, 6);
    // EV = 2,000 + 300 − 400 over an operating income of 250
    expect(f.evToEbit).toBeCloseTo(1900 / 250);
    expect(f.debtToEquity).toBeCloseTo(0.3);
    expect(f.revenueCagr).toBeCloseTo((1000 / 660) ** 0.25 - 1, 4);
  });

  it("discounts at the 10-year Treasury yield plus the checklist's equity risk premium, or its fallback", () => {
    expect(figuresOf(compounder({ tenYear: 4 })).rate).toBeCloseTo(0.09);
    expect(figuresOf(compounder({ tenYear: 4 })).rateBasis).toContain("4.00%");
    const none = figuresOf(compounder({ tenYear: null }));
    expect(none.rate).toBeCloseTo(0.09);
    expect(none.rateBasis).toContain("no Treasury yield is stored");
  });

  it("leaves a figure null rather than defaulting it", () => {
    const f = figuresOf(compounder({ marketCap: null }));
    expect(f.pe).toBeNull();
    expect(f.fcfYield).toBeNull();
    expect(f.assumes).toBeNull();
    // a loss year has no P/E
    expect(figuresOf(struggler()).pe).toBeNull();
    expect(yearOf({ periodEnd: "2025-12-31", values: {}, derived: {} })).toMatchObject({ revenue: null, fcf: null, ownerEarnings: null, dividends: null });
  });

  describe("the share count", () => {
    const years = (shares: number[]) =>
      ["2025-12-31", "2024-12-31", "2023-12-31"].map((periodEnd, i) => ({ ...yearOf({ periodEnd, values: { shares_diluted: shares[i] }, derived: {} }) }));

    it("reads the compound rate across the years", () => {
      expect(shareChange(years([110, 105, 100]), [])).toBeCloseTo(1.1 ** 0.5 - 1, 3);
    });

    it("leaves out a pair of years with a split between them, which would read as a jump", () => {
      // 2024 → 2025 doubled on a split in between; only 2023 → 2024 (flat) counts
      expect(shareChange(years([200, 100, 100]), ["2025-03-10"])).toBeCloseTo(0, 6);
    });

    it("is null when every pair straddles a split", () => {
      expect(shareChange(years([400, 200, 100]), ["2024-06-01", "2025-06-01"])).toBeNull();
    });
  });

  describe("what the price assumes", () => {
    it("finds the growth the checklist's reverse DCF finds", () => {
      const a = priceAssumes(200, 2000, 0.09);
      expect(a?.side).toBe("growth");
      expect(a && a.side === "growth" ? a.rate : null).toBeCloseTo(impliedGrowth(200, 2000, 0.09) as number, 10);
    });

    it("tells apart a price below any growth in range from one above it", () => {
      // 100 for 200 a year of cash: worth the price even if the cash flow shrank 30% a year
      expect(priceAssumes(200, 100, 0.09)).toEqual({ side: "below" });
      // a million for 200 a year: no growth in range (60% a year) is enough
      expect(priceAssumes(200, 1_000_000, 0.09)).toEqual({ side: "above" });
    });

    it("has nothing to unwind without positive free cash flow, and says so apart from missing data", () => {
      expect(priceAssumes(-5, 2000, 0.09)).toEqual({ side: "no_cash_flow" });
      expect(priceAssumes(0, 2000, 0.09)).toEqual({ side: "no_cash_flow" });
      expect(priceAssumes(null, 2000, 0.09)).toBeNull();
      expect(priceAssumes(200, null, 0.09)).toBeNull();
    });
  });
});

describe("a steady compounder", () => {
  const report = readLenses(compounder());

  it("fits the value, quality, growth-at-a-price and valuation lenses", () => {
    for (const id of ["graham", "buffett", "munger", "lynch", "fisher", "burry", "damodaran"] as const) {
      const v = report.lenses.find((l) => l.id === id)!;
      expect(v.fit, id).toBe("fits");
      expect(v.coverage, id).toBe(1);
    }
  });

  it("graham: clears every defensive test, the price on the combined rule", () => {
    const v = lens(compounder(), "graham");
    expect(statuses(v)).toEqual({ earnings_record: "pass", dividend_record: "pass", earnings_growth: "pass", leverage: "pass", price: "pass" });
    // P/E on average earnings is above 11 and P/B is 2, so only the product (22.1) clears Graham's 22.5
    expect(check(v, "price").value).toMatch(/^P\/E 11\.1 × P\/B 2\.00 = 22\.1$/);
    expect(check(v, "price").bar).toContain("22.5");
  });

  it("buffett: return on equity in every year, owner earnings above the Treasury yield", () => {
    const v = lens(compounder(), "buffett");
    expect(Object.values(statuses(v)).every((s) => s === "pass")).toBe(true);
    expect(check(v, "roe").value).toBe("5 of 5 years");
    expect(check(v, "debt").value).toBe("1.5 years");
    expect(check(v, "price").value).toBe("9.5% against 4.0%");
    expect(check(v, "dilution").note).toContain("falling");
  });

  it("munger: returns on capital, a steady margin and cash earnings", () => {
    const v = lens(compounder(), "munger");
    expect(Object.values(statuses(v)).every((s) => s === "pass")).toBe(true);
    expect(check(v, "leverage").value).toBe("net cash");
    expect(check(v, "cash_earnings").value).toBe("122%");
  });

  it("lynch: names the kind of grower and prices it per point of growth", () => {
    const v = lens(compounder(), "lynch");
    expect(check(v, "growth").note).toContain("stalwart");
    // P/E 10 over 10.9 points of growth
    expect(Number(check(v, "peg").value)).toBeCloseTo(10 / (((1000 / 660) ** 0.25 - 1) * 100), 2);
    expect(check(v, "peg").status).toBe("pass");
  });

  it("burry: cheap on cash and on EV to operating profit, but not out of favour", () => {
    const v = lens(compounder(), "burry");
    expect(statuses(v)).toEqual({ fcf_yield: "pass", ev_ebit: "pass", balance_sheet: "pass", out_of_favour: "fail", earning: "pass" });
    // 3 + 2 + 2 + 1 of 9
    expect(v.score).toBeCloseTo(8 / 9, 6);
    expect(v.fit).toBe("fits");
  });

  it("wood: growth that is steady rather than accelerating comes out mixed", () => {
    const v = lens(compounder(), "wood");
    expect(statuses(v)).toEqual({ growth: "partial", accelerating: "partial", gross_margin: "pass", operating_leverage: "partial" });
    expect(v.fit).toBe("mixed");
  });

  it("damodaran: the price asks for less growth than the company has delivered", () => {
    const v = lens(compounder(), "damodaran");
    expect(check(v, "implied_growth").status).toBe("pass");
    expect(check(v, "implied_growth").value).toMatch(/a year against 10\.9% delivered$/);
    expect(check(v, "spread").status).toBe("pass");
    expect(check(v, "spread").note).toContain("10-year Treasury yield (4.00%)");
  });

  it("tallies the lenses and has nothing to warn about", () => {
    expect(report.tally.fits + report.tally.mixed + report.tally.does_not_fit + report.tally.unscored).toBe(LENSES.length);
    // only Wood's lens, which wants growth that accelerates, is not satisfied by a steady compounder
    expect(report.tally).toEqual({ fits: 7, mixed: 1, does_not_fit: 0, unscored: 0 });
    expect(report.warnings).toEqual([]);
    expect(report.years).toBe(5);
  });
});

describe("a company in decline", () => {
  it("does not fit the value lens it fails on every count", () => {
    const v = lens(struggler(), "graham");
    // a loss in one of five years is partial; the rest fail, and net income growth cannot be measured
    expect(statuses(v)).toEqual({ earnings_record: "partial", dividend_record: "fail", earnings_growth: "missing", leverage: "fail", price: "fail" });
    expect(check(v, "dividend_record").note).toBe("No dividend payment appears in the filings.");
    expect(check(v, "price").note).toContain("not positive");
    expect(v.fit).toBe("does_not_fit");
    expect(v.coverage).toBeCloseTo(7 / 8, 6);
  });

  it("reads dilution and a loss against the quality lens", () => {
    const v = lens(struggler(), "buffett");
    expect(check(v, "dilution").status).toBe("fail");
    expect(check(v, "consistency").status).toBe("fail");
    expect(check(v, "debt").status).toBe("fail");
    expect(check(v, "price").status).toBe("fail");
    expect(v.fit).toBe("does_not_fit");
  });

  it("fails the price check when free cash flow is negative, rather than reporting it missing", () => {
    const v = lens(struggler(), "damodaran");
    expect(check(v, "implied_growth").status).toBe("fail");
    expect(check(v, "implied_growth").note).toContain("no positive free cash flow");
  });

  it("does not let a company with no growth pass a PEG", () => {
    expect(check(lens(struggler(), "lynch"), "peg").status).toBe("fail");
  });
});

describe("what the desk cannot measure", () => {
  it("reports a lens as not scored when too little of it could be measured", () => {
    const sparse = compounder();
    sparse.periods = sparse.periods.slice(0, 2);
    const report = readLenses(sparse);
    // two years: every check that needs three, or a growth rate across the record, is missing or thin
    const buffett = report.lenses.find((l) => l.id === "buffett")!;
    expect(check(buffett, "roe").status).toBe("missing");
    expect(check(buffett, "roe").note).toContain("needs 3 years");
    expect(buffett.fit).toBe("unscored");
    expect(buffett.headline).toContain("could be measured");
    expect(report.warnings[0]).toMatch(/Only 2 annual periods are stored/);
  });

  it("says plainly that there is nothing stored when there are no periods", () => {
    const report = readLenses(compounder({ periods: [] }));
    expect(report.warnings[0]).toContain("No annual filings are stored");
    expect(report.lenses.every((l) => l.fit === "unscored")).toBe(true);
  });

  it("does not test the price when there is no market value", () => {
    const report = readLenses(compounder({ marketCap: null }));
    expect(report.warnings).toContain("No market price or share count is stored, so the price cannot be tested.");
    const graham = report.lenses.find((l) => l.id === "graham")!;
    expect(check(graham, "price").status).toBe("missing");
    // the price is 3 of Graham's 8 weight, so it can still be scored on the rest
    expect(graham.coverage).toBeCloseTo(5 / 8, 6);
    expect(graham.fit).not.toBe("unscored");
  });

  it("does not score debt or margins for a bank", () => {
    const report = readLenses(compounder({ sector: "Financials" }));
    expect(report.warnings.some((w) => w.includes("Banks and insurers"))).toBe(true);
    const munger = report.lenses.find((l) => l.id === "munger")!;
    expect(check(munger, "leverage").status).toBe("missing");
    expect(check(munger, "roic").status).toBe("missing");
    // book value and earnings still price it
    expect(check(report.lenses.find((l) => l.id === "graham")!, "price").status).toBe("pass");
  });

  it("lists, for every lens, what no figure on file answers", () => {
    for (const l of readLenses(compounder()).lenses) {
      expect(l.notMeasured.length, l.id).toBeGreaterThan(0);
      expect(l.scope.length, l.id).toBeGreaterThan(40);
    }
  });
});

describe("the verdict", () => {
  // two checks that pass at weight 2 and 1, one that is partial at 1, one missing at 1
  const mini = (statuses: Array<[string, number]>) => ({
    id: "graham" as const,
    name: "Test",
    school: "",
    source: "",
    scope: "",
    notMeasured: [],
    checks: statuses.map(([status, weight], i) => ({
      id: `c${i}`,
      label: `c${i}`,
      weight,
      bar: "",
      run: () => ({ status: status as "pass", value: null, note: "" }),
    })),
  });
  const f = figuresOf(compounder());

  it("fits at 70% of the measured weight, does not fit at 30%, and is mixed between", () => {
    // 2 pass + 1 partial of 3 weight = 2.5 / 3 = 83%
    expect(viewOf(mini([["pass", 2], ["partial", 1]]), f)).toMatchObject({ fit: "fits" });
    // exactly 70%: 7 of 10
    expect(viewOf(mini([["pass", 7], ["fail", 3]]), f).fit).toBe("fits");
    expect(viewOf(mini([["pass", 6], ["fail", 4]]), f).fit).toBe("mixed");
    // exactly 30%
    expect(viewOf(mini([["pass", 3], ["fail", 7]]), f).fit).toBe("does_not_fit");
    expect(viewOf(mini([["pass", 4], ["fail", 6]]), f).fit).toBe("mixed");
  });

  it("gives half credit for a partial and none for a missing check, which also leaves the denominator", () => {
    const v = viewOf(mini([["pass", 2], ["partial", 2], ["missing", 1]]), f);
    expect(v.score).toBeCloseTo((2 + 1) / 4, 6);
    expect(v.coverage).toBeCloseTo(4 / 5, 6);
  });

  it(`gives no verdict below ${LENS_RULES.minCoverage * 100}% coverage, however well the rest scored`, () => {
    const v = viewOf(mini([["pass", 2], ["missing", 2], ["missing", 1]]), f);
    expect(v.coverage).toBeCloseTo(0.4, 6);
    expect(v.score).toBe(1);
    expect(v.fit).toBe("unscored");
  });

  it("has no score at all when nothing could be measured", () => {
    const v = viewOf(mini([["missing", 1], ["missing", 2]]), f);
    expect(v.score).toBeNull();
    expect(v.coverage).toBe(0);
    expect(v.fit).toBe("unscored");
  });
});

describe("the rubric", () => {
  it("prints the bar beside every check, built from the constants the check tests", () => {
    for (const l of LENSES) {
      expect(l.checks.length, l.id).toBeGreaterThanOrEqual(3);
      for (const c of l.checks) {
        expect(c.bar.length, `${l.id}.${c.id}`).toBeGreaterThan(10);
        expect(c.weight, `${l.id}.${c.id}`).toBeGreaterThan(0);
      }
      expect(new Set(l.checks.map((c) => c.id)).size, l.id).toBe(l.checks.length);
    }
  });

  it("covers the eight investors once each", () => {
    expect(LENSES.map((l) => l.id)).toEqual(["graham", "buffett", "munger", "lynch", "fisher", "burry", "wood", "damodaran"]);
  });

  it("gives the same result for the same company", () => {
    expect(readLenses(compounder())).toEqual(readLenses(compounder()));
  });
});
