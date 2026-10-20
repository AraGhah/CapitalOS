import type { DecisionInput } from "../../lib/decision/decide";
import type { RatingDimension } from "../../lib/decision/rating";
import type { RiskBook } from "../../lib/decision/risk-debate";
import type { DimensionKey } from "../../lib/ai/roster";
import type { TechnicalSnapshot } from "../../lib/technicals";

export const KEYS: DimensionKey[] = [
  "business_quality",
  "growth",
  "profitability",
  "balance_sheet",
  "valuation",
  "competitive_position",
  "news_flow",
  "macro",
];

// Every dimension scored `all`, with overrides; null means the committee did not score it.
export function dims(overrides: Partial<Record<DimensionKey, number | null>> = {}, all: number | null = 0): RatingDimension[] {
  return KEYS.map((key) => ({
    key,
    label: key.replace(/_/g, " "),
    resolved: key in overrides ? (overrides[key] as number | null) : all,
    contested: false,
  }));
}

// A stock at 100 with a 2.50 average true range (so a stop at 95), in an
// uptrend and not stretched. Overrides replace whole fields.
export function snapshot(overrides: Partial<TechnicalSnapshot> = {}): TechnicalSnapshot {
  return {
    asOf: "2026-10-20",
    sessions: 260,
    last: 100,
    ema10: 99,
    sma50: 95,
    sma200: 90,
    vsSma50: 100 / 95 - 1,
    vsSma200: 100 / 90 - 1,
    rsi14: 58,
    macd: { line: 1.2, signal: 0.9, histogram: 0.3 },
    bollinger: { middle: 96, upper: 104, lower: 88, percentB: 0.75, bandwidth: 16 / 96 },
    atr14: 2.5,
    atrPct: 0.025,
    vwma20: 97,
    volumeRatio: 1,
    smaCross: null,
    macdCross: null,
    readings: {
      trend: "uptrend",
      rsiZone: "neutral",
      macdMomentum: "bullish",
      macdSlope: "rising",
      bandPosition: "upper half of the bands",
    },
    ...overrides,
  };
}

// A committee that scored everything +2 with high confidence: a buy before anything holds it back.
export function strongCommittee(overrides: Partial<DecisionInput["rating"]> = {}): DecisionInput["rating"] {
  return {
    dimensions: dims({}, 2),
    confidence: { score: 0.8, label: "High" },
    unverifiedFigures: [],
    ...overrides,
  };
}

// 100,000 of capital (all of it set aside to invest), medium risk tolerance, a
// clear checklist and a stock that is not held: the plan sizes to the 8%
// position cap, 8,000, which is 80 shares at 100.
export function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    ticker: "TEST",
    name: "Test Co",
    asOf: "2026-10-20",
    rating: strongCommittee(),
    checklist: { level: "ready", headline: "Every question on the checklist passes.", blocking: [], unverified: [], risks: [] },
    thesisBreached: false,
    technical: snapshot(),
    last: 100,
    listingCurrency: "USD",
    baseCurrency: "USD",
    fxToBase: 1,
    profile: { tolerance: "medium", plannedSize: null, investableAmount: 100_000, maxLossShare: null },
    portfolio: { holdingsValue: 0, heldValue: 0, heldQty: 0, sectorValue: null },
    volatility: null,
    maxDrawdown: null,
    avgDollarVolume: null,
    // no book: these inputs test the decision before the risk debate
    book: null,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
   Return series built so every risk figure can be worked out by hand.

   SESSIONS = 96. dropOn(d, k) loses d on the six sessions where t % 16 === k and
   gains 1% on the other ninety, so the 1-day 95% loss (the 5th worst of 96, with
   six sessions tied for worst) is exactly d.
--------------------------------------------------------------------------- */

export const SESSIONS = 96;
export const dropOn = (drop: number, phase = 0) => Array.from({ length: SESSIONS }, (_, t) => (t % 16 === phase ? -drop : 0.01));

// A measured book of an empty portfolio and a stock whose bad day is 4%; its market series has
// the same shape, so the stock's beta is 1.
export function measuredBook(over: Partial<Extract<RiskBook, { status: "measured" }>> = {}): RiskBook {
  return {
    status: "measured",
    asOf: "2026-10-20",
    sessions: SESSIONS,
    candidate: dropOn(0.04),
    others: [],
    market: dropOn(0.04),
    skipped: [],
    ...over,
  };
}
