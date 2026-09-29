// No database or server imports: the scenario simulator in the browser runs
// these same functions on the betas the server measured.

export type FactorId = "market" | "nasdaq" | "smallcaps" | "semis" | "oil" | "rates" | "dollar" | "gold";

export interface Factor {
  id: FactorId;
  label: string;
  proxy: string;
  // what a move in the proxy stands for, in plain words
  means: string;
}

// Each factor is measured through an ETF that tracks it, because an ETF has a
// daily price and a factor does not. The betas are only as good as that proxy.
export const FACTORS: Factor[] = [
  { id: "market", label: "S&P 500", proxy: "SPY", means: "the broad US market" },
  { id: "nasdaq", label: "Nasdaq-100", proxy: "QQQ", means: "large-cap growth and technology" },
  { id: "smallcaps", label: "Small caps", proxy: "IWM", means: "the Russell 2000" },
  { id: "semis", label: "Semiconductors", proxy: "SOXX", means: "chipmakers and AI infrastructure demand" },
  { id: "oil", label: "Crude oil", proxy: "USO", means: "the front-month oil price" },
  { id: "rates", label: "Long Treasuries", proxy: "TLT", means: "long-term interest rates, inverted: TLT rises when rates fall" },
  { id: "dollar", label: "US dollar", proxy: "UUP", means: "the dollar against major currencies" },
  { id: "gold", label: "Gold", proxy: "GLD", means: "the gold price" },
];

// A 20+ year Treasury fund's price moves roughly 16 times the change in its
// yield. Used only to turn "rates fall 2 points" into a TLT move, and said so.
export const LONG_BOND_DURATION = 16;

export interface Scenario {
  id: string;
  label: string;
  factor: FactorId;
  shock: number;
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  { id: "spx-10", label: "S&P 500 falls 10%", factor: "market", shock: -0.1 },
  { id: "nasdaq-20", label: "Nasdaq falls 20%", factor: "nasdaq", shock: -0.2 },
  { id: "semis-30", label: "Semiconductors fall 30%", factor: "semis", shock: -0.3 },
  {
    id: "ai-capex",
    label: "AI infrastructure spending slows",
    factor: "semis",
    shock: -0.25,
    note: "modelled as semiconductors falling 25%",
  },
  { id: "oil-up-50", label: "Oil rises 50%", factor: "oil", shock: 0.5 },
  {
    id: "rates-down-2",
    label: "Long-term rates fall 2 points",
    factor: "rates",
    shock: 2 * LONG_BOND_DURATION / 100,
    note: `≈ +${2 * LONG_BOND_DURATION}% on long Treasuries at a ${LONG_BOND_DURATION}-year duration`,
  },
  {
    id: "rates-up-1",
    label: "Long-term rates rise 1 point",
    factor: "rates",
    shock: -LONG_BOND_DURATION / 100,
    note: `≈ −${LONG_BOND_DURATION}% on long Treasuries`,
  },
  { id: "dollar-up-10", label: "Dollar strengthens 10%", factor: "dollar", shock: 0.1 },
  { id: "smallcaps-20", label: "Small caps fall 20%", factor: "smallcaps", shock: -0.2 },
];

export interface ExposureRow {
  ticker: string;
  weight: number;
  marketValue: number | null;
  betas: Partial<Record<FactorId, number | null>>;
  r2: Partial<Record<FactorId, number | null>>;
}

export interface ScenarioResult {
  factor: FactorId;
  shock: number;
  impact: number;
  dollars: number | null;
  // weighted share of the positions' daily variance the factor explains; a low
  // number means the estimate rests on a weak relationship
  explained: number;
  positions: Array<{ ticker: string; beta: number | null; move: number | null; contribution: number | null }>;
  unmeasured: string[];
}

// Each position moves by its measured sensitivity to the shocked factor. One
// factor at a time: adding separate betas to correlated factors would count the
// same move twice. It is a linear estimate from one year of history, which is
// what the page says next to it.
export function applyScenario(rows: ExposureRow[], factor: FactorId, shock: number): ScenarioResult {
  let impact = 0;
  let dollars = 0;
  let anyDollars = false;
  let explained = 0;
  const unmeasured: string[] = [];

  const positions = rows.map((row) => {
    const b = row.betas[factor];
    if (b === null || b === undefined) {
      unmeasured.push(row.ticker);
      return { ticker: row.ticker, beta: null, move: null, contribution: null };
    }
    const move = Math.max(-1, b * shock);
    const contribution = row.weight * move;
    impact += contribution;
    explained += row.weight * (row.r2[factor] ?? 0);
    if (row.marketValue !== null) {
      dollars += row.marketValue * move;
      anyDollars = true;
    }
    return { ticker: row.ticker, beta: b, move, contribution };
  });

  return { factor, shock, impact, dollars: anyDollars ? dollars : null, explained, positions, unmeasured };
}

export function factorOf(id: FactorId): Factor {
  return FACTORS.find((f) => f.id === id) ?? FACTORS[0];
}
