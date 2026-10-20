import { describe, expect, it } from "vitest";
import { FUNDAMENTAL_METRICS, earningsReleases, filingUrl, parseFacts, type CompanyFacts, type XbrlFact } from "../../lib/edgar";

const fact = (over: Partial<XbrlFact>): XbrlFact => ({ end: "2026-06-30", val: 1, accn: "0000320193-26-000010", form: "10-Q", filed: "2026-08-05", ...over });

describe("earnings per share", () => {
  const facts = (units: Record<string, XbrlFact[]>): CompanyFacts => ({
    cik: 320193,
    entityName: "Test Co",
    facts: { "us-gaap": { EarningsPerShareDiluted: { units } } },
  });

  it("is an ingested metric", () => {
    expect(FUNDAMENTAL_METRICS).toContain("eps_diluted");
  });

  it("reads the per-share unit, a quarter at a time", () => {
    const parsed = parseFacts(
      facts({
        "USD/shares": [
          fact({ start: "2026-04-01", end: "2026-06-30", val: 1.2 }),
          fact({ start: "2025-04-01", end: "2025-06-30", val: 1 }),
          // six months to date is neither a quarter nor a year
          fact({ start: "2026-01-01", end: "2026-06-30", val: 2.3 }),
        ],
      })
    );
    expect(parsed.map((p) => [p.metric, p.periodEnd, p.fiscalPeriod, p.value])).toEqual([
      ["eps_diluted", "2026-06-30", "Q", 1.2],
      ["eps_diluted", "2025-06-30", "Q", 1],
    ]);
  });

  it("reads a year as a year", () => {
    const parsed = parseFacts(facts({ "USD/shares": [fact({ start: "2025-10-01", end: "2026-09-30", val: 6.1, form: "10-K" })] }));
    expect(parsed).toMatchObject([{ metric: "eps_diluted", fiscalPeriod: "FY", value: 6.1 }]);
  });

  it("does not mistake a dollar-denominated fact for a per-share one", () => {
    expect(parseFacts(facts({ USD: [fact({ start: "2026-04-01", end: "2026-06-30", val: 120_000_000 })] }))).toEqual([]);
  });

  it("leaves share counts and dollar figures on their own units", () => {
    const parsed = parseFacts({
      cik: 1,
      entityName: "Test Co",
      facts: {
        "us-gaap": {
          NetIncomeLoss: { units: { USD: [fact({ start: "2026-04-01", end: "2026-06-30", val: 120 })] } },
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [fact({ start: "2026-04-01", end: "2026-06-30", val: 100 })] } },
        },
      },
    });
    expect(parsed.map((p) => p.metric).sort()).toEqual(["net_income", "shares_diluted"]);
  });
});

describe("earnings releases", () => {
  const recent = {
    accessionNumber: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"],
    filingDate: ["2026-07-28", "2026-07-01", "2026-08-05", "2026-04-28", "2026-04-30", "2026-01-27", "not-a-date"],
    form: ["8-K", "8-K", "10-Q", "8-K", "8-K/A", "8-K", "8-K"],
    items: ["2.02,9.01", "5.02", "", "9.01, 2.02", "2.02", "2.02", "2.02"],
  };

  it("keeps the 8-Ks filed under Item 2.02 and nothing else", () => {
    expect(earningsReleases(320193, recent).map((r) => [r.accession, r.announcedOn])).toEqual([
      ["A1", "2026-07-28"],
      ["A4", "2026-04-28"],
      ["A6", "2026-01-27"],
    ]);
  });

  it("links each to the filing's page", () => {
    expect(earningsReleases(320193, recent)[0].url).toBe(filingUrl(320193, "A1"));
  });

  it("is empty when the company has no recent filings listed", () => {
    expect(earningsReleases(1, undefined)).toEqual([]);
    expect(earningsReleases(1, {})).toEqual([]);
  });
});
