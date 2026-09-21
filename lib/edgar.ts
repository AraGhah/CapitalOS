// XBRL tags vary by filer and by year, so each metric lists the tags it accepts
// in priority order — the first tag with data for a period wins.
const METRIC_TAGS: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ],
  cost_of_revenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  pretax_income: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  income_tax: ["IncomeTaxExpenseBenefit"],
  operating_cash_flow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  depreciation_amortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
    "Depreciation",
  ],
  cash_and_equivalents: ["CashAndCashEquivalentsAtCarryingValue"],
  short_term_investments: [
    "ShortTermInvestments",
    "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  ],
  // Filers that report one combined balance rather than splitting it by maturity.
  total_debt: ["DebtLongtermAndShorttermCombinedAmount"],
  long_term_debt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  current_debt: ["DebtCurrent", "LongTermDebtCurrent", "ShortTermBorrowings"],
  total_assets: ["Assets"],
  total_equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  shares_diluted: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
};

const SHARE_METRICS = new Set(["shares_diluted"]);

export type FiscalPeriod = "FY" | "Q";

export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, XbrlFact[]> }>>;
}

export interface ParsedFact {
  metric: string;
  periodEnd: string;
  fiscalPeriod: FiscalPeriod;
  value: number;
  accession: string;
  form: string;
  filedAt: string;
}

const DAY_MS = 86400000;

function spanInDays(fact: XbrlFact): number | null {
  if (!fact.start) return null;
  return (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
}

function isPeriodicReport(form: string): boolean {
  return form.startsWith("10-K") || form.startsWith("10-Q");
}

function tagFacts(facts: CompanyFacts, tag: string, unit: string): XbrlFact[] {
  const entry = facts.facts?.["us-gaap"]?.[tag];
  return entry?.units?.[unit] ?? [];
}

// A 10-K restates two prior years alongside the current one, and the fy/fp fields
// on each fact describe the filing rather than the fact, so the period is taken
// from the dates instead: a year-long span is annual, a quarter-long span is not.
// Balance sheet facts carry no span, so they inherit the period from whether their
// date lines up with a fiscal year end seen in the duration facts.
export function parseFacts(facts: CompanyFacts): ParsedFact[] {
  const annualEnds = new Set<string>();
  for (const tags of Object.values(METRIC_TAGS)) {
    for (const tag of tags) {
      for (const fact of tagFacts(facts, tag, "USD")) {
        const span = spanInDays(fact);
        if (span !== null && span >= 330 && span <= 400) annualEnds.add(fact.end);
      }
    }
  }

  const parsed: ParsedFact[] = [];

  for (const [metric, tags] of Object.entries(METRIC_TAGS)) {
    const unit = SHARE_METRICS.has(metric) ? "shares" : "USD";
    const claimed = new Set<string>();

    for (const tag of tags) {
      for (const fact of tagFacts(facts, tag, unit)) {
        if (!isPeriodicReport(fact.form)) continue;

        const span = spanInDays(fact);
        let fiscalPeriod: FiscalPeriod;
        if (span === null) {
          fiscalPeriod = annualEnds.has(fact.end) ? "FY" : "Q";
        } else if (span >= 330 && span <= 400) {
          fiscalPeriod = "FY";
        } else if (span >= 80 && span <= 100) {
          fiscalPeriod = "Q";
        } else {
          continue;
        }

        const key = `${fact.end}|${fiscalPeriod}|${fact.accn}`;
        if (claimed.has(key)) continue;
        claimed.add(key);

        parsed.push({
          metric,
          periodEnd: fact.end,
          fiscalPeriod,
          value: fact.val,
          accession: fact.accn,
          form: fact.form,
          filedAt: fact.filed,
        });
      }
    }
  }

  return parsed;
}

export function filingUrl(cik: number, accession: string): string {
  const stripped = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${stripped}/${accession}-index.htm`;
}

export function padCik(cik: number | string): string {
  return String(cik).padStart(10, "0");
}

// Ordered narrowest-first: the first range a SIC code falls into wins, so the
// specific tech and health ranges take precedence over the broad SIC divisions.
const SECTOR_RANGES: Array<[number, number, string]> = [
  [2833, 2836, "Health Care"],
  [3841, 3851, "Health Care"],
  [8000, 8099, "Health Care"],
  [3570, 3579, "Technology"],
  [3660, 3679, "Technology"],
  [7370, 7379, "Technology"],
  [4810, 4899, "Communications"],
  [2800, 2899, "Materials"],
  [1311, 1389, "Energy"],
  [2911, 2999, "Energy"],
  [4900, 4991, "Utilities"],
  [6000, 6799, "Financials"],
  [100, 999, "Agriculture"],
  [1000, 1499, "Mining"],
  [1500, 1799, "Construction"],
  [2000, 3999, "Manufacturing"],
  [4000, 4799, "Transportation"],
  [5000, 5199, "Wholesale Trade"],
  [5200, 5999, "Retail Trade"],
  [7000, 8999, "Services"],
];

export function sectorForSic(sic: string | number | null | undefined): string | null {
  const code = Number(sic);
  if (!Number.isFinite(code) || code === 0) return null;

  for (const [low, high, sector] of SECTOR_RANGES) {
    if (code >= low && code <= high) return sector;
  }
  return null;
}
