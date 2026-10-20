import { T } from "../checklist";
import type { RiskTolerance } from "../profile-fields";
import { beta, correlation, historicalVaR, weightedSeries } from "../risk/stats";
import { THRESHOLDS } from "../technicals";
import { RATING_LABEL, type DecisionRating } from "./rating";

/* ---------------------------------------------------------------------------
   The risk debate: three risk views on the same proposed position.

   TradingAgents puts three model-played risk analysts (aggressive, conservative,
   neutral) in a room to argue over the trader's plan before the portfolio
   manager decides. A model arguing a position is opinion with a confident
   voice. Here the same three seats are rules: each looks at the same measured
   figures, holds a different bar for each one, and says what it would do and why,
   in numbers.

   What the seats weigh is what the single-stock sizing (sizing.ts) cannot see,
   because it looks at the stock and your capital, not at what you already own.
   Each test is run on a year of daily returns of your actual holdings with and
   without the new money:

     loss on a bad day   how much the 1-day 95% loss of your whole book grows
                         (historical value at risk, as a share of your capital)
     market sensitivity  the beta to the S&P 500 of your whole capital after the
                         add (money not yet invested counts as zero)
     overlap             your capital in this stock plus the holdings that move
                         with it, which behave as one bet whatever their sectors
     time to exit        sessions to sell the position at 10% of its volume

   For each test a seat has a bar (conservative 0.20% of capital for a bad day,
   neutral 0.35%, aggressive 0.60%; every number is in SEAT_RULES). The largest
   position that stays inside every bar is that seat's position: the full
   proposal (approve), part of it (reduce), or none of the addition (reject).
   A test the desk could not measure is never a free pass: a cautious seat takes
   a share off the addition for each one.

   The seat that matches the person's own risk tolerance decides (low follows
   the conservative seat, medium the neutral, high the aggressive; unset is low,
   as everywhere else); the other two are the range around it. Nothing here
   predicts a price, and no model is called.

   Pure: gatherRiskBook (lib/decision/data.ts) fetches the returns.
--------------------------------------------------------------------------- */

export type SeatName = "conservative" | "neutral" | "aggressive";
export const SEATS: readonly SeatName[] = ["conservative", "neutral", "aggressive"];
export const SEAT_LABEL: Record<SeatName, string> = { conservative: "Conservative", neutral: "Neutral", aggressive: "Aggressive" };

export interface SeatRules {
  // growth of the book's 1-day 95% loss, as a share of capital
  badDay: number;
  // the beta to the S&P 500 of your whole capital after the add (cash counts as zero)
  beta: number;
  // capital in this stock plus the holdings that move with it, as a share of capital
  overlap: number;
  // how closely a holding must follow this stock to count as moving with it
  overlapCorrelation: number;
  // sessions to sell the position at the participation rate
  exitSessions: number;
  // the share of the addition kept for each test the desk could not measure
  unmeasured: number;
}

// The bars are conventions, like the 10% participation rate: round numbers a
// reader can argue with, in one place. They are not fitted to anything.
export const SEAT_RULES: Record<SeatName, SeatRules> = {
  conservative: { badDay: 0.002, beta: 1.15, overlap: 0.25, overlapCorrelation: 0.6, exitSessions: 1, unmeasured: 0.5 },
  neutral: { badDay: 0.0035, beta: 1.3, overlap: 0.35, overlapCorrelation: 0.7, exitSessions: 3, unmeasured: 0.75 },
  aggressive: { badDay: 0.006, beta: 1.5, overlap: 0.5, overlapCorrelation: 0.8, exitSessions: 5, unmeasured: 1 },
};

export const DEBATE_RULES = {
  // a test above this share of its bar (or within betaMargin of the beta bar) is "close"
  closeAt: 0.8,
  betaMargin: 0.1,
  // a seat that would allow under this share of the intended addition rejects it rather than shrink it to nothing
  rejectBelow: 0.25,
  // fewest sessions the desk and the book must share before a return series is trusted
  minSessions: 40,
  participation: T.participation,
  deciding: { low: "conservative", medium: "neutral", high: "aggressive" } as Record<RiskTolerance, SeatName>,
} as const;

/* ------------------------------------------------------------------ inputs */

export interface BookLine {
  ticker: string;
  // current market value, base currency
  value: number;
  // daily simple returns on the shared sessions
  returns: number[];
}

// A year of daily returns of what the person holds, aligned with the stock's own.
export type RiskBook =
  | {
      status: "measured";
      asOf: string;
      sessions: number;
      // the stock under review
      candidate: number[];
      // every other holding with a price history
      others: BookLine[];
      // S&P 500; null when it could not be loaded
      market: number[] | null;
      // holdings left out because they have no price history
      skipped: string[];
    }
  | { status: "unmeasured"; reason: string };

export interface DebateFacts {
  rating: DecisionRating;
  composite: number | null;
  confidence: string;
  volatility: number | null;
  maxDrawdown: number | null;
  stress: number;
  rsi: number | null;
  trend: "uptrend" | "downtrend" | "mixed" | null;
}

export interface DebateInput {
  ticker: string;
  base: string;
  book: RiskBook;
  capital: number;
  // what the person holds of this stock now, and the position the plan asks for, base currency
  held: number;
  proposed: number;
  avgDollarVolume: number | null;
  fxToBase: number | null;
  tolerance: RiskTolerance | null;
  facts: DebateFacts;
}

/* ----------------------------------------------------------------- outputs */

export type TestKey = "bad_day" | "market" | "overlap" | "exit";
export type Stance = "approve" | "reduce" | "reject";

export interface SeatTest {
  key: TestKey;
  label: string;
  // at the proposed size; null when it could not be measured
  value: number | null;
  limit: number;
  status: "within" | "close" | "over" | "unmeasured";
  // the largest position this bar allows, base currency, never above the proposal; null when unmeasured
  ceiling: number | null;
  note: string;
}

export interface SeatView {
  seat: SeatName;
  stance: Stance;
  // the position this seat would hold, base currency
  value: number;
  tests: SeatTest[];
  // what held the position down; null when nothing did
  binding: TestKey | "unmeasured" | null;
  // the share of the addition kept after the tests the desk could not measure
  haircut: number;
  for: string[];
  against: string[];
  verdict: string;
}

export interface RiskDebate {
  version: 1;
  measured: boolean;
  window: { asOf: string; sessions: number } | null;
  held: number;
  proposed: number;
  seats: SeatView[];
  deciding: SeatName;
  because: string;
  // the deciding seat's call
  stance: Stance;
  value: number;
  summary: string;
  warnings: string[];
}

/* -------------------------------------------------------------- formatting */

const money = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const TEST_LABEL: Record<TestKey, string> = {
  bad_day: "Loss on a bad day",
  market: "Market sensitivity",
  overlap: "Overlap with your holdings",
  exit: "Time to exit",
};

/* ------------------------------------------------------------- the maths */

type Measured = Extract<RiskBook, { status: "measured" }>;

// The book's daily return series with the stock at `value`.
function bookAt(book: Measured, value: number): { series: number[]; total: number } | null {
  const lines = [...book.others.map((o) => ({ value: o.value, returns: o.returns })), { value, returns: book.candidate }];
  const total = lines.reduce((s, l) => s + l.value, 0);
  if (!(total > 0)) return null;
  return { series: weightedSeries(lines.map((l) => l.returns), lines.map((l) => l.value / total)), total };
}

// The 1-day 95% loss of the whole book, base currency. An empty book loses nothing.
function lossAt(book: Measured, value: number): number | null {
  const b = bookAt(book, value);
  if (!b) return 0;
  const v = historicalVaR(b.series);
  return v === null ? null : v * b.total;
}

// The largest value in [lo, hi] that passes, for a test that gets harder as the
// position grows. `lo` is where the book is today, which always passes: nothing
// has been added yet.
function largestPassing(lo: number, hi: number, passes: (v: number) => boolean): number {
  if (passes(hi)) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    if (passes(mid)) a = mid;
    else b = mid;
  }
  return a;
}

interface Measures {
  lossHeld: number | null;
  lossProposed: number | null;
  // the stock's beta to the S&P 500, and the market-value-weighted beta of the other holdings
  // (base currency); null when the market series is missing or flat
  betaStock: number | null;
  betaOthers: number | null;
  correlations: Array<{ ticker: string; value: number; rho: number | null }>;
}

function measure(book: Measured, input: DebateInput): Measures {
  const betaStock = book.market ? beta(book.candidate, book.market) : null;
  const betas = book.market ? book.others.map((o) => beta(o.returns, book.market as number[])) : [];
  return {
    lossHeld: lossAt(book, input.held),
    lossProposed: lossAt(book, input.proposed),
    betaStock,
    betaOthers: betaStock !== null && betas.every((b) => b !== null) ? betas.reduce((s, b, i) => s + (b as number) * book.others[i].value, 0) : null,
    correlations: book.others.map((o) => ({ ticker: o.ticker, value: o.value, rho: correlation(book.candidate, o.returns) })),
  };
}

const statusOf = (value: number, limit: number, closeFrom: number): SeatTest["status"] =>
  value > limit ? "over" : value > closeFrom ? "close" : "within";

/* --------------------------------------------------------------- the tests */

function unmeasured(key: TestKey, limit: number, why: string): SeatTest {
  return { key, label: TEST_LABEL[key], value: null, limit, status: "unmeasured", ceiling: null, note: `${TEST_LABEL[key]} could not be measured: ${why}.` };
}

function badDayTest(rules: SeatRules, input: DebateInput, book: Measured | null, m: Measures | null): SeatTest {
  const limit = rules.badDay;
  if (!book || !m) return unmeasured("bad_day", limit, input.book.status === "unmeasured" ? input.book.reason : "no price history");
  if (m.lossHeld === null || m.lossProposed === null) {
    return unmeasured("bad_day", limit, `the book shares fewer than 20 sessions with this stock`);
  }
  const added = m.lossProposed - m.lossHeld;
  const value = added / input.capital;
  const ceiling = largestPassing(input.held, input.proposed, (v) => {
    const loss = lossAt(book, v);
    return loss !== null && (loss - (m.lossHeld as number)) / input.capital <= limit;
  });
  const note =
    added >= 0
      ? `On a bad day (the 1-in-20 loss of everything you hold) this position adds ${money(added)} ${input.base}, ${pct(value, 2)} of your capital.`
      : `On a bad day (the 1-in-20 loss of everything you hold) this position takes ${money(-added)} ${input.base} off, because it moves against what you own.`;
  return {
    key: "bad_day",
    label: TEST_LABEL.bad_day,
    value,
    limit,
    status: statusOf(value, limit, limit * DEBATE_RULES.closeAt),
    ceiling: Math.max(0, ceiling),
    note: `${note} This seat's bar is ${pct(limit, 2)}.`,
  };
}

function marketTest(rules: SeatRules, input: DebateInput, book: Measured | null, m: Measures | null): SeatTest {
  const limit = rules.beta;
  if (!book || !m) return unmeasured("market", limit, input.book.status === "unmeasured" ? input.book.reason : "no price history");
  if (m.betaStock === null || m.betaOthers === null) {
    return unmeasured("market", limit, book.market ? "the S&P 500 history is flat over the shared sessions" : "the S&P 500 history could not be loaded");
  }
  // The beta of the whole of your capital, so money not yet invested counts as
  // zero. Beta is linear in the weights, so this is exact and needs no search.
  const at = (v: number) => (m.betaOthers as number) + (m.betaStock as number) * v;
  const after = at(input.proposed) / input.capital;
  const before = at(input.held) / input.capital;
  // a stock that moves against the market (or not at all) never raises it
  const raises = (m.betaStock as number) > 0;
  const ceiling = raises ? Math.max(0, Math.min(input.proposed, (limit * input.capital - (m.betaOthers as number)) / (m.betaStock as number))) : input.proposed;
  return {
    key: "market",
    label: TEST_LABEL.market,
    value: after,
    limit,
    status: raises ? statusOf(after, limit, limit - DEBATE_RULES.betaMargin) : "within",
    ceiling,
    note: `This position takes the beta of your capital to the S&P 500 from ${before.toFixed(2)} to ${after.toFixed(2)} (money not yet invested counts as zero). This seat's bar is ${limit.toFixed(2)}${raises ? "" : ", which does not apply as this stock does not move with the market"}.`,
  };
}

function overlapTest(rules: SeatRules, input: DebateInput, book: Measured | null, m: Measures | null): SeatTest {
  const limit = rules.overlap;
  if (!book || !m) return unmeasured("overlap", limit, input.book.status === "unmeasured" ? input.book.reason : "no price history");
  const members = m.correlations.filter((c) => c.rho !== null && c.rho >= rules.overlapCorrelation);
  const membersValue = members.reduce((s, c) => s + c.value, 0);
  const value = (input.proposed + membersValue) / input.capital;
  const ceiling = Math.max(0, Math.min(input.proposed, limit * input.capital - membersValue));
  const who =
    members.length === 0
      ? `None of your holdings moves with it (correlation under ${rules.overlapCorrelation.toFixed(2)})`
      : `${members.map((c) => `${c.ticker} (${(c.rho as number).toFixed(2)})`).join(", ")} ${plural(members.length, "moves", "move")} with it (correlation of ${rules.overlapCorrelation.toFixed(2)} or more)`;
  return {
    key: "overlap",
    label: TEST_LABEL.overlap,
    value,
    limit,
    status: statusOf(value, limit, limit * DEBATE_RULES.closeAt),
    ceiling,
    note: `${who}; with the position that is ${pct(value, 0)} of your capital in one bet. This seat's bar is ${pct(limit, 0)}.`,
  };
}

function exitTest(rules: SeatRules, input: DebateInput): SeatTest {
  const limit = rules.exitSessions;
  const adv = input.avgDollarVolume;
  const fx = input.fxToBase;
  if (adv === null || !(adv > 0) || fx === null || !(fx > 0)) {
    return unmeasured("exit", limit, adv === null || !(adv > 0) ? "no volume history" : "no exchange rate into your base currency");
  }
  const perSession = DEBATE_RULES.participation * adv * fx;
  const value = input.proposed / perSession;
  return {
    key: "exit",
    label: TEST_LABEL.exit,
    value,
    limit,
    status: statusOf(value, limit, limit * DEBATE_RULES.closeAt),
    ceiling: Math.min(input.proposed, limit * perSession),
    note: `Selling the position takes about ${value.toFixed(1)} ${plural(value, "session", "sessions")} at ${pct(DEBATE_RULES.participation, 0)} of its daily dollar volume. This seat's bar is ${limit} ${plural(limit, "session", "sessions")}.`,
  };
}

/* ------------------------------------------------------------ the arguments */

function lens(seat: SeatName, f: DebateFacts, ticker: string): { for: string[]; against: string[] } {
  const out = { for: [] as string[], against: [] as string[] };
  if (f.composite !== null) {
    out.for.push(`The committee's numbers rate ${ticker} ${RATING_LABEL[f.rating]} (${signed(f.composite)} on a −2…+2 scale, ${f.confidence} confidence).`);
  }
  if (f.trend === "uptrend") out.for.push("The price is in an uptrend: above its 50-day average, which is above its 200-day.");
  if (seat === "aggressive") return out;

  if (f.trend === "downtrend") out.against.push("The price is in a downtrend (below its 50-day average, itself below the 200-day); the size is already halved for it.");
  if (f.confidence === "Medium" || f.confidence === "Low") out.against.push(`Committee confidence is ${f.confidence}; the size already reflects it.`);
  if (seat === "neutral") return out;

  if (f.maxDrawdown !== null) {
    const fall = Math.abs(f.maxDrawdown);
    (fall >= 0.3 ? out.against : out.for).push(`Its worst fall in the last year was ${pct(fall, 0)} from a peak; the checklist plans for ${pct(f.stress, 0)}.`);
  }
  if (f.volatility !== null) {
    (f.volatility >= 0.4 ? out.against : out.for).push(`Its annualised volatility is ${pct(f.volatility, 0)}.`);
  }
  if (f.rsi !== null && f.rsi >= THRESHOLDS.rsiOverbought) {
    out.against.push(`RSI(14) is ${f.rsi.toFixed(1)}, at or above ${THRESHOLDS.rsiOverbought}: buying after a run-up.`);
  }
  return out;
}

export const BINDING_LABEL: Record<TestKey | "unmeasured", string> = {
  bad_day: "the loss it adds on a bad day",
  market: "its market sensitivity",
  overlap: "its overlap with what you hold",
  exit: "the time it takes to exit",
  unmeasured: "figures the desk could not measure",
};

/* -------------------------------------------------------------- the seat */

function seatView(seat: SeatName, input: DebateInput, book: Measured | null, m: Measures | null): SeatView {
  const rules = SEAT_RULES[seat];
  const { held, proposed } = input;
  const tests = [badDayTest(rules, input, book, m), marketTest(rules, input, book, m), overlapTest(rules, input, book, m), exitTest(rules, input)];

  const gaps = tests.filter((t) => t.status === "unmeasured").length;
  const haircut = rules.unmeasured ** gaps;
  const gapCap = held + (proposed - held) * haircut;

  let value = proposed;
  let binding: SeatView["binding"] = null;
  for (const t of tests) {
    if (t.ceiling !== null && t.ceiling < value) {
      value = t.ceiling;
      binding = t.key;
    }
  }
  if (gapCap < value) {
    value = gapCap;
    binding = "unmeasured";
  }

  const room = proposed - held;
  let stance: Stance;
  if (value >= proposed - 1e-9) {
    stance = "approve";
    value = proposed;
    binding = null;
  } else if (value - held < DEBATE_RULES.rejectBelow * room) {
    stance = "reject";
    value = held;
  } else {
    stance = "reduce";
  }

  const argued = lens(seat, input.facts, input.ticker);
  for (const t of tests) {
    if (t.status === "within") argued.for.push(t.note);
    else if (t.status === "close") argued.against.push(`${t.note} That is close to the bar.`);
    else if (t.status === "over") argued.against.push(`${t.note} That is over the bar.`);
    else
      argued.against.push(
        rules.unmeasured < 1 ? `${t.note} This seat keeps ${pct(rules.unmeasured, 0)} of the addition for it.` : `${t.note} This seat goes ahead regardless.`
      );
  }

  const verdict =
    stance === "approve"
      ? `Approves the full ${money(proposed)} ${input.base} position.`
      : stance === "reduce"
        ? `Approves ${money(value)} of the ${money(proposed)} ${input.base}, held down by ${BINDING_LABEL[binding as TestKey | "unmeasured"]}.`
        : `Would add nothing: ${BINDING_LABEL[binding as TestKey | "unmeasured"]} leaves too little room.`;

  return { seat, stance, value, tests, binding, haircut, for: argued.for, against: argued.against, verdict };
}

/* ---------------------------------------------------------------- the debate */

// The deciding seat's reason for adding nothing, as a blocker the decision can state.
export function objection(debate: RiskDebate): string {
  const seat = debate.seats.find((s) => s.seat === debate.deciding) as SeatView;
  const key = seat.binding ?? "unmeasured";
  const detail = key === "unmeasured" ? "" : ` ${seat.tests.find((t) => t.key === key)?.note ?? ""}`;
  return `Your portfolio leaves no room for it: the ${debate.deciding} risk seat, which follows your risk tolerance, would add nothing because ${BINDING_LABEL[key]} leaves too little room.${detail}`.trim();
}

const STANCE_WORD: Record<Stance, string> = { approve: "approves", reduce: "reduces", reject: "rejects" };

export function riskDebate(input: DebateInput): RiskDebate {
  const book = input.book.status === "measured" ? input.book : null;
  const m = book ? measure(book, input) : null;
  const seats = SEATS.map((seat) => seatView(seat, input, book, m));

  const deciding = DEBATE_RULES.deciding[input.tolerance ?? "low"];
  const chosen = seats.find((s) => s.seat === deciding) as SeatView;
  const because =
    input.tolerance === null
      ? `Your risk tolerance is not set on your profile, so the lowest one (low) is used, which follows the ${deciding} seat.`
      : `Your ${input.tolerance} risk tolerance follows the ${deciding} seat.`;

  const stances = new Set(seats.map((s) => s.stance));
  const range = seats.map((s) => `${SEAT_LABEL[s.seat]} ${STANCE_WORD[s.stance]}`).join(", ");
  const summary = `${range}. ${stances.size === 1 ? "The three seats agree. " : ""}${because} ${chosen.verdict}`;

  const warnings: string[] = [];
  if (input.book.status === "unmeasured") warnings.push(`The portfolio could not be measured: ${input.book.reason}.`);
  else if (input.book.skipped.length > 0) {
    warnings.push(`${input.book.skipped.join(", ")} ${plural(input.book.skipped.length, "has", "have")} no price history, so ${plural(input.book.skipped.length, "it is", "they are")} left out of these figures.`);
  }

  return {
    version: 1,
    measured: book !== null,
    window: book ? { asOf: book.asOf, sessions: book.sessions } : null,
    held: input.held,
    proposed: input.proposed,
    seats,
    deciding,
    because,
    stance: chosen.stance,
    value: chosen.value,
    summary,
    warnings,
  };
}
