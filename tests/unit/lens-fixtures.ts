import type { PeriodIn } from "../../lib/checklist";
import type { PersonaInput } from "../../lib/personas/figures";

const END = ["2025-12-31", "2024-12-31", "2023-12-31", "2022-12-31", "2021-12-31"];

interface Shape {
  revenue: number[];
  grossMargin: number;
  operatingIncome: number[];
  netIncome: number[];
  equity: number[];
  debt: number[];
  cash: number[];
  ocf: number[];
  capex: number;
  depreciation: number;
  dividends: number;
  shares: number[];
  roic: number;
}

// Five annual periods, newest first, from a few arrays so every figure can be worked out by hand.
function periods(s: Shape): PeriodIn[] {
  return END.map((periodEnd, i) => ({
    periodEnd,
    values: {
      revenue: s.revenue[i],
      gross_profit: s.revenue[i] * s.grossMargin,
      operating_income: s.operatingIncome[i],
      net_income: s.netIncome[i],
      total_equity: s.equity[i],
      long_term_debt: s.debt[i],
      cash_and_equivalents: s.cash[i],
      operating_cash_flow: s.ocf[i],
      capex: s.capex,
      depreciation_amortization: s.depreciation,
      ...(s.dividends > 0 ? { dividends_paid: s.dividends } : {}),
      shares_diluted: s.shares[i],
    },
    derived: {
      roic: s.roic,
      ...(i < 4 ? { revenue_growth: s.revenue[i] / s.revenue[i + 1] - 1 } : {}),
      operating_margin_trend: i < 4 ? s.operatingIncome[i] / s.revenue[i] - s.operatingIncome[i + 1] / s.revenue[i + 1] : 0,
    },
  }));
}

const base = { ticker: "TEST", name: "Test Co", sector: "Technology", asOf: "2026-10-20", tenYear: 4, splits: [] as string[] };

// A steady compounder: revenue up about 10.9% a year, a 60% gross and 25% operating margin, a 20% return on
// equity and on invested capital, net cash, a dividend every year and a share count falling a little under 1% a
// year. At a market value of 2,000 it trades on 10x earnings, 2x book and a 10% free cash flow yield.
export function compounder(over: Partial<PersonaInput> = {}): PersonaInput {
  const revenue = [1000, 900, 810, 730, 660];
  return {
    ...base,
    periods: periods({
      revenue,
      grossMargin: 0.6,
      operatingIncome: revenue.map((r) => r * 0.25),
      netIncome: revenue.map((r) => r * 0.2),
      equity: [1000, 950, 900, 850, 800],
      debt: [300, 300, 300, 300, 300],
      cash: [400, 400, 400, 400, 400],
      ocf: [240, 240, 240, 240, 240],
      capex: 40,
      depreciation: 50,
      dividends: 60,
      shares: [100, 101, 102, 103, 104],
      roic: 0.2,
    }),
    marketCap: 2000,
    price: { last: 100, asOf: "2026-10-20", belowHigh: -0.05 },
    ...over,
  };
}

// A company in decline: revenue falling, a loss in the latest year, thin cash, heavy debt, no dividend and a
// share count that keeps rising.
export function struggler(over: Partial<PersonaInput> = {}): PersonaInput {
  return {
    ...base,
    periods: periods({
      revenue: [800, 850, 900, 950, 1000],
      grossMargin: 0.2,
      operatingIncome: [-20, 15, 40, 30, 60],
      netIncome: [-40, 10, 30, 20, 50],
      equity: [100, 140, 130, 120, 110],
      debt: [600, 600, 600, 600, 600],
      cash: [50, 50, 50, 50, 50],
      ocf: [10, 30, 50, 60, 70],
      capex: 40,
      depreciation: 30,
      dividends: 0,
      shares: [130, 120, 115, 110, 100],
      roic: 0.02,
    }),
    marketCap: 1500,
    price: { last: 12, asOf: "2026-10-20", belowHigh: -0.6 },
    ...over,
  };
}
