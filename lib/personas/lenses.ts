import { T } from "../checklist";
import { figuresOf, type Figures, type PersonaInput, type Year } from "./figures";

/* ---------------------------------------------------------------------------
   Investor lenses: eight well-known investors' published tests, run by code.

   virattt/ai-hedge-fund has a model play each investor and write a verdict.
   Here each investor is a table of checks over the company's own figures:
   a bar, the value measured against it, and pass, partial, fail or missing
   (the desk does not have the data). The same company always gets the same
   result, every bar is printed beside its value, and the part of each investor's
   judgement that is not a number (a moat, a manager's candour) is listed as not
   measured instead of being guessed. No model is called and nothing is forecast:
   the only forward-looking figure is the checklist's own "what does the price
   assume" calculation.

   A lens is a way of looking, not advice. It never changes the checklist, the
   committee's rating or the decision.

   Pure: the company's figures go in, a report comes out.
--------------------------------------------------------------------------- */

export type CheckStatus = "pass" | "partial" | "fail" | "missing";
export type Fit = "fits" | "mixed" | "does_not_fit" | "unscored";
export type LensId = "graham" | "buffett" | "munger" | "lynch" | "fisher" | "burry" | "wood" | "damodaran";

export const LENS_RULES = {
  // the share of a lens's measured weight at or above which it fits, and at or below which it does not (ai-hedge-fund's 70% / 30%)
  fits: 0.7,
  doesNotFit: 0.3,
  // the share of a lens's weight that must be measurable before it gives a verdict
  minCoverage: 0.6,
  // credit for a check cleared in part
  partialCredit: 0.5,
  // fewer annual periods than this cannot show consistency
  minYears: 3,
  // "most years": four in five. "Half the years" is the line below which a record is called poor.
  most: 0.8,
  half: 0.5,
} as const;

export const FIT_LABEL: Record<Fit, string> = { fits: "Fits", mixed: "Mixed", does_not_fit: "Does not fit", unscored: "Not enough data" };

export interface CheckResult {
  status: CheckStatus;
  // the figure measured, as the page shows it; null when nothing could be measured
  value: string | null;
  note: string;
}

interface Check {
  id: string;
  label: string;
  weight: number;
  // the bar, in words, built from the constants the check tests against
  bar: string;
  run: (f: Figures) => CheckResult;
}

interface Lens {
  id: LensId;
  name: string;
  school: string;
  source: string;
  // how much of the investor's method the checks cover
  scope: string;
  checks: Check[];
  // what the investor judged that no figure on file answers
  notMeasured: string[];
}

/* ------------------------------------------------------------------ helpers */

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const times = (x: number) => `${x.toFixed(1)}x`;
const points = (x: number) => `${(x * 100).toFixed(1)} pts`;

const result = (status: CheckStatus, value: string | null, note: string): CheckResult => ({ status, value, note });
const missing = (note: string): CheckResult => result("missing", null, note);

const NO_PRICE = "No market price or share count is stored, so the price cannot be tested.";
const BANK = "Banks and insurers report debt, margins and capital differently; this check is not scored for them.";

// How many years satisfy a test, out of those where the figure exists.
function tally(years: Year[], test: (y: Year) => boolean | null): { hit: number; known: number } {
  let hit = 0;
  let known = 0;
  for (const y of years) {
    const r = test(y);
    if (r === null) continue;
    known++;
    if (r) hit++;
  }
  return { hit, known };
}

// "In most years": pass at four in five, partial at half.
function byYears(f: Figures, test: (y: Year) => boolean | null, what: string): CheckResult {
  const { hit, known } = tally(f.years, test);
  if (known < LENS_RULES.minYears) return missing(`${what} needs ${LENS_RULES.minYears} years on file; ${known} found.`);
  const share = hit / known;
  const status: CheckStatus = share >= LENS_RULES.most ? "pass" : share >= LENS_RULES.half ? "partial" : "fail";
  return result(status, `${hit} of ${known} years`, `${what}: ${hit} of ${known} years.`);
}

// A figure where more is better: pass at `good`, partial at `ok`.
function higher(x: number | null, good: number, ok: number, show: (x: number) => string, what: string, unmeasured: string): CheckResult {
  if (x === null) return missing(unmeasured);
  return result(x >= good ? "pass" : x >= ok ? "partial" : "fail", show(x), `${what} is ${show(x)}.`);
}

// A figure where less is better: pass at `good`, partial at `ok`.
function lower(x: number | null, good: number, ok: number, show: (x: number) => string, what: string, unmeasured: string): CheckResult {
  if (x === null) return missing(unmeasured);
  return result(x <= good ? "pass" : x <= ok ? "partial" : "fail", show(x), `${what} is ${show(x)}.`);
}

// Net debt against EBITDA, shared by the lenses that want a clean balance sheet.
function leverage(good: number, ok: number): (f: Figures) => CheckResult {
  return (f) => {
    if (f.financial) return missing(BANK);
    const y = f.latest;
    if (!y || y.netDebt === null) return missing("Debt or cash is not reported for the latest year.");
    if (y.netDebt <= 0) return result("pass", "net cash", "The company holds more cash and investments than debt.");
    if (y.ebitda === null || y.ebitda <= 0) return result("fail", "no EBITDA", "The company has net debt and no positive operating earnings to service it.");
    return lower(y.netDebt / y.ebitda, good, ok, times, "Net debt over EBITDA", "");
  };
}

function dilution(f: Figures): CheckResult {
  if (f.shareChange === null) {
    return missing("Diluted share counts are missing, or every pair of years straddles a split, so dilution cannot be measured.");
  }
  const x = f.shareChange;
  const show = (n: number) => `${n >= 0 ? "+" : "−"}${pct(Math.abs(n))} a year`;
  const status: CheckStatus = x <= T.dilutionGood ? "pass" : x <= T.dilutionBad ? "partial" : "fail";
  return result(status, show(x), x < 0 ? `The share count is falling ${pct(-x)} a year: buybacks.` : `Shares change ${show(x)}.`);
}

const dilutionBar = `shares growing no faster than ${pct(T.dilutionGood, 0)} a year (fail above ${pct(T.dilutionBad, 0)})`;

/* ------------------------------------------------------------------- Graham */

const GRAHAM = { growth: 0.03, debtToEquity: [0.5, 1], pe: 15, pb: 1.5, product: 22.5, productPartial: 40 } as const;

const graham: Lens = {
  id: "graham",
  name: "Benjamin Graham",
  school: "Defensive value",
  source: "The Intelligent Investor",
  scope: "Graham's tests for the defensive investor that the filings answer: stable earnings, a dividend record, earnings growth, modest debt and a moderate price. Size and the current ratio are not tested.",
  checks: [
    {
      id: "earnings_record",
      label: "Profit in every year",
      weight: 2,
      bar: "a profit in every year on file; all but one is partial",
      run: (f) => {
        const { hit, known } = tally(f.years, (y) => (y.netIncome === null ? null : y.netIncome > 0));
        if (known < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years of net income; ${known} found.`);
        return result(hit === known ? "pass" : hit === known - 1 ? "partial" : "fail", `${hit} of ${known} years`, `Net income was positive in ${hit} of ${known} years.`);
      },
    },
    {
      id: "dividend_record",
      label: "A dividend every year",
      weight: 1,
      bar: "cash dividends in every year on file; half the years is partial",
      run: (f) => {
        if (f.years.length < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years on file; ${f.years.length} found.`);
        const paid = f.years.filter((y) => (y.dividends ?? 0) > 0).length;
        const n = f.years.length;
        const note = paid === 0 ? "No dividend payment appears in the filings." : `Dividends were paid in ${paid} of ${n} years.`;
        return result(paid === n ? "pass" : paid >= n / 2 ? "partial" : "fail", `${paid} of ${n} years`, note);
      },
    },
    {
      id: "earnings_growth",
      label: "Earnings growth",
      weight: 1,
      bar: `net income growing at least ${pct(GRAHAM.growth)} a year (a third over ten)`,
      run: (f) => {
        if (f.incomeCagr === null) return missing("Net income growth cannot be measured: a loss in the first or last year, or fewer than two years.");
        const g = f.incomeCagr;
        return result(g >= GRAHAM.growth ? "pass" : g > 0 ? "partial" : "fail", `${pct(g)} a year`, `Net income has grown ${pct(g)} a year.`);
      },
    },
    {
      id: "leverage",
      label: "Debt against equity",
      weight: 1,
      bar: `debt at most ${GRAHAM.debtToEquity[0]}× equity (partial to ${GRAHAM.debtToEquity[1]}×); stands in for his current-ratio test`,
      run: (f) =>
        f.financial
          ? missing(BANK)
          : lower(f.debtToEquity, GRAHAM.debtToEquity[0], GRAHAM.debtToEquity[1], (x) => `${x.toFixed(2)}×`, "Debt over equity", "Debt or equity is not reported (or equity is not positive)."),
    },
    {
      id: "price",
      label: "Price against earnings and book",
      weight: 3,
      bar: `P/E ≤ ${GRAHAM.pe} and P/B ≤ ${GRAHAM.pb}, or P/E × P/B ≤ ${GRAHAM.product} (partial to ${GRAHAM.productPartial}); P/E on three years' average earnings`,
      run: (f) => {
        if (f.marketCap === null) return missing(NO_PRICE);
        if (f.averageIncome === null) return missing("Needs three years of net income to average.");
        if (f.peAverage === null) return result("fail", null, "The three-year average of earnings is not positive, so there is no earnings power to price.");
        if (f.pb === null) return missing("Book value is not positive, so P/B cannot be read.");
        const product = f.peAverage * f.pb;
        const value = `P/E ${f.peAverage.toFixed(1)} × P/B ${f.pb.toFixed(2)} = ${product.toFixed(1)}`;
        const clears = (f.peAverage <= GRAHAM.pe && f.pb <= GRAHAM.pb) || product <= GRAHAM.product;
        return result(clears ? "pass" : product <= GRAHAM.productPartial ? "partial" : "fail", value, `${value}.`);
      },
    },
  ],
  notMeasured: ["Company size", "Current assets against current liabilities and net current asset value (the desk does not store current assets)", "A dividend record longer than the years on file"],
};

/* ------------------------------------------------------------------ Buffett */

const BUFFETT = { roe: 0.15, margin: [0.15, 0.1], debtYears: [3, 5] } as const;

const buffett: Lens = {
  id: "buffett",
  name: "Warren Buffett",
  school: "A wonderful business at a fair price",
  source: "Berkshire Hathaway shareholder letters",
  scope: "The parts of Buffett's method that are numbers: return on equity, margins, debt, earnings that hold up, owner earnings, share count and the price against bonds. The moat and the management are judgements.",
  checks: [
    {
      id: "roe",
      label: "Return on equity",
      weight: 2,
      bar: `return on equity of ${pct(BUFFETT.roe, 0)} or more in at least four years in five`,
      run: (f) => byYears(f, (y) => (y.roe === null ? null : y.roe >= BUFFETT.roe), "Return on equity at the bar"),
    },
    {
      id: "margin",
      label: "Operating margin",
      weight: 1,
      bar: `operating margin of ${pct(BUFFETT.margin[0], 0)} or more (partial from ${pct(BUFFETT.margin[1], 0)})`,
      run: (f) => (f.financial ? missing(BANK) : higher(f.latest?.operatingMargin ?? null, BUFFETT.margin[0], BUFFETT.margin[1], pct, "The latest operating margin", "Operating income or revenue is not reported for the latest year.")),
    },
    {
      id: "debt",
      label: "Debt a few years of profit could repay",
      weight: 1,
      bar: `debt at most ${BUFFETT.debtYears[0]} years of net income (partial to ${BUFFETT.debtYears[1]})`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        const y = f.latest;
        if (!y || y.debt === null || y.netIncome === null) return missing("Debt or net income is not reported for the latest year.");
        if (y.debt <= 0) return result("pass", "no debt", "The company carries no debt.");
        if (y.netIncome <= 0) return result("fail", null, "The company has debt and no profit to repay it from.");
        return lower(y.debt / y.netIncome, BUFFETT.debtYears[0], BUFFETT.debtYears[1], (x) => `${x.toFixed(1)} years`, "Debt over net income", "");
      },
    },
    {
      id: "consistency",
      label: "Earnings that hold up",
      weight: 2,
      bar: "a profit every year and net income growing: both is a pass, profit every year alone is partial",
      run: (f) => {
        const { hit, known } = tally(f.years, (y) => (y.netIncome === null ? null : y.netIncome > 0));
        if (known < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years of net income; ${known} found.`);
        const value = `${hit} of ${known} profitable${f.incomeCagr === null ? "" : `, ${pct(f.incomeCagr)} a year`}`;
        if (hit < known) return result("fail", value, `The company lost money in ${known - hit} of ${known} years.`);
        return result(f.incomeCagr !== null && f.incomeCagr > 0 ? "pass" : "partial", value, "Profitable every year on file.");
      },
    },
    {
      id: "owner_earnings",
      label: "Owner earnings",
      weight: 1,
      bar: "net income + depreciation − capital spending positive in at least four years in five",
      run: (f) => byYears(f, (y) => (y.ownerEarnings === null ? null : y.ownerEarnings > 0), "Owner earnings were positive"),
    },
    {
      id: "dilution",
      label: "Shareholders not diluted",
      weight: 1,
      bar: dilutionBar,
      run: dilution,
    },
    {
      id: "price",
      label: "Owner earnings against a Treasury bond",
      weight: 2,
      bar: "owner earnings yield on the market value at least the 10-year Treasury yield (partial from half of it)",
      run: (f) => {
        if (f.marketCap === null) return missing(NO_PRICE);
        if (f.tenYear === null) return missing("No 10-year Treasury yield is stored to compare with.");
        if (f.ownerYield === null) return missing("Owner earnings need net income, depreciation and capital spending.");
        const bond = f.tenYear / 100;
        const value = `${pct(f.ownerYield)} against ${pct(bond)}`;
        return result(f.ownerYield >= bond ? "pass" : f.ownerYield >= bond / 2 ? "partial" : "fail", value, `Owner earnings yield ${value} on the 10-year Treasury.`);
      },
    },
  ],
  notMeasured: ["Whether the moat is real and where it comes from", "The honesty and ability of management", "Whether the business is simple enough to understand", "A price paid against a forecast of future earnings"],
};

/* ------------------------------------------------------------------- Munger */

const MUNGER = { roic: T.roicMoat, marginSpread: [T.grossMarginStable, 0.1], cash: [T.cashConversionGood, 0.5], leverage: [2, T.netDebtEbitdaBad], fcfYield: [0.05, 0.03] } as const;

const munger: Lens = {
  id: "munger",
  name: "Charlie Munger",
  school: "A great business at a fair price",
  source: "Poor Charlie's Almanack",
  scope: "Munger's quality tests that are numbers: returns on capital, steady margins, a predictable record, cash earnings, low debt, no dilution and a fair price. Pricing power, incentives and what could break the business are judgements.",
  checks: [
    {
      id: "roic",
      label: "Return on invested capital",
      weight: 2,
      bar: `return on invested capital of ${pct(MUNGER.roic, 0)} or more in at least four years in five`,
      run: (f) => (f.financial ? missing(BANK) : byYears(f, (y) => (y.roic === null ? null : y.roic >= MUNGER.roic), "Return on invested capital at the bar")),
    },
    {
      id: "pricing_power",
      label: "Gross margin that holds",
      weight: 1,
      bar: `gross margin within ${points(MUNGER.marginSpread[0])} between its best and worst year (partial to ${points(MUNGER.marginSpread[1])})`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        const margins = f.years.map((y) => y.grossMargin).filter((x): x is number => x !== null);
        if (margins.length < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years of gross margin; ${margins.length} found.`);
        const spread = Math.max(...margins) - Math.min(...margins);
        return lower(spread, MUNGER.marginSpread[0], MUNGER.marginSpread[1], points, "The gross margin spread", "");
      },
    },
    {
      id: "predictable",
      label: "A predictable record",
      weight: 1,
      bar: "revenue never down on the year before and an operating profit every year: one miss is partial",
      run: (f) => {
        const revenues = f.years.map((y) => y.revenue);
        if (revenues.filter((r) => r !== null).length < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years of revenue.`);
        let misses = 0;
        for (let i = 0; i < f.years.length - 1; i++) {
          const a = f.years[i].revenue;
          const b = f.years[i + 1].revenue;
          if (a !== null && b !== null && a < b) misses++;
        }
        for (const y of f.years) if (y.operatingIncome !== null && y.operatingIncome <= 0) misses++;
        return result(misses === 0 ? "pass" : misses === 1 ? "partial" : "fail", `${misses} ${misses === 1 ? "miss" : "misses"}`, misses === 0 ? "Revenue never fell and every year made an operating profit." : `${misses} down or loss years.`);
      },
    },
    {
      id: "cash_earnings",
      label: "Profits that turn into cash",
      weight: 1,
      bar: `free cash flow at least ${pct(MUNGER.cash[0], 0)} of net income over the years on file (partial from ${pct(MUNGER.cash[1], 0)})`,
      run: (f) => {
        const both = f.years.filter((y) => y.fcf !== null && y.netIncome !== null);
        if (both.length < LENS_RULES.minYears) return missing(`Needs ${LENS_RULES.minYears} years of cash flow and net income; ${both.length} found.`);
        const income = both.reduce((s, y) => s + (y.netIncome as number), 0);
        if (income <= 0) return result("fail", null, "Net income over the years on file is not positive.");
        const ratio = both.reduce((s, y) => s + (y.fcf as number), 0) / income;
        return higher(ratio, MUNGER.cash[0], MUNGER.cash[1], (x) => pct(x, 0), "Free cash flow over net income", "");
      },
    },
    {
      id: "leverage",
      label: "Little net debt",
      weight: 1,
      bar: `net debt at most ${MUNGER.leverage[0]}× EBITDA (partial to ${MUNGER.leverage[1]}×); net cash passes`,
      run: leverage(MUNGER.leverage[0], MUNGER.leverage[1]),
    },
    { id: "dilution", label: "Shareholders not diluted", weight: 1, bar: dilutionBar, run: dilution },
    {
      id: "price",
      label: "A fair price for the cash it makes",
      weight: 2,
      bar: `free cash flow (three-year average) at least ${pct(MUNGER.fcfYield[0], 0)} of the market value (partial from ${pct(MUNGER.fcfYield[1], 0)})`,
      run: (f) => {
        if (f.marketCap === null) return missing(NO_PRICE);
        if (f.fcfYield === null) return missing("Free cash flow is not reported.");
        return higher(f.fcfYield, MUNGER.fcfYield[0], MUNGER.fcfYield[1], pct, "The free cash flow yield", "");
      },
    },
  ],
  notMeasured: ["Whether pricing power is real", "How management is paid and whether its incentives match the owners'", "What could break the business (Munger's inversion)", "Whether the business stays inside its circle of competence"],
};

/* -------------------------------------------------------------------- Lynch */

const LYNCH = { growth: [0.1, 0.3, 0.05, 0.5], peg: [1, 2], debtToEquity: [0.5, 1] } as const;

function lynchCategory(g: number): string {
  if (g < 0) return "shrinking";
  if (g < 0.05) return "slow grower";
  if (g < 0.15) return "stalwart";
  if (g <= 0.5) return "fast grower";
  return "growth too fast to last";
}

const lynch: Lens = {
  id: "lynch",
  name: "Peter Lynch",
  school: "Growth at a reasonable price",
  source: "One Up on Wall Street",
  scope: "Lynch's numeric tests: the earnings growth rate and what kind of grower it makes the company, the PEG ratio, debt, free cash flow and whether sales drive the growth. The story, inventories and insider buying are not measured.",
  checks: [
    {
      id: "growth",
      label: "Earnings growth he can live with",
      weight: 2,
      bar: `net income growing ${pct(LYNCH.growth[0], 0)} to ${pct(LYNCH.growth[1], 0)} a year (partial from ${pct(LYNCH.growth[2], 0)} up to ${pct(LYNCH.growth[3], 0)})`,
      run: (f) => {
        const g = f.incomeCagr;
        if (g === null) return missing("Net income growth cannot be measured: a loss in the first or last year, or fewer than two years.");
        const [lo, hi, floor, ceiling] = LYNCH.growth;
        const status: CheckStatus = g >= lo && g <= hi ? "pass" : g >= floor && g <= ceiling ? "partial" : "fail";
        return result(status, `${pct(g)} a year`, `Net income has grown ${pct(g)} a year: a ${lynchCategory(g)}.`);
      },
    },
    {
      id: "peg",
      label: "PEG ratio",
      weight: 3,
      bar: `P/E divided by the growth rate in points at most ${LYNCH.peg[0]} (partial to ${LYNCH.peg[1]})`,
      run: (f) => {
        if (f.marketCap === null) return missing(NO_PRICE);
        const income = f.latest?.netIncome ?? null;
        if (income === null) return missing("Net income is not reported for the latest year.");
        if (income <= 0) return result("fail", null, "The company lost money in the latest year, so there is no P/E to set against growth.");
        if (f.incomeCagr === null) return missing("Net income growth cannot be measured, so the PEG cannot be formed.");
        if (f.incomeCagr <= 0 || f.pe === null) return result("fail", null, "Earnings are not growing, so there is no growth to pay a multiple for.");
        const peg = f.pe / (f.incomeCagr * 100);
        return lower(peg, LYNCH.peg[0], LYNCH.peg[1], (x) => x.toFixed(2), `The PEG (P/E ${f.pe.toFixed(1)} over ${pct(f.incomeCagr)} growth)`, "");
      },
    },
    {
      id: "debt",
      label: "Debt against equity",
      weight: 1,
      bar: `debt at most ${LYNCH.debtToEquity[0]}× equity (partial to ${LYNCH.debtToEquity[1]}×)`,
      run: (f) =>
        f.financial
          ? missing(BANK)
          : lower(f.debtToEquity, LYNCH.debtToEquity[0], LYNCH.debtToEquity[1], (x) => `${x.toFixed(2)}×`, "Debt over equity", "Debt or equity is not reported (or equity is not positive)."),
    },
    {
      id: "cash",
      label: "Free cash flow",
      weight: 1,
      bar: "free cash flow positive in the latest year and in at least four years in five; the latest year alone is partial",
      run: (f) => {
        const latest = f.latest?.fcf ?? null;
        if (latest === null) return missing("Operating cash flow is not reported for the latest year.");
        const { hit, known } = tally(f.years, (y) => (y.fcf === null ? null : y.fcf > 0));
        const value = `${hit} of ${known} years`;
        if (latest > 0 && hit / known >= LENS_RULES.most) return result("pass", value, "Free cash flow is positive now and in most years.");
        return result(latest > 0 ? "partial" : "fail", value, latest > 0 ? "Free cash flow is positive now but was not in several earlier years." : "Free cash flow is negative in the latest year.");
      },
    },
    {
      id: "sales_led",
      label: "Growth that comes from sales",
      weight: 1,
      bar: "revenue growing at least half as fast as net income, so profits are not just cost cuts; revenue growing at all is partial",
      run: (f) => {
        if (f.revenueCagr === null || f.incomeCagr === null) return missing("Revenue or net income growth cannot be measured.");
        if (f.incomeCagr <= 0) return missing("Earnings are not growing, so there is no growth to attribute to sales.");
        const value = `revenue ${pct(f.revenueCagr)}, earnings ${pct(f.incomeCagr)}`;
        return result(f.revenueCagr >= f.incomeCagr / 2 ? "pass" : f.revenueCagr > 0 ? "partial" : "fail", value, `Revenue grew ${pct(f.revenueCagr)} a year against ${pct(f.incomeCagr)} for earnings.`);
      },
    },
  ],
  notMeasured: ["What the company does and why it will keep winning (Lynch's two-minute story)", "Inventory building faster than sales", "Insider buying", "How many analysts cover it"],
};

/* ------------------------------------------------------------------- Fisher */

const FISHER = { growth: [0.1, 0.05], margin: [0.15, 0.08], marginSlip: T.marginTrendDrop } as const;

const fisher: Lens = {
  id: "fisher",
  name: "Philip Fisher",
  school: "Long-term growth, found by scuttlebutt",
  source: "Common Stocks and Uncommon Profits",
  scope: "The few of Fisher's fifteen points that are numbers: sales growth, margins, their direction, returns on capital and how growth is paid for. The rest come from talking to customers, suppliers and competitors.",
  checks: [
    {
      id: "sales_growth",
      label: "Sales growth",
      weight: 2,
      bar: `revenue growing at least ${pct(FISHER.growth[0], 0)} a year (partial from ${pct(FISHER.growth[1], 0)})`,
      run: (f) => higher(f.revenueCagr, FISHER.growth[0], FISHER.growth[1], pct, "Revenue growth a year", "Revenue growth cannot be measured: fewer than two years, or a non-positive figure."),
    },
    {
      id: "margins",
      label: "Operating margin",
      weight: 1,
      bar: `operating margin of ${pct(FISHER.margin[0], 0)} or more (partial from ${pct(FISHER.margin[1], 0)})`,
      run: (f) => (f.financial ? missing(BANK) : higher(f.latest?.operatingMargin ?? null, FISHER.margin[0], FISHER.margin[1], pct, "The latest operating margin", "Operating income or revenue is not reported for the latest year.")),
    },
    {
      id: "margin_direction",
      label: "Margin not eroding",
      weight: 1,
      bar: `the operating margin no lower than at the start of the record (partial within ${points(-FISHER.marginSlip)})`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        const margins = f.years.map((y) => y.operatingMargin);
        const newest = margins[0];
        const oldest = margins[margins.length - 1];
        if (f.years.length < LENS_RULES.minYears || newest === null || newest === undefined || oldest === null || oldest === undefined) {
          return missing(`Needs ${LENS_RULES.minYears} years of operating margin, newest and oldest included.`);
        }
        const change = newest - oldest;
        const value = `${change >= 0 ? "+" : "−"}${points(Math.abs(change))}`;
        return result(change >= 0 ? "pass" : change >= FISHER.marginSlip ? "partial" : "fail", value, `The operating margin moved ${value} over the record.`);
      },
    },
    {
      id: "returns",
      label: "Return on invested capital",
      weight: 1,
      bar: `return on invested capital of ${pct(T.roicGood, 0)} or more (partial from ${pct(T.roicPoor, 0)})`,
      run: (f) => (f.financial ? missing(BANK) : higher(f.latest?.roic ?? null, T.roicGood, T.roicPoor, pct, "The latest return on invested capital", "Return on invested capital cannot be computed for the latest year.")),
    },
    {
      id: "self_funded",
      label: "Growth paid for from within",
      weight: 1,
      bar: `free cash flow positive and ${dilutionBar}; one of the two is partial`,
      run: (f) => {
        const fcf = f.latest?.fcf ?? null;
        if (fcf === null) return missing("Operating cash flow is not reported for the latest year.");
        const clean = f.shareChange !== null && f.shareChange <= T.dilutionGood;
        const parts = [fcf > 0, clean].filter(Boolean).length;
        const note = `${fcf > 0 ? "Free cash flow is positive" : "Free cash flow is negative"}; ${f.shareChange === null ? "dilution could not be measured" : clean ? "shares are not being diluted" : "shares are being diluted"}.`;
        return result(parts === 2 ? "pass" : parts === 1 ? "partial" : "fail", `${parts} of 2`, note);
      },
    },
  ],
  notMeasured: ["Research and development spending against sales (the desk does not store it)", "The strength of the sales organisation", "Labour and executive relations", "Depth of management and the candour of its answers", "Most of the other points, which come from scuttlebutt"],
};

/* -------------------------------------------------------------------- Burry */

const BURRY = { fcfYield: [0.08, 0.05], evToEbit: [8, 12], leverage: [2, T.netDebtEbitdaBad], belowHigh: [0.3, 0.15] } as const;

const burry: Lens = {
  id: "burry",
  name: "Michael Burry",
  school: "Deep value",
  source: "Scion Capital investor letters",
  scope: "Burry's screen for cheap, cash-generating, unloved companies: free cash flow yield, EV to operating profit, a clean balance sheet, a price far below its high and real earnings. What he found by reading the filings line by line is not measured.",
  checks: [
    {
      id: "fcf_yield",
      label: "Free cash flow yield",
      weight: 3,
      bar: `free cash flow (three-year average) at least ${pct(BURRY.fcfYield[0], 0)} of the market value (partial from ${pct(BURRY.fcfYield[1], 0)})`,
      run: (f) => {
        if (f.marketCap === null) return missing(NO_PRICE);
        if (f.fcfYield === null) return missing("Free cash flow is not reported.");
        return higher(f.fcfYield, BURRY.fcfYield[0], BURRY.fcfYield[1], pct, "The free cash flow yield", "");
      },
    },
    {
      id: "ev_ebit",
      label: "Enterprise value to operating profit",
      weight: 2,
      bar: `EV / operating income at most ${BURRY.evToEbit[0]}× (partial to ${BURRY.evToEbit[1]}×)`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        if (f.marketCap === null) return missing(NO_PRICE);
        const y = f.latest;
        if (!y || y.operatingIncome === null) return missing("Operating income is not reported for the latest year.");
        if (y.operatingIncome <= 0) return result("fail", null, "The company made no operating profit in the latest year.");
        if (f.evToEbit === null) return missing("Debt or cash is not reported, so enterprise value cannot be formed.");
        return lower(f.evToEbit, BURRY.evToEbit[0], BURRY.evToEbit[1], times, "EV over operating income", "");
      },
    },
    {
      id: "balance_sheet",
      label: "A balance sheet that survives",
      weight: 2,
      bar: `net debt at most ${BURRY.leverage[0]}× EBITDA (partial to ${BURRY.leverage[1]}×); net cash passes`,
      run: leverage(BURRY.leverage[0], BURRY.leverage[1]),
    },
    {
      id: "out_of_favour",
      label: "Out of favour",
      weight: 1,
      bar: `the price at least ${pct(BURRY.belowHigh[0], 0)} below its 52-week high (partial from ${pct(BURRY.belowHigh[1], 0)})`,
      run: (f) => {
        const below = f.price?.belowHigh ?? null;
        if (below === null) return missing("No year of prices is stored to find the high.");
        return higher(-below, BURRY.belowHigh[0], BURRY.belowHigh[1], (x) => `${pct(x)} below the high`, "The price", "");
      },
    },
    {
      id: "earning",
      label: "Real earnings",
      weight: 1,
      bar: "a profit and positive free cash flow in the latest year; one of the two is partial",
      run: (f) => {
        const y = f.latest;
        if (!y || y.netIncome === null || y.fcf === null) return missing("Net income or cash flow is not reported for the latest year.");
        const parts = [y.netIncome > 0, y.fcf > 0].filter(Boolean).length;
        return result(parts === 2 ? "pass" : parts === 1 ? "partial" : "fail", `${parts} of 2`, `${y.netIncome > 0 ? "Profitable" : "Loss-making"}, with ${y.fcf > 0 ? "positive" : "negative"} free cash flow.`);
      },
    },
  ],
  notMeasured: ["Insider buying and short interest", "A specific catalyst that would end the discount", "Off-balance-sheet items and footnotes", "How hated the stock is in the news"],
};

/* --------------------------------------------------------------------- Wood */

const WOOD = { growth: [0.2, 0.1], grossMargin: [0.4, 0.25], leverageGain: 0.01 } as const;

const wood: Lens = {
  id: "wood",
  name: "Cathie Wood",
  school: "Disruptive innovation",
  source: "ARK Invest research",
  scope: "The numbers that betray a company riding a new technology: fast and accelerating revenue growth, software-like gross margins and operating leverage. R&D intensity, the size of the market and the technology's cost curve are not measured, and price is not part of the lens.",
  checks: [
    {
      id: "growth",
      label: "Revenue growth",
      weight: 3,
      bar: `revenue up at least ${pct(WOOD.growth[0], 0)} on the year before (partial from ${pct(WOOD.growth[1], 0)})`,
      run: (f) => higher(f.latest?.revenueGrowth ?? null, WOOD.growth[0], WOOD.growth[1], pct, "Revenue growth in the latest year", "Revenue growth cannot be computed: fewer than two years on file."),
    },
    {
      id: "accelerating",
      label: "Growth accelerating",
      weight: 1,
      bar: `growth this year above last year's (partial within ${points(0.02)} below)`,
      run: (f) => {
        const now = f.years[0]?.revenueGrowth ?? null;
        const before = f.years[1]?.revenueGrowth ?? null;
        if (now === null || before === null) return missing("Needs growth for two years, so three years of revenue.");
        const value = `${pct(now)} against ${pct(before)}`;
        return result(now > before ? "pass" : now >= before - 0.02 ? "partial" : "fail", value, `Growth was ${value} the year before.`);
      },
    },
    {
      id: "gross_margin",
      label: "Software-like gross margin",
      weight: 1,
      bar: `gross margin of ${pct(WOOD.grossMargin[0], 0)} or more (partial from ${pct(WOOD.grossMargin[1], 0)})`,
      run: (f) => (f.financial ? missing(BANK) : higher(f.latest?.grossMargin ?? null, WOOD.grossMargin[0], WOOD.grossMargin[1], pct, "The latest gross margin", "Gross profit is not reported for the latest year.")),
    },
    {
      id: "operating_leverage",
      label: "Operating leverage",
      weight: 1,
      bar: `operating margin up more than ${points(WOOD.leverageGain)} on the year before (partial if within ${points(WOOD.leverageGain)})`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        const change = f.latest?.operatingMarginChange ?? null;
        if (change === null) return missing("Needs two years of operating margin.");
        const value = `${change >= 0 ? "+" : "−"}${points(Math.abs(change))}`;
        return result(change > WOOD.leverageGain ? "pass" : change >= -WOOD.leverageGain ? "partial" : "fail", value, `The operating margin moved ${value} in the latest year.`);
      },
    },
  ],
  notMeasured: ["Research and development intensity (the desk does not store it)", "The size of the market the technology opens", "The technology's cost-decline curve", "Whether the company is a leader in its platform", "Price: ARK's own return forecasts are not reproduced because this desk does not forecast prices"],
};

/* ---------------------------------------------------------------- Damodaran */

const DAMODARAN = { spread: 0.03, slack: 0.03 } as const;

const damodaran: Lens = {
  id: "damodaran",
  name: "Aswath Damodaran",
  school: "Valuation: the price against the story",
  source: "Investment Valuation",
  scope: "Damodaran asks what the price assumes. This runs the checklist's reverse discounted cash flow and sets the answer beside the company's record. The story that turns a business into cash-flow inputs is yours to judge.",
  checks: [
    {
      id: "implied_growth",
      label: "What the price assumes",
      weight: 3,
      bar: `the ten-year cash-flow growth the price assumes no more than the revenue growth the company has delivered (partial within ${points(DAMODARAN.slack)} above it)`,
      run: (f) => {
        const a = f.assumes;
        if (a === null) return missing(f.marketCap === null ? NO_PRICE : "Free cash flow is not reported, so the price cannot be unwound.");
        if (a.side === "no_cash_flow") return result("fail", null, "There is no positive free cash flow to value: the price rests on cash flows not yet earned.");
        if (a.side === "below") return result("pass", "under −30% a year", "Even if free cash flow shrank 30% a year for ten years, it would be worth the price.");
        if (a.side === "above") return result("fail", "over 60% a year", "The price needs free cash flow to grow faster than 60% a year for ten years.");
        const value = `${pct(a.rate)} a year`;
        if (f.revenueCagr === null) return result("missing", value, `The price assumes ${value}, but the company's revenue growth cannot be measured to compare with.`);
        const status: CheckStatus = a.rate <= f.revenueCagr ? "pass" : a.rate <= f.revenueCagr + DAMODARAN.slack ? "partial" : "fail";
        return result(status, `${value} against ${pct(f.revenueCagr)} delivered`, `The price assumes ${value}; revenue has grown ${pct(f.revenueCagr)} a year. Discounted at ${f.rateBasis}.`);
      },
    },
    {
      id: "spread",
      label: "Return above the cost of capital",
      weight: 2,
      bar: `return on invested capital at least ${points(DAMODARAN.spread)} above the cost of equity (partial if above it)`,
      run: (f) => {
        if (f.financial) return missing(BANK);
        const roic = f.latest?.roic ?? null;
        if (roic === null) return missing("Return on invested capital cannot be computed for the latest year.");
        const spread = roic - f.rate;
        const value = `${spread >= 0 ? "+" : "−"}${points(Math.abs(spread))}`;
        return result(spread >= DAMODARAN.spread ? "pass" : spread >= 0 ? "partial" : "fail", value, `Return on invested capital of ${pct(roic)} against a cost of equity of ${pct(f.rate)} (${f.rateBasis}).`);
      },
    },
    {
      id: "cash_flow",
      label: "Cash flow to value",
      weight: 1,
      bar: "free cash flow positive in each of the last three years; the latest year alone is partial",
      run: (f) => {
        const recent = f.years.slice(0, 3);
        const latest = recent[0]?.fcf ?? null;
        if (latest === null) return missing("Operating cash flow is not reported for the latest year.");
        const positive = recent.filter((y) => y.fcf !== null && y.fcf > 0).length;
        const value = `${positive} of ${recent.length} years`;
        return result(positive === recent.length && recent.length === 3 ? "pass" : latest > 0 ? "partial" : "fail", value, `Free cash flow was positive in ${positive} of the last ${recent.length} years.`);
      },
    },
  ],
  notMeasured: ["The story: the market the company can reach, how its margins can change and how likely it is to fail", "A beta for the cost of capital (the cost of equity here is the Treasury yield plus a fixed premium)", "Cash flows after today: only the last three years' average is used"],
};

export const LENSES: readonly Lens[] = [graham, buffett, munger, lynch, fisher, burry, wood, damodaran];

/* ------------------------------------------------------------------ the read */

export interface CheckView extends CheckResult {
  id: string;
  label: string;
  bar: string;
  weight: number;
}

export interface LensView {
  id: LensId;
  name: string;
  school: string;
  source: string;
  scope: string;
  fit: Fit;
  // the share of the measured weight the company cleared, 0 to 1; null when nothing was measured
  score: number | null;
  // the share of the lens's weight that could be measured
  coverage: number;
  headline: string;
  checks: CheckView[];
  notMeasured: string[];
}

export interface LensReport {
  ticker: string;
  name: string;
  asOf: string;
  years: number;
  lenses: LensView[];
  tally: Record<Fit, number>;
  warnings: string[];
}

const CREDIT: Record<CheckStatus, number> = { pass: 1, partial: LENS_RULES.partialCredit, fail: 0, missing: 0 };

export function viewOf(lens: Lens, f: Figures): LensView {
  const checks: CheckView[] = lens.checks.map((c) => ({ id: c.id, label: c.label, bar: c.bar, weight: c.weight, ...c.run(f) }));
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const measured = checks.filter((c) => c.status !== "missing");
  const weight = measured.reduce((s, c) => s + c.weight, 0);
  const score = weight > 0 ? measured.reduce((s, c) => s + CREDIT[c.status] * c.weight, 0) / weight : null;
  const coverage = total > 0 ? weight / total : 0;

  const fit: Fit =
    score === null || coverage < LENS_RULES.minCoverage ? "unscored" : score >= LENS_RULES.fits ? "fits" : score <= LENS_RULES.doesNotFit ? "does_not_fit" : "mixed";

  const cleared = measured.filter((c) => c.status === "pass").length;
  const part = measured.filter((c) => c.status === "partial").length;
  const headline =
    fit === "unscored"
      ? `Only ${pct(coverage, 0)} of this lens's weight could be measured from the figures on file (${pct(LENS_RULES.minCoverage, 0)} needed).`
      : `${cleared} of ${measured.length} measured checks clear the bar${part > 0 ? `, ${part} in part` : ""}; ${pct(coverage, 0)} of the lens could be measured.`;

  return { id: lens.id, name: lens.name, school: lens.school, source: lens.source, scope: lens.scope, fit, score, coverage, headline, checks, notMeasured: lens.notMeasured };
}

export function readLenses(input: PersonaInput): LensReport {
  const f = figuresOf(input);
  const lenses = LENSES.map((l) => viewOf(l, f));
  const tally: Record<Fit, number> = { fits: 0, mixed: 0, does_not_fit: 0, unscored: 0 };
  for (const l of lenses) tally[l.fit]++;

  const warnings: string[] = [];
  if (f.years.length === 0) warnings.push("No annual filings are stored for this company — run npm run ingest-edgar.");
  else if (f.years.length < LENS_RULES.minYears) warnings.push(`Only ${f.years.length} annual ${f.years.length === 1 ? "period is" : "periods are"} stored; the checks on consistency need ${LENS_RULES.minYears}.`);
  if (f.financial) warnings.push(BANK);
  if (f.marketCap === null) warnings.push(NO_PRICE);

  return { ticker: input.ticker, name: input.name, asOf: input.asOf, years: f.years.length, lenses, tally, warnings };
}
