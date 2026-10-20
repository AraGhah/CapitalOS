import {
  T,
  cagr,
  cashAndInvestments,
  dcfValue,
  ebitda as ebitdaOf,
  freeCashFlow,
  grossProfit,
  impliedGrowth,
  periodDerived,
  periodValue,
  ratioOf,
  totalDebt,
  type PeriodIn,
} from "../checklist";

/* ---------------------------------------------------------------------------
   The figures the investor lenses read, derived once per company.

   Every number comes from the same annual periods the pre-investment
   checklist reads, with the checklist's conventions for debt, cash and free
   cash flow, so a lens and the checklist never show two different values for
   the same thing. A figure that cannot be computed is null, never a default.

   Pure: the periods and the price go in, figures come out.
--------------------------------------------------------------------------- */

export interface PersonaInput {
  ticker: string;
  name: string;
  sector: string | null;
  asOf: string;
  // annual periods, newest first
  periods: PeriodIn[];
  marketCap: number | null;
  price: { last: number; asOf: string; belowHigh: number | null } | null;
  // the 10-year Treasury yield in percent (4.2 is 4.2%)
  tenYear: number | null;
  // ex-dates of the company's splits, to keep a share count that straddles one out of the dilution figure
  splits: string[];
}

export interface Year {
  periodEnd: string;
  revenue: number | null;
  grossMargin: number | null;
  operatingIncome: number | null;
  operatingMargin: number | null;
  netIncome: number | null;
  equity: number | null;
  roe: number | null;
  roic: number | null;
  revenueGrowth: number | null;
  operatingMarginChange: number | null;
  fcf: number | null;
  // net income + depreciation − capital spending: all of it counted as maintenance, which is the stricter reading
  ownerEarnings: number | null;
  debt: number | null;
  cash: number | null;
  netDebt: number | null;
  ebitda: number | null;
  // cash paid to shareholders, as a positive number
  dividends: number | null;
  shares: number | null;
}

// What a price assumes, from a reverse discounted cash flow.
export type Assumption =
  | { side: "growth"; rate: number }
  | { side: "below" }
  | { side: "above" }
  | { side: "no_cash_flow" };

export interface Figures {
  years: Year[];
  latest: Year | null;
  financial: boolean;
  marketCap: number | null;
  price: PersonaInput["price"];
  tenYear: number | null;
  revenueCagr: number | null;
  incomeCagr: number | null;
  // a year; null when no pair of years can be compared without a split between them
  shareChange: number | null;
  // the average of up to three years, so one odd year does not set a price check
  normalisedFcf: number | null;
  normalisedOwnerEarnings: number | null;
  averageIncome: number | null;
  fcfYield: number | null;
  ownerYield: number | null;
  pe: number | null;
  peAverage: number | null;
  pb: number | null;
  evToEbit: number | null;
  debtToEquity: number | null;
  // the cost of equity the reverse DCF discounts at, and where it came from
  rate: number;
  rateBasis: string;
  assumes: Assumption | null;
}

const present = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
const positive = (x: number | null): x is number => x !== null && x > 0;

export function yearOf(p: PeriodIn): Year {
  const revenue = periodValue(p, "revenue");
  const netIncome = periodValue(p, "net_income");
  const equity = periodValue(p, "total_equity");
  const operatingIncome = periodValue(p, "operating_income");
  const depreciation = periodValue(p, "depreciation_amortization");
  const capex = periodValue(p, "capex");
  const debt = totalDebt(p);
  const cash = cashAndInvestments(p);
  const paid = periodValue(p, "dividends_paid");
  return {
    periodEnd: p.periodEnd,
    revenue,
    grossMargin: ratioOf(grossProfit(p), revenue),
    operatingIncome,
    operatingMargin: ratioOf(operatingIncome, revenue),
    netIncome,
    equity,
    roe: equity !== null && equity > 0 ? ratioOf(netIncome, equity) : null,
    roic: periodDerived(p, "roic"),
    revenueGrowth: periodDerived(p, "revenue_growth"),
    operatingMarginChange: periodDerived(p, "operating_margin_trend"),
    fcf: freeCashFlow(p),
    ownerEarnings: netIncome !== null && depreciation !== null && capex !== null ? netIncome + depreciation - capex : null,
    debt,
    cash,
    netDebt: debt !== null && cash !== null ? debt - cash : null,
    ebitda: ebitdaOf(p),
    dividends: paid === null ? null : Math.abs(paid),
    shares: periodValue(p, "shares_diluted"),
  };
}

// Diluted shares are reported as filed, so a split inside a pair of years makes
// the count look like it jumped. A pair with a split between its period ends is
// left out; the rest give one compound annual rate.
export function shareChange(years: Year[], splits: string[]): number | null {
  let logSum = 0;
  let span = 0;
  for (let i = 0; i < years.length - 1; i++) {
    const newer = years[i];
    const older = years[i + 1];
    if (!positive(newer.shares) || !positive(older.shares)) continue;
    if (splits.some((s) => s > older.periodEnd && s <= newer.periodEnd)) continue;
    const gap = (Date.parse(newer.periodEnd) - Date.parse(older.periodEnd)) / (365.25 * 86_400_000);
    if (gap < 0.5) continue;
    logSum += Math.log(newer.shares / older.shares);
    span += gap;
  }
  return span > 0 ? Math.exp(logSum / span) - 1 : null;
}

// What the price assumes about ten years of cash-flow growth: the checklist's
// reverse DCF, with the two ends of its search range told apart. A price that
// needs less than -30% a year is "below"; one that needs more than 60% is "above".
export function priceAssumes(fcf: number | null, marketCap: number | null, rate: number): Assumption | null {
  if (fcf === null || marketCap === null) return null;
  if (!(fcf > 0)) return { side: "no_cash_flow" };
  const growth = impliedGrowth(fcf, marketCap, rate);
  if (growth !== null) return { side: "growth", rate: growth };
  return dcfValue(fcf, -0.3, rate) > marketCap ? { side: "below" } : { side: "above" };
}

export function figuresOf(input: PersonaInput): Figures {
  const years = input.periods.map(yearOf);
  const latest = years[0] ?? null;
  const cap = positive(input.marketCap) ? input.marketCap : null;
  const series = (pick: (y: Year) => number | null) => years.map((y) => ({ periodEnd: y.periodEnd, value: pick(y) }));

  const recent = years.slice(0, 3);
  const normalisedFcf = mean(present(recent.map((y) => y.fcf)));
  const normalisedOwnerEarnings = mean(present(recent.map((y) => y.ownerEarnings)));
  const incomes = present(recent.map((y) => y.netIncome));
  const averageIncome = incomes.length === 3 ? mean(incomes) : null;

  const rate = input.tenYear !== null ? input.tenYear / 100 + T.equityRiskPremium : T.fallbackDiscount;
  const rateBasis =
    input.tenYear !== null
      ? `the 10-year Treasury yield (${input.tenYear.toFixed(2)}%) plus a ${(T.equityRiskPremium * 100).toFixed(0)}% equity risk premium`
      : `${(T.fallbackDiscount * 100).toFixed(0)}%, because no Treasury yield is stored`;

  const ev = cap !== null && latest && latest.debt !== null && latest.cash !== null ? cap + latest.debt - latest.cash : null;

  return {
    years,
    latest,
    financial: input.sector === "Financials",
    marketCap: cap,
    price: input.price,
    tenYear: input.tenYear,
    revenueCagr: cagr(series((y) => y.revenue)),
    incomeCagr: cagr(series((y) => y.netIncome)),
    shareChange: shareChange(years, input.splits),
    normalisedFcf,
    normalisedOwnerEarnings,
    averageIncome,
    fcfYield: cap !== null && normalisedFcf !== null ? normalisedFcf / cap : null,
    ownerYield: cap !== null && normalisedOwnerEarnings !== null ? normalisedOwnerEarnings / cap : null,
    pe: cap !== null && positive(latest?.netIncome ?? null) ? cap / (latest!.netIncome as number) : null,
    peAverage: cap !== null && positive(averageIncome) ? cap / averageIncome : null,
    pb: cap !== null && positive(latest?.equity ?? null) ? cap / (latest!.equity as number) : null,
    evToEbit: ev !== null && positive(latest?.operatingIncome ?? null) ? ev / (latest!.operatingIncome as number) : null,
    debtToEquity: latest && positive(latest.equity) && latest.debt !== null ? latest.debt / latest.equity : null,
    rate,
    rateBasis,
    assumes: priceAssumes(normalisedFcf, cap, rate),
  };
}
