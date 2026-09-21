import Decimal from "decimal.js";

export interface PeriodFacts {
  periodEnd: string;
  values: Map<string, Decimal>;
}

export interface MetricInputs {
  current: PeriodFacts;
  prior?: PeriodFacts;
  marketCap?: Decimal | null;
}

// "lower" metrics are cheaper-is-better, so their percentile gets inverted at ranking time.
export const DERIVED_METRICS: Record<string, "higher" | "lower"> = {
  revenue_growth: "higher",
  gross_margin: "higher",
  gross_margin_trend: "higher",
  operating_margin: "higher",
  operating_margin_trend: "higher",
  fcf_margin: "higher",
  roic: "higher",
  net_debt_to_ebitda: "lower",
  ev_to_ebitda: "lower",
  p_to_fcf: "lower",
};

const ZERO = new Decimal(0);
const DEFAULT_TAX_RATE = new Decimal("0.21");

function get(period: PeriodFacts, metric: string): Decimal | null {
  return period.values.get(metric) ?? null;
}

function ratio(numerator: Decimal | null, denominator: Decimal | null): Decimal | null {
  if (numerator === null || denominator === null || denominator.isZero()) return null;
  const result = numerator.div(denominator);
  return result.isFinite() ? result : null;
}

function grossProfit(period: PeriodFacts): Decimal | null {
  const reported = get(period, "gross_profit");
  if (reported) return reported;

  const revenue = get(period, "revenue");
  const cost = get(period, "cost_of_revenue");
  if (revenue === null || cost === null) return null;
  return revenue.sub(cost);
}

function freeCashFlow(period: PeriodFacts): Decimal | null {
  const ocf = get(period, "operating_cash_flow");
  if (ocf === null) return null;
  return ocf.sub(get(period, "capex") ?? ZERO);
}

function ebitda(period: PeriodFacts): Decimal | null {
  const operating = get(period, "operating_income");
  if (operating === null) return null;
  return operating.add(get(period, "depreciation_amortization") ?? ZERO);
}

// Filers split debt between current and long term and simply omit the side they
// don't carry, so a missing half counts as zero and only a missing whole is unknown.
// The ones that report a single combined balance instead are taken at their word,
// since adding the split tags on top of it would count the same debt twice.
function totalDebt(period: PeriodFacts): Decimal | null {
  const combined = get(period, "total_debt");
  if (combined) return combined;

  const longTerm = get(period, "long_term_debt");
  const current = get(period, "current_debt");
  if (longTerm === null && current === null) return null;
  return (longTerm ?? ZERO).add(current ?? ZERO);
}

function cashAndInvestments(period: PeriodFacts): Decimal | null {
  const cash = get(period, "cash_and_equivalents");
  if (cash === null) return null;
  return cash.add(get(period, "short_term_investments") ?? ZERO);
}

function netDebt(period: PeriodFacts): Decimal | null {
  const debt = totalDebt(period);
  const cash = cashAndInvestments(period);
  if (debt === null || cash === null) return null;
  return debt.sub(cash);
}

function grossMargin(period: PeriodFacts): Decimal | null {
  return ratio(grossProfit(period), get(period, "revenue"));
}

function operatingMargin(period: PeriodFacts): Decimal | null {
  return ratio(get(period, "operating_income"), get(period, "revenue"));
}

function effectiveTaxRate(period: PeriodFacts): Decimal {
  const rate = ratio(get(period, "income_tax"), get(period, "pretax_income"));
  if (rate === null || rate.lt(0) || rate.gt("0.5")) return DEFAULT_TAX_RATE;
  return rate;
}

function roic(period: PeriodFacts): Decimal | null {
  const operating = get(period, "operating_income");
  const equity = get(period, "total_equity");
  const debt = totalDebt(period);
  const cash = cashAndInvestments(period);
  if (operating === null || equity === null || debt === null || cash === null) return null;

  const investedCapital = debt.add(equity).sub(cash);
  if (investedCapital.lte(0)) return null;

  const nopat = operating.mul(new Decimal(1).sub(effectiveTaxRate(period)));
  return ratio(nopat, investedCapital);
}

function delta(current: Decimal | null, prior: Decimal | null): Decimal | null {
  if (current === null || prior === null) return null;
  return current.sub(prior);
}

// Anything that can't be computed from stored facts is left out rather than
// defaulted, so a gap stays visible as a gap all the way to the UI.
export function deriveMetrics({ current, prior, marketCap }: MetricInputs): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  const set = (name: string, value: Decimal | null) => {
    if (value !== null && value.isFinite()) out.set(name, value);
  };

  const revenue = get(current, "revenue");

  if (prior) {
    const priorRevenue = get(prior, "revenue");
    if (revenue !== null && priorRevenue !== null && priorRevenue.gt(0)) {
      set("revenue_growth", revenue.sub(priorRevenue).div(priorRevenue));
    }
    set("gross_margin_trend", delta(grossMargin(current), grossMargin(prior)));
    set("operating_margin_trend", delta(operatingMargin(current), operatingMargin(prior)));
  }

  set("gross_margin", grossMargin(current));
  set("operating_margin", operatingMargin(current));
  set("fcf_margin", ratio(freeCashFlow(current), revenue));
  set("roic", roic(current));

  const periodEbitda = ebitda(current);
  const debtNetOfCash = netDebt(current);

  if (periodEbitda !== null && periodEbitda.gt(0) && debtNetOfCash !== null) {
    set("net_debt_to_ebitda", debtNetOfCash.div(periodEbitda));
  }

  if (marketCap && marketCap.gt(0)) {
    if (periodEbitda !== null && periodEbitda.gt(0) && debtNetOfCash !== null) {
      set("ev_to_ebitda", marketCap.add(debtNetOfCash).div(periodEbitda));
    }
    const fcf = freeCashFlow(current);
    if (fcf !== null && fcf.gt(0)) {
      set("p_to_fcf", marketCap.div(fcf));
    }
  }

  return out;
}
