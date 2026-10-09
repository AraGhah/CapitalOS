import { describe, expect, it } from "vitest";
import {
  CHECKLIST_IDS,
  cagr,
  dcfValue,
  evaluateChecklist,
  impliedGrowth,
  recoveryNeeded,
  stressLoss,
  verdictOf,
  type ChecklistInput,
  type ChecklistItem,
  type PeriodIn,
} from "../../lib/checklist";
import { EMPTY_PROFILE, type InvestorProfile } from "../../lib/profile-fields";

// A steady, cash-rich compounder: revenue 100 → 110 → 121 → 133.1 (10% a year),
// 60% gross margin, 25% operating margin, net cash, shrinking share count.
function period(periodEnd: string, revenue: number, shares: number, over: Record<string, number> = {}): PeriodIn {
  return {
    periodEnd,
    values: {
      revenue,
      gross_profit: revenue * 0.6,
      operating_income: revenue * 0.25,
      net_income: revenue * 0.2,
      operating_cash_flow: revenue * 0.26,
      capex: revenue * 0.04,
      depreciation_amortization: revenue * 0.03,
      cash_and_equivalents: 80,
      long_term_debt: 20,
      current_debt: 0,
      total_equity: 150,
      interest_expense: 1,
      shares_diluted: shares,
      shares_outstanding: shares,
      ...over,
    },
    derived: { roic: 0.3, revenue_growth: 0.1, operating_margin_trend: 0 },
  };
}

const GOOD_PERIODS = [
  period("2025-12-31", 133.1, 97),
  period("2024-12-31", 121, 98),
  period("2023-12-31", 110, 99),
  period("2022-12-31", 100, 100),
];

const READY_PROFILE: InvestorProfile = {
  ...EMPTY_PROFILE,
  monthlyExpenses: 3000,
  emergencyFund: 24000,
  highInterestDebt: 0,
  investableAmount: 50000,
  positionSize: 4000,
  objective: "retirement",
  horizonYears: 25,
  maxLossShare: 0.6,
  riskTolerance: "high",
  accountType: "rrsp",
  contributionRoom: 20000,
  tradingCostShare: 0.001,
  institution: "A registered broker",
  institutionVerified: true,
};

function input(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    today: "2026-10-09",
    ticker: "ACME",
    name: "Acme Corp",
    sector: "Technology",
    listingCurrency: "USD",
    baseCurrency: "USD",
    profile: READY_PROFILE,
    periods: GOOD_PERIODS,
    price: { last: 3, asOf: "2026-10-08", volatility: 0.22, maxDrawdown: -0.18, avgDollarVolume: 5e8, source: "test closes" },
    // cheap: about 11x normalised free cash flow
    marketCap: 300,
    percentiles: { roic: 0.9, gross_margin: 0.8, ev_to_ebitda: 0.7, p_to_fcf: 0.7 },
    macro: { tenYear: 4.0, curve: 0.5, cpiYoy: 0.025, unemployment: 4.1, unemploymentYearAgo: 4.0, asOf: "2026-10-01" },
    portfolio: { value: 100000, held: 0, sameSector: 10000, positions: 12 },
    thesis: { rationale: "Sells subscription software to mid-size firms; switching costs keep customers renewing.", rules: 2, breached: false },
    dividendsLastYear: 0,
    cik: "0000000001",
    latestAnnualFiling: { form: "10-K", filedAt: "2026-02-15" },
    ...over,
  };
}

const byId = (items: ChecklistItem[], id: string) => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

describe("pre-investment checklist", () => {
  it("answers every question on the investor's checklist", () => {
    const c = evaluateChecklist(input());
    // the 23 questions of the guide's decision checklist, plus verifiability (§16)
    expect(c.items).toHaveLength(24);
    expect(c.items.map((i) => i.id)).toEqual(CHECKLIST_IDS);
    for (const i of c.items) {
      expect(i.finding.length).toBeGreaterThan(10);
      expect(["pass", "caution", "fail", "missing", "input"]).toContain(i.status);
    }
  });

  it("clears a strong company for a prepared investor", () => {
    const c = evaluateChecklist(input());
    const notPassing = c.items.filter((i) => i.status !== "pass").map((i) => `${i.id}: ${i.status} — ${i.finding}`);
    expect(notPassing).toEqual([]);
    expect(c.verdict.level).toBe("ready");
  });

  it("is not ready when the person has expensive debt, whatever the company", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, highInterestDebt: 5000 } }));
    expect(byId(c.items, "financial_readiness").status).toBe("fail");
    expect(c.verdict.level).toBe("not_ready");
    expect(c.verdict.blocking).toContain("Financial readiness");
  });

  it("fails thin emergency savings and a short horizon", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, emergencyFund: 3000, horizonYears: 1 } }));
    expect(byId(c.items, "emergency_savings").status).toBe("fail");
    expect(byId(c.items, "horizon").status).toBe("fail");
    expect(c.verdict.level).toBe("not_ready");
  });

  it("fails money meant for a car", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, objective: "car" } }));
    expect(byId(c.items, "objective").status).toBe("fail");
  });

  it("asks rather than assumes when the profile is empty", () => {
    const c = evaluateChecklist(input({ profile: { ...EMPTY_PROFILE }, thesis: null }));
    for (const id of ["financial_readiness", "emergency_savings", "objective", "horizon", "risk_capacity", "knowledge", "diversification", "fees", "taxes", "institution", "exit_strategy", "downside"]) {
      expect(byId(c.items, id).status, id).toBe("input");
    }
    expect(c.verdict.level).toBe("incomplete");
  });

  it("reports missing data instead of passing a company with no filings", () => {
    const c = evaluateChecklist(input({ periods: [], marketCap: null }));
    for (const id of ["business_quality", "growth", "profitability", "cash_flow", "financial_stability", "management", "competitive_advantage", "valuation"]) {
      expect(byId(c.items, id).status, id).toBe("missing");
    }
    expect(c.verdict.level).toBe("incomplete");
  });

  it("plans for at least a 50% fall on one stock, and checks it against what the person can lose", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, maxLossShare: 0.2 } }));
    expect(byId(c.items, "risk_capacity").status).toBe("fail");
    expect(c.verdict.level).toBe("not_ready");
  });

  it("fails a position larger than the loss the person can absorb", () => {
    // 50% of 40,000 = 20,000 > 30% of 50,000 = 15,000
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, positionSize: 40000, maxLossShare: 0.3 } }));
    expect(byId(c.items, "downside").status).toBe("fail");
  });

  it("flags a stretched balance sheet that a 30% revenue fall would break", () => {
    const levered = GOOD_PERIODS.map((p) => ({ ...p, values: { ...p.values, long_term_debt: 400, cash_and_equivalents: 5, interest_expense: 25 } }));
    const c = evaluateChecklist(input({ periods: levered }));
    const stability = byId(c.items, "financial_stability");
    expect(stability.status).toBe("fail");
    expect(c.verdict.level).toBe("material_risks");
  });

  it("does not fail a high-margin company with modest debt for the revenue shock", () => {
    // operating income 25% of revenue, gross profit 60%: a 30% revenue fall
    // turns operating income negative, but cash funds years of the shortfall
    const c = evaluateChecklist(input());
    expect(byId(c.items, "financial_stability").status).toBe("pass");
  });

  it("fails dilution above 3% a year", () => {
    const diluting = [period("2025-12-31", 133.1, 115), period("2024-12-31", 121, 110), period("2023-12-31", 110, 105), period("2022-12-31", 100, 100)];
    const c = evaluateChecklist(input({ periods: diluting }));
    expect(byId(c.items, "management").status).toBe("fail");
  });

  it("fails a price above even the optimistic case", () => {
    const c = evaluateChecklist(input({ marketCap: 100000 }));
    expect(byId(c.items, "valuation").status).toBe("fail");
    expect(c.scenarios?.impliedGrowth).toBeNull(); // no growth in range justifies it
  });

  it("warns on currency and US dividends in a TFSA", () => {
    const c = evaluateChecklist(
      input({ baseCurrency: "CAD", dividendsLastYear: 4, profile: { ...READY_PROFILE, accountType: "tfsa" } })
    );
    expect(byId(c.items, "currency").status).toBe("caution");
    expect(byId(c.items, "taxes").status).toBe("caution");
    expect(byId(c.items, "taxes").finding).toMatch(/withholding/);
  });

  it("fails a contribution beyond the account's room", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, accountType: "tfsa", contributionRoom: 1000 } }));
    expect(byId(c.items, "taxes").status).toBe("fail");
  });

  it("fails concentration above a quarter of the portfolio", () => {
    const c = evaluateChecklist(input({ portfolio: { value: 0, held: 0, sameSector: 0, positions: 0 }, profile: { ...READY_PROFILE, investableAmount: 4000 } }));
    expect(byId(c.items, "diversification").status).toBe("fail");
  });

  it("asks for the money available rather than calling a first position the whole portfolio", () => {
    const c = evaluateChecklist(input({ portfolio: { value: 0, held: 0, sameSector: 0, positions: 0 }, profile: { ...READY_PROFILE, investableAmount: null } }));
    expect(byId(c.items, "diversification").status).toBe("input");
  });

  it("describes a shrinking business as declining, never as accelerating", () => {
    const shrinking = [period("2025-12-31", 90, 100), period("2024-12-31", 92, 100), period("2023-12-31", 100, 100)];
    shrinking[0].derived.revenue_growth = -0.022;
    shrinking[1].derived.revenue_growth = -0.08;
    const growth = byId(evaluateChecklist(input({ periods: shrinking })).items, "growth");
    expect(growth.status).toBe("fail");
    expect(growth.finding).toMatch(/decline is easing/);
    expect(growth.finding).not.toMatch(/accelerating/);
  });

  it("fails an exit plan whose rule is already breached", () => {
    const c = evaluateChecklist(input({ thesis: { rationale: "x".repeat(60), rules: 1, breached: true } }));
    expect(byId(c.items, "exit_strategy").status).toBe("fail");
  });

  it("fails an unregistered broker as a personal blocker", () => {
    const c = evaluateChecklist(input({ profile: { ...READY_PROFILE, institutionVerified: false } }));
    expect(byId(c.items, "institution").status).toBe("fail");
    expect(c.verdict.level).toBe("not_ready");
  });
});

describe("checklist arithmetic", () => {
  it("compounds growth between period ends", () => {
    expect(cagr([{ periodEnd: "2025-12-31", value: 121 }, { periodEnd: "2023-12-31", value: 100 }])).toBeCloseTo(0.1, 2);
    expect(cagr([{ periodEnd: "2025-12-31", value: 100 }])).toBeNull();
  });

  it("finds the growth the price assumes", () => {
    const value = dcfValue(10, 0.07, 0.09);
    expect(impliedGrowth(10, value, 0.09)).toBeCloseTo(0.07, 6);
  });

  it("never plans for less than a halving, and knows what undoing a loss takes", () => {
    expect(stressLoss(0.1, -0.05)).toBe(0.5);
    expect(stressLoss(0.4, -0.3)).toBeCloseTo(1 - Math.exp(-0.8));
    expect(stressLoss(0.3, -0.62)).toBeCloseTo(0.62);
    expect(stressLoss(2, -0.2)).toBe(0.9);
    expect(recoveryNeeded(0.5)).toBe(1);
  });

  it("ranks a personal fail above everything else in the verdict", () => {
    const mk = (status: ChecklistItem["status"], personal: boolean): ChecklistItem => ({
      id: "x",
      group: "You",
      category: personal ? "Horizon" : "Valuation",
      question: "?",
      status,
      finding: "f",
      facts: [],
      gaps: [],
      guide: "§1",
      personal,
    });
    expect(verdictOf([mk("fail", true), mk("input", false)]).level).toBe("not_ready");
    expect(verdictOf([mk("fail", false), mk("input", false)]).level).toBe("incomplete");
    expect(verdictOf([mk("fail", false), mk("pass", true)]).level).toBe("material_risks");
    expect(verdictOf([mk("caution", false), mk("pass", true)]).level).toBe("caution");
    expect(verdictOf([mk("pass", false)]).level).toBe("ready");
  });
});
