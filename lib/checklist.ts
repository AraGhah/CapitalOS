import type { InvestorProfile } from "./profile-fields";

/* ---------------------------------------------------------------------------
   The pre-investment checklist.

   Before the desk suggests a stock, every question on the investor's checklist
   is answered here — about the person first (can they afford it, when do they
   need the money, how much could they lose), then the business, the price, the
   economy, the portfolio, the costs and the plan. Each answer is a threshold on
   a computed number, so the same inputs always give the same checklist, and
   each says which figures it rests on and what the desk could not verify.

   Five outcomes, never more optimistic than the evidence:
     pass     the evidence clears the bar
     caution  it clears it partly, or a material risk needs understanding
     fail     it does not clear the bar
     missing  the desk does not have the data to judge
     input    only the person can answer (their finances, their plan)

   A failed check about the person makes the verdict "not ready" whatever the
   company looks like: an excellent investment can still be the wrong one for
   someone who will need the money next year.

   Pure: every input is passed in, so the whole checklist is tested without a
   database. buildChecklist in lib/checklist-data.ts gathers the inputs.
--------------------------------------------------------------------------- */

export type Status = "pass" | "caution" | "fail" | "missing" | "input";

export type Group = "You" | "The business" | "The price" | "The economy" | "Your portfolio" | "Costs and safety" | "Your plan";

export interface Fact {
  label: string;
  value: string;
}

export interface ChecklistItem {
  id: string;
  group: Group;
  category: string;
  question: string;
  status: Status;
  finding: string;
  facts: Fact[];
  // what the desk could not check, so a pass is never read as more than it is
  gaps: string[];
  // the section of the investor's guide the question comes from
  guide: string;
  // a fail here means "not ready", whatever the rest says
  personal: boolean;
}

export type VerdictLevel = "not_ready" | "incomplete" | "material_risks" | "caution" | "ready";

export interface Verdict {
  level: VerdictLevel;
  headline: string;
  counts: Record<Status, number>;
  blocking: string[];
  unverified: string[];
  risks: string[];
}

export interface Checklist {
  ticker: string;
  name: string;
  asOf: string;
  baseCurrency: string;
  listingCurrency: string;
  positionSize: number | null;
  verdict: Verdict;
  items: ChecklistItem[];
  // the scenario arithmetic behind the valuation and downside checks
  scenarios: Scenarios | null;
  sources: string[];
}

/* -------------------------------------------------------------------- inputs */

export interface PeriodIn {
  periodEnd: string;
  // reported figures, by the metric names in lib/edgar
  values: Record<string, number>;
  // lib/metrics' derived figures for the period (revenue_growth, roic, …)
  derived: Record<string, number>;
}

export interface ChecklistInput {
  today: string;
  ticker: string;
  name: string;
  sector: string | null;
  listingCurrency: string;
  baseCurrency: string;
  profile: InvestorProfile;
  // newest first, at most four annual periods
  periods: PeriodIn[];
  price: {
    last: number;
    asOf: string;
    volatility: number | null;
    maxDrawdown: number | null;
    avgDollarVolume: number | null;
    source: string;
  } | null;
  marketCap: number | null;
  // sector percentiles from the latest scores, 1.0 = best in sector
  percentiles: Record<string, number>;
  macro: {
    tenYear: number | null; // percent, e.g. 4.2
    curve: number | null; // 10y − 2y, percentage points
    cpiYoy: number | null; // ratio, e.g. 0.031
    unemployment: number | null; // percent
    unemploymentYearAgo: number | null;
    asOf: string | null;
  };
  portfolio: {
    value: number; // base currency
    held: number; // already held in this company, base currency
    sameSector: number; // held in the company's sector, base currency
    positions: number;
  };
  thesis: { rationale: string | null; rules: number; breached: boolean } | null;
  dividendsLastYear: number; // dividend events with an ex-date in the last year
  cik: string | null;
  latestAnnualFiling: { form: string; filedAt: string } | null;
}

/* ---------------------------------------------------------------- thresholds */

// Every bar a check uses, in one place, so the page can say what it measured
// against and changing one is a one-line diff.
export const T = {
  emergencyMonthsMin: 3,
  emergencyMonthsGood: 6,
  horizonFail: 3,
  horizonCaution: 5,
  // a single stock can halve; the checklist never assumes a smaller worst case
  stressLossFloor: 0.5,
  stressLossCap: 0.9,
  growthGood: 0.05,
  marginTrendDrop: -0.02,
  opMarginGood: 0.15,
  roicGood: 0.1,
  roicMoat: 0.15,
  roicPoor: 0.06,
  grossMarginStable: 0.05,
  cashConversionGood: 0.8,
  netDebtEbitdaGood: 1.5,
  netDebtEbitdaBad: 3.5,
  coverageGood: 8,
  coverageBad: 2,
  revenueShock: 0.3,
  stressCashYears: 2,
  debtGrowthCaution: 0.5,
  currentDebtShareCaution: 0.4,
  dilutionGood: 0.01,
  dilutionBad: 0.03,
  equityRiskPremium: 0.05,
  fallbackDiscount: 0.09,
  terminalGrowth: 0.025,
  dcfYears: 10,
  bearValueGap: 0.6,
  positionGood: 0.1,
  positionBad: 0.25,
  sectorCaution: 0.4,
  roundTripCostGood: 0.005,
  roundTripCostBad: 0.02,
  advMin: 1_000_000,
  participation: 0.1,
  filingFreshDays: 460,
  ratesHigh: 4,
  inflationHigh: 0.035,
  unemploymentRise: 0.5,
  rationaleMinChars: 40,
} as const;

/* ------------------------------------------------------------------ format */

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const mult = (x: number) => `${x.toFixed(1)}x`;

function compact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

const money = (x: number, ccy: string) => `${compact(x)} ${ccy}`;

/* ------------------------------------------------------- period arithmetic */

function v(p: PeriodIn | undefined, metric: string): number | null {
  const x = p?.values[metric];
  return x === undefined || !Number.isFinite(x) ? null : x;
}

function d(p: PeriodIn | undefined, metric: string): number | null {
  const x = p?.derived[metric];
  return x === undefined || !Number.isFinite(x) ? null : x;
}

function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

function grossProfit(p: PeriodIn): number | null {
  const reported = v(p, "gross_profit");
  if (reported !== null) return reported;
  const revenue = v(p, "revenue");
  const cost = v(p, "cost_of_revenue");
  return revenue === null || cost === null ? null : revenue - cost;
}

function fcf(p: PeriodIn): number | null {
  const ocf = v(p, "operating_cash_flow");
  return ocf === null ? null : ocf - (v(p, "capex") ?? 0);
}

function debt(p: PeriodIn): number | null {
  const combined = v(p, "total_debt");
  if (combined !== null) return combined;
  const lt = v(p, "long_term_debt");
  const cur = v(p, "current_debt");
  return lt === null && cur === null ? null : (lt ?? 0) + (cur ?? 0);
}

function cashAndInvestments(p: PeriodIn): number | null {
  const cash = v(p, "cash_and_equivalents");
  return cash === null ? null : cash + (v(p, "short_term_investments") ?? 0);
}

function ebitda(p: PeriodIn): number | null {
  const op = v(p, "operating_income");
  return op === null ? null : op + (v(p, "depreciation_amortization") ?? 0);
}

// The compound annual rate between the newest and oldest of a newest-first
// series, over the years between their period ends.
export function cagr(series: Array<{ periodEnd: string; value: number | null }>): number | null {
  const known = series.filter((s) => s.value !== null) as Array<{ periodEnd: string; value: number }>;
  if (known.length < 2) return null;
  const newest = known[0];
  const oldest = known[known.length - 1];
  const years = (Date.parse(newest.periodEnd) - Date.parse(oldest.periodEnd)) / (365.25 * 86_400_000);
  if (years < 0.5 || oldest.value <= 0 || newest.value <= 0) return null;
  return (newest.value / oldest.value) ** (1 / years) - 1;
}

const isFinancial = (sector: string | null) => sector === "Financials";

/* ------------------------------------------------------- scenario arithmetic */

export interface Scenario {
  name: "pessimistic" | "normal" | "optimistic";
  growth: number;
  value: number;
  vsMarketCap: number | null;
}

export interface Scenarios {
  fcfBase: number;
  fcfYears: number;
  discountRate: number;
  discountBasis: string;
  terminalGrowth: number;
  scenarios: Scenario[];
  impliedGrowth: number | null;
  historicalGrowth: number | null;
}

// Ten years of free cash flow growing at `growth`, then growing at the terminal
// rate forever, all discounted at `rate`. Free cash flow after interest is cash
// to shareholders, so the result compares with market capitalisation directly.
export function dcfValue(fcf0: number, growth: number, rate: number, years: number = T.dcfYears, terminal: number = T.terminalGrowth): number {
  let value = 0;
  let cash = fcf0;
  for (let t = 1; t <= years; t++) {
    cash *= 1 + growth;
    value += cash / (1 + rate) ** t;
  }
  const tv = (cash * (1 + terminal)) / (rate - terminal);
  return value + tv / (1 + rate) ** years;
}

// The ten-year growth rate at which dcfValue equals the market capitalisation:
// what the price assumes. Found by bisection; null when no rate in range fits.
export function impliedGrowth(fcf0: number, marketCap: number, rate: number): number | null {
  if (!(fcf0 > 0) || !(marketCap > 0)) return null;
  let lo = -0.3;
  let hi = 0.6;
  if (dcfValue(fcf0, lo, rate) > marketCap || dcfValue(fcf0, hi, rate) < marketCap) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dcfValue(fcf0, mid, rate) < marketCap) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function scenarioSet(input: ChecklistInput): Scenarios | null {
  const recent = input.periods.slice(0, 3).map(fcf).filter((x): x is number => x !== null);
  if (recent.length === 0) return null;
  // Normalised: the average of up to three years, so one unusual year does not
  // set the whole valuation.
  const fcfBase = recent.reduce((s, x) => s + x, 0) / recent.length;
  if (!(fcfBase > 0)) return null;

  const tenYear = input.macro.tenYear;
  const discountRate = tenYear !== null ? tenYear / 100 + T.equityRiskPremium : T.fallbackDiscount;
  const discountBasis =
    tenYear !== null
      ? `10-year Treasury ${tenYear.toFixed(2)}% + ${pct(T.equityRiskPremium, 0)} equity risk premium`
      : `${pct(T.fallbackDiscount, 0)} (no Treasury yield stored)`;

  const historicalGrowth = cagr(input.periods.map((p) => ({ periodEnd: p.periodEnd, value: v(p, "revenue") })));
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const g = historicalGrowth ?? 0.06;
  const growths: Array<[Scenario["name"], number]> = [
    ["pessimistic", 0],
    ["normal", clamp(g / 2, 0, 0.1)],
    ["optimistic", clamp(g, 0.02, 0.2)],
  ];

  const cap = input.marketCap;
  return {
    fcfBase,
    fcfYears: recent.length,
    discountRate,
    discountBasis,
    terminalGrowth: T.terminalGrowth,
    scenarios: growths.map(([name, growth]) => {
      const value = dcfValue(fcfBase, growth, discountRate);
      return { name, growth, value, vsMarketCap: cap ? value / cap - 1 : null };
    }),
    impliedGrowth: cap ? impliedGrowth(fcfBase, cap, discountRate) : null,
    historicalGrowth,
  };
}

// The loss the checklist plans for on a single stock: at least half, more if
// the stock's own last year says so — its worst fall from a peak, or a
// two-standard-deviation year at its volatility (prices compound, so that is
// 1 − e^(−2σ), not 2σ).
export function stressLoss(volatility: number | null, maxDrawdown: number | null): number {
  const fromVol = volatility === null ? 0 : Math.min(T.stressLossCap, 1 - Math.exp(-2 * volatility));
  const fromDrawdown = maxDrawdown === null ? 0 : Math.abs(maxDrawdown);
  return Math.max(T.stressLossFloor, fromVol, fromDrawdown);
}

// What a loss takes to undo: a 50% fall needs a 100% gain.
export const recoveryNeeded = (loss: number) => loss / (1 - loss);

/* ------------------------------------------------------------------- items */

type Draft = Omit<ChecklistItem, "group" | "category" | "question" | "guide" | "personal">;

interface Spec {
  id: string;
  group: Group;
  category: string;
  question: string;
  guide: string;
  personal?: boolean;
  run: (input: ChecklistInput, ctx: Context) => Draft;
}

interface Context {
  scenarios: Scenarios | null;
  stress: number;
  latest: PeriodIn | undefined;
  base: string;
  listing: string;
  size: number | null;
  denominator: number | null;
}

const item = (status: Status, finding: string, facts: Fact[] = [], gaps: string[] = []): Draft => ({ id: "", status, finding, facts, gaps });

const NO_FILINGS = "No annual filings are stored for this company — run npm run ingest-edgar.";

const SPECS: Spec[] = [
  /* ------------------------------------------------------------- the person */
  {
    id: "financial_readiness",
    group: "You",
    category: "Financial readiness",
    question: "Can I afford to invest this money?",
    guide: "§1A",
    personal: true,
    run: ({ profile }, { base, size }) => {
      const facts: Fact[] = [];
      if (profile.highInterestDebt !== null) facts.push({ label: "High-interest debt", value: money(profile.highInterestDebt, base) });
      if (profile.investableAmount !== null) facts.push({ label: "Money available to invest", value: money(profile.investableAmount, base) });
      if (profile.highInterestDebt === null || profile.investableAmount === null) {
        return item("input", "Add your high-interest debt and the money you have available to invest on your profile.", facts);
      }
      if (profile.highInterestDebt > 0) {
        return item(
          "fail",
          `You carry ${money(profile.highInterestDebt, base)} of high-interest debt. Paying it off is a guaranteed return at its interest rate, which few stocks match after risk.`,
          facts
        );
      }
      if (size !== null && size > profile.investableAmount) {
        return item("fail", `The planned position (${money(size, base)}) is more than the money you said is available to invest.`, facts);
      }
      return item("pass", "No high-interest debt, and the planned position fits within the money you set aside to invest.", facts);
    },
  },
  {
    id: "emergency_savings",
    group: "You",
    category: "Emergency savings",
    question: "Do I have sufficient accessible savings?",
    guide: "§1A",
    personal: true,
    run: ({ profile }, { base }) => {
      if (profile.emergencyFund === null || profile.monthlyExpenses === null) {
        return item("input", "Add your monthly expenses and accessible emergency savings on your profile.");
      }
      const months = profile.monthlyExpenses > 0 ? profile.emergencyFund / profile.monthlyExpenses : Infinity;
      const facts = [
        { label: "Emergency savings", value: money(profile.emergencyFund, base) },
        { label: "Monthly expenses", value: money(profile.monthlyExpenses, base) },
        { label: "Months covered", value: Number.isFinite(months) ? months.toFixed(1) : "—" },
      ];
      if (months < T.emergencyMonthsMin) {
        return item(
          "fail",
          `Your savings cover ${months.toFixed(1)} months of expenses, under the ${T.emergencyMonthsMin}-month minimum. Without a cushion, a job loss or a large bill can force you to sell during a market fall.`,
          facts
        );
      }
      return item(
        "pass",
        months >= T.emergencyMonthsGood
          ? `Your savings cover ${months.toFixed(1)} months of expenses.`
          : `Your savings cover ${months.toFixed(1)} months — above the ${T.emergencyMonthsMin}-month minimum, short of ${T.emergencyMonthsGood}.`,
        facts
      );
    },
  },
  {
    id: "objective",
    group: "You",
    category: "Objective",
    question: "Why am I investing?",
    guide: "§1B",
    personal: true,
    run: ({ profile, dividendsLastYear }) => {
      const o = profile.objective;
      if (o === null) return item("input", "Choose what this money is for on your profile.");
      const facts = [{ label: "Objective", value: o }];
      if (o === "emergency" || o === "car") {
        return item(
          "fail",
          `Money for ${o === "emergency" ? "emergencies" : "a car"} is needed soon and must be there when it is. That calls for savings or short-term GICs, not a single stock.`,
          facts
        );
      }
      if (o === "house") {
        return item("caution", "Money for a house is often needed within a few years; a single stock can be down when you need to buy.", facts);
      }
      if (o === "income") {
        return dividendsLastYear > 0
          ? item("pass", `The company paid ${dividendsLastYear} dividend${dividendsLastYear === 1 ? "" : "s"} in the last year, which fits an income objective.`, facts)
          : item("caution", "Your objective is income, and no dividend with an ex-date in the last year is stored for this company.", facts);
      }
      return item("pass", `Building ${o === "retirement" ? "retirement savings" : "long-term wealth"} suits owning businesses through market cycles.`, facts);
    },
  },
  {
    id: "horizon",
    group: "You",
    category: "Investment horizon",
    question: "When will I need the money?",
    guide: "§1B",
    personal: true,
    run: ({ profile }) => {
      const h = profile.horizonYears;
      if (h === null) return item("input", "Add when you will need this money on your profile.");
      const facts = [{ label: "Horizon", value: `${h} years` }];
      if (h < T.horizonFail) {
        return item("fail", `You need the money in ${h} years. A single stock can stay below what you paid for longer than that.`, facts);
      }
      if (h < T.horizonCaution) {
        return item("caution", `${h} years is short for a single stock; past bear markets have taken several years to recover.`, facts);
      }
      return item("pass", `A ${h}-year horizon leaves time to sit through declines rather than sell into them.`, facts);
    },
  },
  {
    id: "risk_capacity",
    group: "You",
    category: "Risk capacity",
    question: "How much could I afford to lose?",
    guide: "§9",
    personal: true,
    run: ({ profile, price }, { stress }) => {
      const facts: Fact[] = [{ label: "Loss to plan for", value: `${pct(stress, 0)} (needs +${pct(recoveryNeeded(stress), 0)} to recover)` }];
      if (price?.maxDrawdown != null) facts.push({ label: "Worst fall from a peak, 1 year", value: pct(price.maxDrawdown) });
      if (price?.volatility != null) facts.push({ label: "Volatility, annualised", value: pct(price.volatility) });
      if (profile.maxLossShare === null) {
        return item("input", "Add on your profile what share of this money you could lose without derailing your goal.", facts);
      }
      facts.unshift({ label: "You could lose", value: pct(profile.maxLossShare, 0) });
      const nervous = profile.riskTolerance === "low" && price?.volatility != null && price.volatility > 0.35;
      if (profile.maxLossShare >= stress) {
        return nervous
          ? item("caution", `You can afford a ${pct(stress, 0)} fall, but you rated your tolerance low and this stock swings ${pct(price!.volatility!, 0)} a year — the risk of selling in a panic is real.`, facts)
          : item("pass", `You could lose ${pct(profile.maxLossShare, 0)}, at least the ${pct(stress, 0)} fall this checklist plans for on one stock.`, facts);
      }
      if (profile.maxLossShare >= stress * 0.6) {
        return item("caution", `You could lose ${pct(profile.maxLossShare, 0)}; a single stock should be planned around a ${pct(stress, 0)} fall. Consider a smaller position.`, facts);
      }
      return item("fail", `You could lose ${pct(profile.maxLossShare, 0)}, well short of the ${pct(stress, 0)} fall a single stock can deliver.`, facts);
    },
  },
  {
    id: "knowledge",
    group: "You",
    category: "Investment knowledge",
    question: "Do I understand what I'm buying?",
    guide: "§3A, §15",
    run: ({ thesis }) => {
      if (thesis?.rationale && thesis.rationale.trim().length >= T.rationaleMinChars) {
        return item("pass", "You have written down why this investment is attractive in an open thesis.", [{ label: "Your thesis", value: thesis.rationale.slice(0, 160) }], [
          "The desk cannot test your understanding — reread the thesis: could you explain how the company makes money to someone else?",
        ]);
      }
      return item(
        "input",
        "Write down how the company makes money and why you find it attractive (open a thesis). If you cannot explain the business, do not buy it."
      );
    },
  },

  /* ----------------------------------------------------------- the business */
  {
    id: "business_quality",
    group: "The business",
    category: "Business quality",
    question: "Does the company have a sustainable business model?",
    guide: "§3A",
    run: ({ periods }) => {
      if (periods.length < 2) return item("missing", periods.length === 0 ? NO_FILINGS : "Only one annual period is stored; durability needs at least two.");
      const revDown = periods.slice(0, -1).filter((p, i) => {
        const a = v(p, "revenue");
        const b = v(periods[i + 1], "revenue");
        return a !== null && b !== null && a < b;
      }).length;
      const fcfs = periods.map(fcf).filter((x): x is number => x !== null);
      const ops = periods.map((p) => div(v(p, "operating_income"), v(p, "revenue"))).filter((x): x is number => x !== null);
      const facts = [
        { label: "Years with falling revenue", value: `${revDown} of ${periods.length - 1}` },
        { label: "Years with positive free cash flow", value: `${fcfs.filter((x) => x > 0).length} of ${fcfs.length}` },
        { label: "Years with an operating profit", value: `${ops.filter((x) => x > 0).length} of ${ops.length}` },
      ];
      const gaps = ["Customer concentration, segment mix and what customers would switch to are in the 10-K (Item 1 and 1A), not in the desk's figures."];
      const latestOp = ops[0];
      const latestFcf = fcfs[0];
      if (latestOp !== undefined && latestOp < 0 && latestFcf !== undefined && latestFcf < 0) {
        return item("fail", "The business lost money on its operations and burned cash in the latest year.", facts, gaps);
      }
      if (revDown === 0 && fcfs.length > 0 && fcfs.every((x) => x > 0) && ops.length > 0 && ops.every((x) => x > 0)) {
        return item("pass", "Revenue never fell, and every year was profitable and cash-generative.", facts, gaps);
      }
      return item("caution", "The record is uneven: revenue fell, or a year lost money or burned cash.", facts, gaps);
    },
  },
  {
    id: "growth",
    group: "The business",
    category: "Growth",
    question: "Can revenue and earnings grow sustainably?",
    guide: "§3B",
    run: ({ periods }) => {
      if (periods.length < 2) return item("missing", periods.length === 0 ? NO_FILINGS : "Growth needs at least two annual periods.");
      const revCagr = cagr(periods.map((p) => ({ periodEnd: p.periodEnd, value: v(p, "revenue") })));
      const eps = periods.map((p) => ({ periodEnd: p.periodEnd, value: div(v(p, "net_income"), v(p, "shares_diluted")) }));
      const epsCagr = cagr(eps);
      const g0 = d(periods[0], "revenue_growth");
      const g1 = periods[1] ? d(periods[1], "revenue_growth") : null;
      const marginTrend = d(periods[0], "operating_margin_trend");
      const down = periods.slice(0, -1).some((p, i) => {
        const a = v(p, "revenue");
        const b = v(periods[i + 1], "revenue");
        return a !== null && b !== null && a < b;
      });

      const facts: Fact[] = [];
      if (revCagr !== null) facts.push({ label: `Revenue growth a year, ${periods.length - 1}y`, value: pct(revCagr) });
      if (g0 !== null) facts.push({ label: "Revenue growth, latest year", value: pct(g0) });
      if (g1 !== null) facts.push({ label: "Revenue growth, year before", value: pct(g1) });
      if (epsCagr !== null) facts.push({ label: "Earnings per share growth a year", value: pct(epsCagr) });
      if (marginTrend !== null) facts.push({ label: "Operating margin change, latest year", value: `${(marginTrend * 100).toFixed(1)} pts` });
      const gaps = ["Whether growth came from customers or from acquisitions is not separable in the reported totals."];

      if (revCagr === null) return item("missing", "Revenue is not reported consistently enough to measure growth.", facts, gaps);
      const notes: string[] = [];
      if (g0 !== null && g1 !== null) {
        if (g0 >= 0) notes.push(g0 > g1 ? "growth is accelerating" : "growth is slowing");
        else notes.push(g0 > g1 ? "the decline is easing" : "the decline is deepening");
      }
      if (marginTrend !== null && marginTrend < T.marginTrendDrop && (g0 ?? 0) > 0) notes.push("costs are rising faster than revenue");
      const tail = notes.length ? ` — ${notes.join("; ")}` : "";

      if (revCagr < 0) return item("fail", `Revenue has shrunk ${pct(-revCagr)} a year${tail}.`, facts, gaps);
      if (revCagr >= T.growthGood && !down && !(marginTrend !== null && marginTrend < T.marginTrendDrop)) {
        return item("pass", `Revenue has grown ${pct(revCagr)} a year without a down year${tail}.`, facts, gaps);
      }
      return item("caution", `Revenue has grown ${pct(revCagr)} a year${down ? ", with a down year" : ""}${tail}.`, facts, gaps);
    },
  },
  {
    id: "profitability",
    group: "The business",
    category: "Profitability",
    question: "Does the company generate attractive profits?",
    guide: "§3C",
    run: ({ sector }, { latest }) => {
      if (!latest) return item("missing", NO_FILINGS);
      const revenue = v(latest, "revenue");
      const gm = div(grossProfit(latest), revenue);
      const om = div(v(latest, "operating_income"), revenue);
      const nm = div(v(latest, "net_income"), revenue);
      const roe = div(v(latest, "net_income"), v(latest, "total_equity"));
      const roic = d(latest, "roic");
      const facts: Fact[] = [];
      if (gm !== null) facts.push({ label: "Gross margin", value: pct(gm) });
      if (om !== null) facts.push({ label: "Operating margin", value: pct(om) });
      if (nm !== null) facts.push({ label: "Net margin", value: pct(nm) });
      if (roe !== null) facts.push({ label: "Return on equity", value: pct(roe) });
      if (roic !== null) facts.push({ label: "Return on invested capital", value: pct(roic) });
      const gaps = isFinancial(sector) ? ["Margins and ROIC read differently for banks and insurers; judge them on return on equity and credit costs instead."] : [];

      const ni = v(latest, "net_income");
      if (ni === null || om === null) return item("missing", "Net income or operating income is not reported for the latest year.", facts, gaps);
      if (ni <= 0) return item("fail", `The company lost ${money(-ni, "USD")} in the latest year.`, facts, gaps);
      if (om >= T.opMarginGood && roic !== null && roic >= T.roicGood) {
        return item("pass", `Operating margin of ${pct(om)} and a ${pct(roic)} return on invested capital.`, facts, gaps);
      }
      return item("caution", `Profitable, but below the bar of a ${pct(T.opMarginGood, 0)} operating margin and ${pct(T.roicGood, 0)} return on capital.`, facts, gaps);
    },
  },
  {
    id: "cash_flow",
    group: "The business",
    category: "Cash flow",
    question: "Does it generate sufficient cash?",
    guide: "§4B",
    run: ({ periods }, { latest }) => {
      if (!latest) return item("missing", NO_FILINGS);
      const f = fcf(latest);
      const ni = v(latest, "net_income");
      if (f === null) return item("missing", "Operating cash flow is not reported for the latest year.");
      const all = periods.map(fcf).filter((x): x is number => x !== null);
      const conversion = ni !== null && ni > 0 ? f / ni : null;
      const facts: Fact[] = [
        { label: "Free cash flow, latest year", value: money(f, "USD") },
        { label: "Years with positive free cash flow", value: `${all.filter((x) => x > 0).length} of ${all.length}` },
      ];
      if (conversion !== null) facts.push({ label: "Free cash flow / net income", value: pct(conversion, 0) });
      const oldest = periods[periods.length - 1];
      const profitsUpCashDown =
        periods.length >= 2 && ni !== null && v(oldest, "net_income") !== null && fcf(oldest) !== null &&
        ni > (v(oldest, "net_income") as number) && f < (fcf(oldest) as number);
      if (profitsUpCashDown) facts.push({ label: "Warning", value: "profits rose while free cash flow fell" });

      if (f < 0) return item("fail", `The company burned ${money(-f, "USD")} of free cash in the latest year. Check how it is funded.`, facts);
      if (all.every((x) => x > 0) && (conversion === null || conversion >= T.cashConversionGood) && !profitsUpCashDown) {
        return item("pass", `Free cash flow was positive every year${conversion !== null ? ` and ${pct(conversion, 0)} of net income turned into cash` : ""}.`, facts);
      }
      return item(
        "caution",
        profitsUpCashDown
          ? "Reported profits rose while free cash flow fell — the gap between earnings and cash deserves a look."
          : conversion !== null && conversion < T.cashConversionGood
            ? `Only ${pct(conversion, 0)} of net income became free cash flow.`
            : "Free cash flow was negative in an earlier year.",
        facts
      );
    },
  },
  {
    id: "financial_stability",
    group: "The business",
    category: "Financial stability",
    question: "Are its debt obligations manageable?",
    guide: "§4A",
    run: ({ periods, sector }, { latest }) => {
      if (!latest) return item("missing", NO_FILINGS);
      const totalDebt = debt(latest);
      const cash = cashAndInvestments(latest);
      const e = ebitda(latest);
      const op = v(latest, "operating_income");
      const interest = v(latest, "interest_expense");
      const gp = grossProfit(latest);
      const revenue = v(latest, "revenue");
      const facts: Fact[] = [];
      const gaps: string[] = [];
      if (isFinancial(sector)) gaps.push("Debt ratios are not comparable for banks and insurers; check the CET1 ratio, non-performing loans and deposit funding in the filings.");
      if (totalDebt === null || cash === null) return item("missing", "Debt or cash is not reported for the latest year.", facts, gaps);

      const netDebt = totalDebt - cash;
      facts.push({ label: "Net debt", value: netDebt <= 0 ? `net cash ${money(-netDebt, "USD")}` : money(netDebt, "USD") });
      const leverage = e !== null && e > 0 ? netDebt / e : null;
      if (leverage !== null) facts.push({ label: "Net debt / EBITDA", value: mult(leverage) });

      const coverage = op !== null && interest !== null && interest !== 0 ? op / Math.abs(interest) : null;
      if (coverage !== null) facts.push({ label: "Interest coverage (operating income / interest)", value: mult(coverage) });
      else if (totalDebt > 0) gaps.push("Interest expense is not stored (re-run ingest-edgar to pick it up), so coverage could not be measured.");

      // The guide's question, taken literally: revenue down 30% with costs
      // other than the cost of sales unchanged, so the whole fall in gross
      // profit comes out of operating income.
      // Whatever operating income no longer covers — interest, or an outright
      // operating loss — has to come out of cash; two years of it is the bar.
      let stressCovered: boolean | null = null;
      if (op !== null && gp !== null && revenue !== null) {
        const stressed = op - T.revenueShock * gp;
        facts.push({ label: `Operating income if revenue fell ${pct(T.revenueShock, 0)}`, value: money(stressed, "USD") });
        const shortfall = Math.max(0, (interest !== null ? Math.abs(interest) : 0) - stressed);
        if (shortfall > 0) facts.push({ label: "Years cash would fund that shortfall", value: (cash / shortfall).toFixed(1) });
        stressCovered = netDebt <= 0 || shortfall === 0 || cash >= T.stressCashYears * shortfall;
      }

      const priorDebt = periods.length >= 2 ? debt(periods[periods.length - 1]) : null;
      const debtGrowth = priorDebt !== null && priorDebt > 0 ? totalDebt / priorDebt - 1 : null;
      if (debtGrowth !== null) facts.push({ label: `Debt change over ${periods.length - 1}y`, value: pct(debtGrowth, 0) });
      const currentShare = totalDebt > 0 ? (v(latest, "current_debt") ?? 0) / totalDebt : 0;
      if (currentShare > 0) facts.push({ label: "Debt due within a year", value: pct(currentShare, 0) });

      const flags: string[] = [];
      if (debtGrowth !== null && debtGrowth > T.debtGrowthCaution) flags.push(`debt rose ${pct(debtGrowth, 0)}`);
      if (currentShare > T.currentDebtShareCaution) flags.push(`${pct(currentShare, 0)} of debt falls due within a year`);

      if ((leverage !== null && leverage > T.netDebtEbitdaBad) || (coverage !== null && coverage < T.coverageBad) || stressCovered === false) {
        const why = stressCovered === false ? `if revenue fell ${pct(T.revenueShock, 0)}, neither operating income nor ${T.stressCashYears} years of cash would cover the interest` :leverage !== null && leverage > T.netDebtEbitdaBad ? `net debt is ${mult(leverage)} EBITDA` : `operating income covers interest only ${mult(coverage!)}`;
        return item("fail", `The balance sheet is stretched: ${why}.`, facts, gaps);
      }
      const solid = (netDebt <= 0 || (leverage !== null && leverage <= T.netDebtEbitdaGood)) && (totalDebt === 0 || coverage === null || coverage >= T.coverageGood);
      if (solid && flags.length === 0) {
        return item("pass", netDebt <= 0 ? "The company holds more cash than debt." : `Net debt is ${mult(leverage!)} EBITDA${coverage !== null ? ` and interest is covered ${mult(coverage)}` : ""}.`, facts, gaps);
      }
      return item("caution", `Debt is manageable but worth watching${flags.length ? `: ${flags.join("; ")}` : ""}.`, facts, gaps);
    },
  },
  {
    id: "management",
    group: "The business",
    category: "Management",
    question: "Is leadership competent and trustworthy?",
    guide: "§7",
    run: ({ periods }, { latest }) => {
      const gaps = [
        "Insider buying and selling (Form 4), executive pay (proxy statement) and management's track record are not in the desk's data.",
      ];
      if (periods.length < 2) return item("missing", "Capital allocation needs at least two annual periods to judge.", [], gaps);
      const shares = cagr(periods.map((p) => ({ periodEnd: p.periodEnd, value: v(p, "shares_diluted") })));
      const roicNow = d(latest, "roic");
      const roicThen = d(periods[periods.length - 1], "roic");
      const facts: Fact[] = [];
      if (shares !== null) facts.push({ label: "Share count change a year", value: `${shares >= 0 ? "+" : ""}${pct(shares)}` });
      if (roicNow !== null && roicThen !== null) facts.push({ label: "Return on capital, oldest → latest", value: `${pct(roicThen)} → ${pct(roicNow)}` });
      const paid = v(latest, "dividends_paid");
      const f = latest ? fcf(latest) : null;
      if (paid !== null && f !== null && f > 0) facts.push({ label: "Dividends paid / free cash flow", value: pct(Math.abs(paid) / f, 0) });

      if (shares === null) return item("missing", "Diluted share counts are not reported consistently enough to measure dilution.", facts, gaps);
      if (shares > T.dilutionBad) return item("fail", `Shares outstanding grow ${pct(shares)} a year — each owner's slice keeps shrinking.`, facts, gaps);
      if (shares > T.dilutionGood) return item("caution", `Modest dilution of ${pct(shares)} a year.`, facts, gaps);
      return item("pass", shares < 0 ? `The share count is falling ${pct(-shares)} a year — buybacks are returning capital.` : "No meaningful dilution of shareholders.", facts, gaps);
    },
  },
  {
    id: "competitive_advantage",
    group: "The business",
    category: "Competitive advantage",
    question: "What protects the business from competitors?",
    guide: "§6",
    run: ({ periods, percentiles }) => {
      const gaps = [
        "Brand, network effects, switching costs and patents are judgements, not figures — convene the committee for its competitive-position view.",
        "These are signs a moat may exist, not proof of one.",
      ];
      if (periods.length === 0) return item("missing", NO_FILINGS, [], gaps);
      const roics = periods.map((p) => d(p, "roic")).filter((x): x is number => x !== null);
      const gms = periods.map((p) => div(grossProfit(p), v(p, "revenue"))).filter((x): x is number => x !== null);
      const facts: Fact[] = [];
      if (roics.length) facts.push({ label: "Return on capital, lowest year", value: pct(Math.min(...roics)) });
      if (gms.length) facts.push({ label: "Gross margin range", value: `${pct(Math.min(...gms))} – ${pct(Math.max(...gms))}` });
      if (percentiles.roic !== undefined) facts.push({ label: "Return on capital vs sector", value: `${Math.round(percentiles.roic * 100)}th percentile` });
      if (percentiles.gross_margin !== undefined) facts.push({ label: "Gross margin vs sector", value: `${Math.round(percentiles.gross_margin * 100)}th percentile` });
      if (roics.length === 0) return item("missing", "Return on invested capital cannot be computed from the stored figures.", facts, gaps);

      const stable = gms.length >= 2 && Math.max(...gms) - Math.min(...gms) <= T.grossMarginStable;
      if (Math.min(...roics) >= T.roicMoat && (gms.length < 2 || stable)) {
        return item("pass", `Returns on capital stayed at or above ${pct(T.roicMoat, 0)} every year${stable ? " with steady gross margins" : ""} — competitors have not competed the profits away.`, facts, gaps);
      }
      if (Math.max(...roics) < T.roicPoor) {
        return item("fail", `Returns on capital never reached ${pct(T.roicPoor, 0)} — no sign that anything protects the profits.`, facts, gaps);
      }
      return item("caution", "Some signs of an advantage, but returns or margins have not held steady.", facts, gaps);
    },
  },
  {
    id: "verifiability",
    group: "The business",
    category: "Verifiability",
    question: "Can the company's figures be independently verified?",
    guide: "§16",
    run: ({ cik, latestAnnualFiling, today }) => {
      if (!cik) {
        return item("caution", "The company is not an SEC filer in the desk's data. A Canadian issuer's disclosures are on SEDAR+; verify them there before investing.");
      }
      if (!latestAnnualFiling) return item("missing", "No annual report is stored yet — run npm run ingest-edgar.", [{ label: "SEC CIK", value: cik }]);
      const age = (Date.parse(today) - Date.parse(latestAnnualFiling.filedAt)) / 86_400_000;
      const facts = [
        { label: "SEC CIK", value: cik },
        { label: "Latest annual report", value: `${latestAnnualFiling.form}, filed ${latestAnnualFiling.filedAt}` },
      ];
      if (age > T.filingFreshDays) return item("caution", `The latest annual report is ${Math.round(age)} days old — a late filing can be a warning sign, or the desk's data is stale.`, facts);
      return item("pass", "The company files audited annual reports with the SEC, and the latest is current.", facts);
    },
  },

  /* -------------------------------------------------------------- the price */
  {
    id: "valuation",
    group: "The price",
    category: "Valuation",
    question: "Is the investment reasonably priced?",
    guide: "§5",
    run: ({ marketCap, percentiles }, { scenarios: s, latest }) => {
      const facts: Fact[] = [];
      const gaps = ["The stock's own historical multiples are not computed; compare with its past valuation before buying."];
      if (marketCap === null) return item("missing", "The market capitalisation could not be computed (no price or no share count).", facts, gaps);
      facts.push({ label: "Market capitalisation", value: money(marketCap, "USD") });

      const ni = latest ? v(latest, "net_income") : null;
      const rev = latest ? v(latest, "revenue") : null;
      if (ni !== null && ni > 0) facts.push({ label: "Price / earnings", value: mult(marketCap / ni) });
      if (rev !== null && rev > 0) facts.push({ label: "Price / sales", value: mult(marketCap / rev) });
      if (percentiles.ev_to_ebitda !== undefined) facts.push({ label: "EV/EBITDA vs sector (100 = cheapest)", value: `${Math.round(percentiles.ev_to_ebitda * 100)}th percentile` });
      if (percentiles.p_to_fcf !== undefined) facts.push({ label: "Price/FCF vs sector (100 = cheapest)", value: `${Math.round(percentiles.p_to_fcf * 100)}th percentile` });

      if (!s) {
        return item("caution", "Free cash flow is not positive, so the price cannot be tested against the cash the business produces; it rests on future growth alone.", facts, gaps);
      }
      facts.push({ label: "Price / normalised free cash flow", value: mult(marketCap / s.fcfBase) });
      if (s.impliedGrowth !== null) facts.push({ label: "Growth the price assumes, 10 years", value: pct(s.impliedGrowth) });
      if (s.historicalGrowth !== null) facts.push({ label: "Revenue growth achieved", value: pct(s.historicalGrowth) });
      for (const sc of s.scenarios) {
        facts.push({ label: `Value if FCF grows ${pct(sc.growth, 0)} (${sc.name})`, value: `${money(sc.value, "USD")}${sc.vsMarketCap !== null ? ` (${sc.vsMarketCap >= 0 ? "+" : ""}${pct(sc.vsMarketCap, 0)})` : ""}` });
      }

      const [, normal, optimistic] = s.scenarios;
      const assumes = s.impliedGrowth !== null ? ` The price assumes ${pct(s.impliedGrowth)} a year of cash-flow growth for a decade` : "";
      const achieved = s.historicalGrowth !== null ? `; revenue has grown ${pct(s.historicalGrowth)} a year.` : ".";
      if (marketCap <= normal.value) return item("pass", `The price is at or below the normal-case value.${assumes}${achieved}`, facts, gaps);
      if (marketCap > optimistic.value) return item("fail", `The price is above even the optimistic case.${assumes}${achieved} If growth disappoints, there is far to fall.`, facts, gaps);
      return item("caution", `The price sits between the normal and optimistic cases — it needs growth to come through.${assumes}${achieved}`, facts, gaps);
    },
  },

  /* ------------------------------------------------------------ the economy */
  {
    id: "macro",
    group: "The economy",
    category: "Macroeconomics",
    question: "How could economic conditions affect it?",
    guide: "§8",
    run: ({ macro, marketCap, baseCurrency }, { latest, scenarios }) => {
      const facts: Fact[] = [];
      if (macro.tenYear !== null) facts.push({ label: "10-year Treasury yield", value: `${macro.tenYear.toFixed(2)}%` });
      if (macro.curve !== null) facts.push({ label: "10y − 2y spread", value: `${macro.curve.toFixed(2)} pts` });
      if (macro.cpiYoy !== null) facts.push({ label: "US inflation, year over year", value: pct(macro.cpiYoy) });
      if (macro.unemployment !== null) facts.push({ label: "US unemployment", value: `${macro.unemployment.toFixed(1)}%${macro.unemploymentYearAgo !== null ? ` (a year ago ${macro.unemploymentYearAgo.toFixed(1)}%)` : ""}` });
      const gaps = ["Markets move ahead of the data; no single indicator predicts the stock market."];
      if (baseCurrency === "CAD") gaps.push("Canadian rates and inflation (Bank of Canada) are not in the desk's data.");
      if (facts.length === 0) return item("missing", "No macro series are stored — run npm run ingest-fred.", facts, gaps);

      const flags: string[] = [];
      if (macro.curve !== null && macro.curve < 0) flags.push("the yield curve is inverted, which has often preceded recessions");
      if (macro.cpiYoy !== null && macro.cpiYoy > T.inflationHigh) flags.push(`inflation is ${pct(macro.cpiYoy)}, so ask whether the company can raise prices`);
      if (macro.unemployment !== null && macro.unemploymentYearAgo !== null && macro.unemployment - macro.unemploymentYearAgo >= T.unemploymentRise) {
        flags.push("unemployment is rising, a sign the economy is weakening");
      }
      const e = latest ? ebitda(latest) : null;
      const td = latest ? debt(latest) : null;
      const cash = latest ? cashAndInvestments(latest) : null;
      if (macro.tenYear !== null && macro.tenYear >= T.ratesHigh && e !== null && e > 0 && td !== null && cash !== null && (td - cash) / e > 2) {
        flags.push("rates are high and the company carries meaningful debt, so refinancing will cost more");
      }
      if (macro.tenYear !== null && macro.tenYear >= T.ratesHigh && scenarios && marketCap && marketCap / scenarios.fcfBase > 35) {
        flags.push("the valuation leans on profits far in the future, which high rates discount most");
      }
      if (flags.length === 0) return item("pass", "No macro warning sign stands out against this company's debt and valuation.", facts, gaps);
      return item("caution", `${flags[0][0].toUpperCase()}${flags[0].slice(1)}${flags.length > 1 ? `; ${flags.slice(1).join("; ")}` : ""}.`, facts, gaps);
    },
  },

  /* ---------------------------------------------------------- the portfolio */
  {
    id: "diversification",
    group: "Your portfolio",
    category: "Diversification",
    question: "Am I becoming too concentrated?",
    guide: "§10",
    run: ({ portfolio, sector, profile }, { size, denominator, base }) => {
      if (size === null || denominator === null || denominator <= 0) {
        return item("input", "Add the size of the position you are considering on your profile, so its weight in your portfolio can be measured.");
      }
      // With nothing in the ledger, the portfolio is only knowable from the
      // money set aside to invest; without it, the position would always
      // look like the whole portfolio.
      if (portfolio.value === 0 && profile.investableAmount === null) {
        return item("input", "Nothing is recorded in your ledger. Add the money you have available to invest on your profile, so this position's share of it can be measured.");
      }
      const weight = (portfolio.held + size) / denominator;
      const sectorWeight = (portfolio.sameSector + size) / denominator;
      const facts = [
        { label: "Position after buying", value: `${money(portfolio.held + size, base)} · ${pct(weight)} of the portfolio` },
        { label: `${sector ?? "Unclassified"} after buying`, value: pct(sectorWeight) },
        { label: "Positions held now", value: String(portfolio.positions) },
      ];
      const gaps = ["Correlation with what you already hold is on the Risk page — try this ticker in a what-if basket there."];
      if (weight > T.positionBad) return item("fail", `This one stock would be ${pct(weight, 0)} of your portfolio — a bad year for it would be a bad year for you.`, facts, gaps);
      if (weight > T.positionGood || sectorWeight > T.sectorCaution) {
        return item("caution", weight > T.positionGood ? `The position would be ${pct(weight, 0)} of the portfolio, above ${pct(T.positionGood, 0)}.` : `${pct(sectorWeight, 0)} of the portfolio would sit in ${sector ?? "one sector"}.`, facts, gaps);
      }
      return item("pass", `The position would be ${pct(weight)} of the portfolio and ${pct(sectorWeight, 0)} would sit in its sector.`, facts, gaps);
    },
  },
  {
    id: "currency",
    group: "Your portfolio",
    category: "Currency",
    question: "What exchange-rate risks exist?",
    guide: "§9, §11C",
    run: ({ listingCurrency, baseCurrency }) => {
      const facts = [
        { label: "Stock trades in", value: listingCurrency },
        { label: "You report in", value: baseCurrency },
      ];
      if (listingCurrency === baseCurrency) return item("pass", "The stock trades in your own currency; no exchange-rate risk on the price.", facts, ["The company's own revenue may still be earned in other currencies."]);
      return item(
        "caution",
        `Your return in ${baseCurrency} depends on ${listingCurrency}/${baseCurrency} as well as the stock: a ${listingCurrency} that weakens 10% takes about 10% off your result. Converting costs a spread each way.`,
        facts
      );
    },
  },
  {
    id: "liquidity",
    group: "Your portfolio",
    category: "Liquidity",
    question: "Can I access my money when necessary?",
    guide: "§9",
    run: ({ price, listingCurrency }, { size, base }) => {
      if (!price?.avgDollarVolume) return item("missing", "Trading volume could not be loaded for this stock.");
      const adv = price.avgDollarVolume;
      const facts = [{ label: "Average traded per day, 20 days", value: money(adv, listingCurrency) }];
      const days = size !== null ? size / (adv * T.participation) : null;
      if (days !== null) facts.push({ label: `Days to sell your position at ${pct(T.participation, 0)} of volume`, value: days < 0.01 ? "under 0.01" : days.toFixed(2) });
      const gaps = listingCurrency !== base ? ["Days to exit compare your position in your currency with volume in the listing currency, so they are approximate."] : [];
      if (adv < T.advMin) return item("fail", `Only ${money(adv, listingCurrency)} trades a day — selling quickly at a fair price may not be possible.`, facts, gaps);
      if (days !== null && days > 1) return item("caution", `Selling your whole position would take about ${days.toFixed(1)} days without moving the price.`, facts, gaps);
      return item("pass", "The stock trades heavily enough to sell your position in a day.", facts, gaps);
    },
  },

  /* ------------------------------------------------------ costs and safety */
  {
    id: "fees",
    group: "Costs and safety",
    category: "Fees",
    question: "What will I pay to invest and maintain the position?",
    guide: "§12A",
    run: ({ profile }, { size, base }) => {
      if (profile.tradingCostShare === null) {
        return item("input", "Add your broker's commission plus any currency-conversion spread, as a share of the trade, on your profile.");
      }
      const roundTrip = 2 * profile.tradingCostShare;
      const facts = [{ label: "Cost to buy and later sell", value: pct(roundTrip, 2) }];
      if (size !== null) facts.push({ label: "In money, on this position", value: money(size * roundTrip, base) });
      const gaps = ["A stock has no management expense ratio, but the bid-ask spread is an extra cost the desk does not measure."];
      if (roundTrip > T.roundTripCostBad) return item("fail", `Buying and selling would cost ${pct(roundTrip, 2)} — a hurdle the stock must clear before you make anything.`, facts, gaps);
      if (roundTrip > T.roundTripCostGood) return item("caution", `A ${pct(roundTrip, 2)} round trip is noticeable; avoid trading in and out.`, facts, gaps);
      return item("pass", `A ${pct(roundTrip, 2)} round trip is a small cost.`, facts, gaps);
    },
  },
  {
    id: "taxes",
    group: "Costs and safety",
    category: "Taxes",
    question: "Am I using an appropriate account?",
    guide: "§12B",
    run: ({ profile, listingCurrency, dividendsLastYear }, { size, base }) => {
      const a = profile.accountType;
      if (a === null) return item("input", "Choose the account you would buy in (TFSA, RRSP, FHSA, non-registered) on your profile.");
      const labels: Record<string, string> = { tfsa: "TFSA", rrsp: "RRSP", fhsa: "FHSA", non_registered: "non-registered account", other: "other account" };
      const facts: Fact[] = [{ label: "Account", value: labels[a] }];
      if (profile.contributionRoom !== null) facts.push({ label: "Contribution room", value: money(profile.contributionRoom, base) });
      const usDividends = listingCurrency === "USD" && dividendsLastYear > 0;

      if (a === "tfsa" || a === "rrsp" || a === "fhsa") {
        if (size !== null && profile.contributionRoom !== null && size > profile.contributionRoom) {
          return item("fail", `The position (${money(size, base)}) is more than your ${labels[a]} room. Over-contributions are taxed every month they stay in.`, facts);
        }
        const notes: string[] = [];
        if (profile.contributionRoom === null) notes.push(`confirm your available ${labels[a]} room with CRA before contributing`);
        if (usDividends && a !== "rrsp") notes.push(`US dividends lose a withholding tax in a ${labels[a]} that cannot be recovered (an RRSP is generally exempt under the tax treaty)`);
        if (notes.length) return item("caution", `${notes[0][0].toUpperCase()}${notes[0].slice(1)}${notes.length > 1 ? `; ${notes.slice(1).join("; ")}` : ""}.`, facts);
        return item("pass", a === "rrsp" ? "An RRSP defers tax on growth; withdrawals are taxed as income." : `Growth and qualifying withdrawals in a ${labels[a]} are generally tax-free.`, facts);
      }
      if (a === "non_registered") {
        return item("caution", "Dividends and capital gains are taxable here. Use registered room first if you have it, and keep records of your adjusted cost base.", facts);
      }
      return item("caution", "The desk does not know how this account is taxed — check before buying.", facts);
    },
  },
  {
    id: "institution",
    group: "Costs and safety",
    category: "Institution safety",
    question: "Is the provider regulated and appropriately protected?",
    guide: "§11",
    personal: true,
    run: ({ profile }) => {
      const facts: Fact[] = [];
      if (profile.institution) facts.push({ label: "Broker", value: profile.institution });
      const gaps = [
        "CIPF protects eligible property if a member firm fails; it does not protect against the stock falling. CDIC covers deposits, never stocks.",
      ];
      if (profile.institutionVerified === null) {
        return item("input", "Name your broker on your profile and confirm you checked its registration (CSA National Registration Search, CIRO member).", facts, gaps);
      }
      if (!profile.institutionVerified) {
        return item("fail", "You have not confirmed your broker is registered. Do not send money to an unregistered firm.", facts, gaps);
      }
      return item("pass", "You confirmed your broker is registered with Canadian regulators.", facts, gaps);
    },
  },

  /* ---------------------------------------------------------------- the plan */
  {
    id: "exit_strategy",
    group: "Your plan",
    category: "Exit strategy",
    question: "When and why would I sell?",
    guide: "§14, §15",
    run: ({ thesis }) => {
      if (!thesis) {
        return item("input", "Open a thesis with at least one rule that would prove you wrong (for example: operating margin below 15%). The desk will check it against every new filing.");
      }
      const facts = [{ label: "Rules on your thesis", value: String(thesis.rules) }];
      if (thesis.breached) return item("fail", "A rule on your thesis is already breached — the evidence you said would prove you wrong is here.", facts);
      if (thesis.rules === 0) return item("caution", "Your thesis has no rule saying what would prove it wrong. Add one so a decline can be told apart from a broken business.", facts);
      return item("pass", "Your thesis says what would prove it wrong, and the desk checks it against each filing.", facts);
    },
  },
  {
    id: "downside",
    group: "Your plan",
    category: "Downside scenario",
    question: "What could happen if my assumptions are wrong?",
    guide: "§5, §9",
    personal: true,
    run: ({ profile }, { stress, size, base, scenarios }) => {
      const facts: Fact[] = [];
      const bear = scenarios?.scenarios.find((s) => s.name === "pessimistic");
      if (bear?.vsMarketCap != null) facts.push({ label: "Pessimistic-case value vs today's price", value: `${bear.vsMarketCap >= 0 ? "+" : ""}${pct(bear.vsMarketCap, 0)}` });
      if (size === null) return item("input", "Add the size of the position you are considering on your profile.", facts);
      const loss = size * stress;
      facts.unshift({ label: `A ${pct(stress, 0)} fall would cost`, value: money(loss, base) });
      const affordable = profile.maxLossShare !== null && profile.investableAmount !== null ? profile.maxLossShare * profile.investableAmount : null;
      if (affordable !== null) facts.push({ label: "The loss you said you could absorb", value: money(affordable, base) });

      if (affordable !== null && loss > affordable) {
        return item("fail", `A ${pct(stress, 0)} fall would cost ${money(loss, base)}, more than the ${money(affordable, base)} you said you could lose. Make the position smaller.`, facts);
      }
      if (bear?.vsMarketCap != null && bear.vsMarketCap + 1 < T.bearValueGap) {
        return item("caution", `If the cash flow simply stopped growing, the business would be worth ${pct(-bear.vsMarketCap, 0)} less than today's price.`, facts);
      }
      if (affordable === null) return item("input", `A ${pct(stress, 0)} fall would cost ${money(loss, base)}. Add what you could afford to lose to compare.`, facts);
      return item("pass", `Even a ${pct(stress, 0)} fall (${money(loss, base)}) is within the loss you said you could absorb.`, facts);
    },
  },
];

export const CHECKLIST_IDS = SPECS.map((s) => s.id);

/* ------------------------------------------------------------------ verdict */

export function verdictOf(items: ChecklistItem[]): Verdict {
  const counts: Record<Status, number> = { pass: 0, caution: 0, fail: 0, missing: 0, input: 0 };
  for (const i of items) counts[i.status]++;
  const blocking = items.filter((i) => i.personal && i.status === "fail").map((i) => i.category);
  const unverified = items.filter((i) => i.status === "missing" || i.status === "input").map((i) => i.category);
  const risks = items.filter((i) => !i.personal && i.status === "fail").map((i) => i.category);

  let level: VerdictLevel;
  let headline: string;
  if (blocking.length > 0) {
    level = "not_ready";
    headline = `Not ready to buy: ${blocking.join(", ").toLowerCase()} ${blocking.length === 1 ? "fails" : "fail"} — this is about your situation, not the stock.`;
  } else if (unverified.length > 0) {
    level = "incomplete";
    headline = `Checklist incomplete: ${unverified.length} of ${items.length} questions are not yet answered${risks.length ? `, and ${risks.length} material ${risks.length === 1 ? "risk was" : "risks were"} found` : ""}.`;
  } else if (risks.length > 0) {
    level = "material_risks";
    headline = `Material risks: ${risks.join(", ").toLowerCase()}. Understand them before committing money.`;
  } else if (counts.caution > 0) {
    level = "caution";
    headline = `Every question is answered and nothing fails; ${counts.caution} ${counts.caution === 1 ? "point needs" : "points need"} care.`;
  } else {
    level = "ready";
    headline = "Every question on the checklist passes.";
  }
  return { level, headline, counts, blocking, unverified, risks };
}

/* -------------------------------------------------------------------- run */

export function evaluateChecklist(input: ChecklistInput): Checklist {
  const scenarios = scenarioSet(input);
  const size = input.profile.positionSize;
  const extra = size === null ? null : Math.max(size, input.profile.investableAmount ?? 0);
  const ctx: Context = {
    scenarios,
    stress: stressLoss(input.price?.volatility ?? null, input.price?.maxDrawdown ?? null),
    latest: input.periods[0],
    base: input.baseCurrency,
    listing: input.listingCurrency,
    size,
    // the portfolio after the money set aside to invest goes in, of which this
    // position is a part
    denominator: extra === null ? null : input.portfolio.value + extra,
  };

  const items = SPECS.map((spec): ChecklistItem => {
    const draft = spec.run(input, ctx);
    return {
      ...draft,
      id: spec.id,
      group: spec.group,
      category: spec.category,
      question: spec.question,
      guide: spec.guide,
      personal: spec.personal === true,
    };
  });

  const sources = [
    input.periods.length ? `annual filings (XBRL), fiscal years ending ${input.periods.map((p) => p.periodEnd).join(", ")}` : null,
    input.price ? `${input.price.source}, last close ${input.price.asOf}` : null,
    input.macro.asOf ? `FRED macro series to ${input.macro.asOf}` : null,
    "your investor profile",
    "your ledger and theses",
  ].filter((s): s is string => s !== null);

  return {
    ticker: input.ticker,
    name: input.name,
    asOf: input.today,
    baseCurrency: input.baseCurrency,
    listingCurrency: input.listingCurrency,
    positionSize: size,
    verdict: verdictOf(items),
    items,
    scenarios,
    sources,
  };
}
