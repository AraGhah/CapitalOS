/* ---------------------------------------------------------------------------
   Post-earnings-announcement drift (PEAD), computed by code.

   A stock that reports earnings well above what its own record led anyone to
   expect has tended to keep drifting the same way for about three months
   afterwards, and the reverse for a miss. Three figures read that setup:

   - the surprise: this quarter's earnings per share against the same quarter a
     year earlier, less the average such change over the quarters before it, in
     units of how much that change usually varies (standardised unexpected
     earnings, SUE: a seasonal random walk with drift, which needs no analyst
     estimates, so nothing here is bought or guessed);
   - the reaction: the stock's return from the close before the announcement
     day to the close after it, less the S&P 500's, which covers a release
     before the open and one after the close;
   - the drift so far: the same abnormal return from then to the last close.

   When surprise and reaction agree, that is the setup in which drift has been
   documented. It is a historical tendency that has weakened since it was
   published, and this module forecasts nothing: it states what was measured and
   how old it is.

   Pure: figures, release dates and closes in, a reading out. No clock, no
   database, no network.
--------------------------------------------------------------------------- */

export const DRIFT_RULES = {
  // earlier quarterly changes needed before the newest can be scaled, and the most it looks back over
  minHistory: 4,
  maxHistory: 8,
  // |SUE| at or above this is a surprise; below it the quarter was in line
  surprise: 1,
  // an abnormal return of at least this, up or down, counts as the market moving
  reaction: 0.005,
  // sessions after the announcement in which drift has been documented
  window: 60,
  // a release comes at least this many days after the quarter closes, and its 8-K can trail the 10-Q by a few
  releaseLeadDays: 7,
  releaseLagDays: 3,
  releaseMaxDays: 120,
  // a filing's comparative quarter ends this many days before the quarter itself
  yearAgoDays: [350, 380],
} as const;

export interface QuarterFigures {
  eps: number | null;
  netIncome: number | null;
  shares: number | null;
}

// One periodic filing's account of its own quarter and of the same quarter a
// year earlier, both on the share basis that filing used, so a split between
// the two cannot pass for a surprise.
export interface QuarterFiling {
  accession: string;
  form: string;
  filedOn: string;
  periodEnd: string;
  current: QuarterFigures;
  yearAgo: QuarterFigures;
}

export interface Surprise {
  periodEnd: string;
  filedOn: string;
  accession: string;
  form: string;
  eps: number;
  yearAgo: number;
  change: number;
  // "reported": the filing's own diluted EPS. "derived": net income over diluted shares, when it reports none.
  basis: "reported" | "derived";
  sue: number | null;
  // how many earlier changes the scale came from, and the scale itself
  history: number;
  deviation: number | null;
}

export interface Bar {
  date: string;
  close: number;
}

/* ------------------------------------------------------------------ dates */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/* --------------------------------------------------------- the stored facts */

// One quarterly (three-month) fact as the fundamentals table keeps it, with the
// filing it came from.
export interface FactRow {
  accession: string;
  form: string;
  filedOn: string;
  metric: string;
  periodEnd: string;
  value: number;
}

// Each filing's own quarter and the same quarter a year earlier, from the facts
// that one filing carried. Reading both from one filing keeps them on one share
// basis. A filing's own quarter is the latest it reports; the comparative is the
// one that ended about a year before it, never a neighbouring quarter.
export function quartersFrom(rows: FactRow[]): QuarterFiling[] {
  const [lo, hi] = DRIFT_RULES.yearAgoDays;
  const byFiling = new Map<string, FactRow[]>();
  for (const row of rows) byFiling.set(row.accession, [...(byFiling.get(row.accession) ?? []), row]);

  const figures = (rowsOf: FactRow[], periodEnd: string): QuarterFigures => {
    const pick = (metric: string) => rowsOf.find((r) => r.periodEnd === periodEnd && r.metric === metric)?.value ?? null;
    return { eps: pick("eps_diluted"), netIncome: pick("net_income"), shares: pick("shares_diluted") };
  };

  const out: QuarterFiling[] = [];
  for (const [accession, filingRows] of byFiling) {
    const periodEnd = filingRows.map((r) => r.periodEnd).sort().at(-1) as string;
    const comparative = filingRows.map((r) => r.periodEnd).find((end) => {
      const gap = daysBetween(end, periodEnd);
      return gap >= lo && gap <= hi;
    });
    if (!comparative) continue;
    out.push({
      accession,
      form: filingRows[0].form,
      filedOn: filingRows[0].filedOn,
      periodEnd,
      current: figures(filingRows, periodEnd),
      yearAgo: figures(filingRows, comparative),
    });
  }
  return out;
}

/* ------------------------------------------------------------- the surprise */

const perShare = (f: QuarterFigures): number | null => (f.netIncome !== null && f.shares !== null && f.shares > 0 ? f.netIncome / f.shares : null);

function epsPair(q: QuarterFiling): { eps: number; yearAgo: number; basis: Surprise["basis"] } | null {
  if (q.current.eps !== null && q.yearAgo.eps !== null) return { eps: q.current.eps, yearAgo: q.yearAgo.eps, basis: "reported" };
  const eps = perShare(q.current);
  const yearAgo = perShare(q.yearAgo);
  return eps !== null && yearAgo !== null ? { eps, yearAgo, basis: "derived" } : null;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Sample standard deviation: the scale is estimated from a handful of quarters.
function deviation(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Every quarter the filings let the desk read, oldest first. A quarter that two
// filings report (an amended 10-Q) is read from the later one. The comparative
// has to be the quarter a year earlier, not a neighbouring one.
export function surprises(filings: QuarterFiling[]): Surprise[] {
  const latestByQuarter = new Map<string, QuarterFiling>();
  for (const q of filings) {
    const kept = latestByQuarter.get(q.periodEnd);
    if (!kept || q.filedOn > kept.filedOn) latestByQuarter.set(q.periodEnd, q);
  }

  const readable = [...latestByQuarter.values()]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .flatMap((q) => {
      const pair = epsPair(q);
      return pair ? [{ q, ...pair, change: pair.eps - pair.yearAgo }] : [];
    });

  const out: Surprise[] = [];
  readable.forEach((r, i) => {
    const earlier = readable.slice(Math.max(0, i - DRIFT_RULES.maxHistory), i).map((e) => e.change);
    let sue: number | null = null;
    let scale: number | null = null;
    if (earlier.length >= DRIFT_RULES.minHistory) {
      scale = deviation(earlier);
      sue = scale > 1e-9 ? (r.change - mean(earlier)) / scale : null;
    }
    out.push({
      periodEnd: r.q.periodEnd,
      filedOn: r.q.filedOn,
      accession: r.q.accession,
      form: r.q.form,
      eps: r.eps,
      yearAgo: r.yearAgo,
      change: r.change,
      basis: r.basis,
      sue,
      history: earlier.length,
      deviation: scale,
    });
  });
  return out;
}

/* --------------------------------------------------------- the announcement */

export interface Announcement {
  on: string;
  // "release": the 8-K under Item 2.02. "filing": the periodic report's own date, which can be weeks late.
  dating: "release" | "filing";
}

// The earliest earnings release after the quarter closed and no later than the
// report that carries its figures (give or take the few days an 8-K can trail).
export function announcementOf(periodEnd: string, filedOn: string, releases: string[]): Announcement {
  const earliest = addDays(periodEnd, DRIFT_RULES.releaseLeadDays);
  const latest = [addDays(filedOn, DRIFT_RULES.releaseLagDays), addDays(periodEnd, DRIFT_RULES.releaseMaxDays)].sort()[0];
  const release = releases.filter((r) => r >= earliest && r <= latest).sort()[0];
  return release ? { on: release, dating: "release" } : { on: filedOn, dating: "filing" };
}

/* ------------------------------------------------------------- the reaction */

export interface Reaction {
  announcedOn: string;
  // the closes the reaction runs between: the session before the announcement day and the one after it
  from: string;
  to: string;
  stock: number;
  market: number | null;
  // the stock's return less the market's, or the stock's own when no market series was usable
  abnormal: number;
  adjusted: boolean;
  // sessions since the reaction window closed, and the abnormal return over them
  sessionsSince: number;
  drift: number | null;
}

export type ReactionResult = { status: "measured"; reaction: Reaction } | { status: "unmeasured"; reason: string };

// `stock` and `market` are daily closes, oldest first.
export function reactionTo(stock: Bar[], market: Bar[] | null, announcedOn: string): ReactionResult {
  const day = stock.findIndex((b) => b.date >= announcedOn);
  if (day === -1) return { status: "unmeasured", reason: `${announcedOn} is after the last stored session, so there is no reaction to read yet` };
  if (day === 0) return { status: "unmeasured", reason: `the price history starts on ${stock[0].date}, with no close before the announcement` };
  if (day + 1 >= stock.length) return { status: "unmeasured", reason: "the session after the announcement has not closed yet" };

  const before = stock[day - 1];
  const after = stock[day + 1];
  const last = stock[stock.length - 1];
  const marketAt = new Map((market ?? []).map((b) => [b.date, b.close]));
  const m0 = marketAt.get(before.date);
  const m1 = marketAt.get(after.date);
  const m2 = marketAt.get(last.date);
  const adjusted = m0 !== undefined && m1 !== undefined && m2 !== undefined;

  const stockReturn = after.close / before.close - 1;
  const marketReturn = adjusted ? (m1 as number) / (m0 as number) - 1 : null;
  const sessionsSince = stock.length - 1 - (day + 1);
  const driftRaw = sessionsSince > 0 ? last.close / after.close - 1 : null;
  const driftMarket = adjusted && sessionsSince > 0 ? (m2 as number) / (m1 as number) - 1 : 0;

  return {
    status: "measured",
    reaction: {
      announcedOn,
      from: before.date,
      to: after.date,
      stock: stockReturn,
      market: marketReturn,
      abnormal: stockReturn - (marketReturn ?? 0),
      adjusted,
      sessionsSince,
      drift: driftRaw === null ? null : driftRaw - driftMarket,
    },
  };
}

/* ------------------------------------------------------------------ reading */

export type SurpriseKind = "beat" | "miss" | "in line" | "unscaled";
export type Move = "up" | "down" | "flat";
export type Setup = "confirmed" | "unconfirmed" | "none" | "unmeasured";

export interface Reading {
  surprise: SurpriseKind;
  move: Move | null;
  setup: Setup;
  // the reaction is measured and inside the window in which drift has been documented
  live: boolean;
  summary: string;
}

const signedPct = (x: number, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;

export function readingOf(latest: Surprise, reaction: Reaction | null): Reading {
  const { surprise: bar, reaction: moveBar, window } = DRIFT_RULES;
  const surprise: SurpriseKind = latest.sue === null ? "unscaled" : latest.sue >= bar ? "beat" : latest.sue <= -bar ? "miss" : "in line";
  const move: Move | null = reaction === null ? null : reaction.abnormal >= moveBar ? "up" : reaction.abnormal <= -moveBar ? "down" : "flat";
  const live = reaction !== null && reaction.sessionsSince <= window;

  const sue = latest.sue === null ? null : `${latest.sue >= 0 ? "+" : "−"}${Math.abs(latest.sue).toFixed(1)}`;
  const eps = `EPS ${latest.eps.toFixed(2)} against ${latest.yearAgo.toFixed(2)} a year earlier`;
  const moved = reaction ? `${signedPct(reaction.abnormal)} ${reaction.adjusted ? "against the market" : "(not adjusted for the market)"} around the announcement` : null;
  const age = reaction
    ? live
      ? `The reaction closed ${reaction.sessionsSince} sessions ago, inside the ${window}-session window in which drift has been documented.`
      : `The reaction closed ${reaction.sessionsSince} sessions ago, past the ${window}-session window in which drift has been documented.`
    : "";

  if (surprise === "unscaled") {
    return {
      surprise,
      move,
      setup: "unmeasured",
      live,
      summary: `${eps}. The desk has only ${latest.history} earlier ${latest.history === 1 ? "quarter" : "quarters"} to judge how unusual that is and needs ${DRIFT_RULES.minHistory}, so no surprise is scored.${moved ? ` The stock moved ${moved}.` : ""}`,
    };
  }
  if (surprise === "in line") {
    return {
      surprise,
      move,
      setup: "none",
      live,
      summary: `${eps}: a surprise of ${sue} standard deviations, in line with the company's own record. No drift setup.${moved ? ` The stock moved ${moved}.` : ""}`,
    };
  }

  const direction = surprise === "beat" ? "up" : "down";
  const lead = `${eps}: a ${surprise} of ${sue} standard deviations against the company's own record.`;
  if (move === null) {
    return { surprise, move, setup: "unmeasured", live, summary: `${lead} The market's reaction could not be measured, so it is not known whether the market agreed.` };
  }
  if (move === direction) {
    return {
      surprise,
      move,
      setup: "confirmed",
      live,
      summary: `${lead} The stock moved ${moved}: the market agreed with the surprise, the setup in which drift has been documented. ${age}`,
    };
  }
  return {
    surprise,
    move,
    setup: "unconfirmed",
    live,
    summary: `${lead} The stock moved ${moved}, ${move === "flat" ? "not enough to count" : "the other way"}: the market did not confirm the surprise, so there is no drift setup. ${age}`,
  };
}

/* ------------------------------------------------------------------ the read */

export interface DriftRead {
  status: "measured" | "unmeasured";
  reason: string | null;
  // oldest first, the last few quarters for the table
  quarters: Surprise[];
  latest: Surprise | null;
  announcement: Announcement | null;
  reaction: Reaction | null;
  // why the reaction could not be read, when it could not
  reactionNote: string | null;
  reading: Reading | null;
  // set when a newer periodic report exists whose quarter the desk cannot read
  newerReport: string | null;
  asOf: string | null;
}

const TABLE_ROWS = 8;

export interface DriftInput {
  quarters: QuarterFiling[];
  // dates of the company's Item 2.02 8-Ks
  releases: string[];
  stock: Bar[];
  market: Bar[] | null;
  // the newest 10-Q or 10-K on file, to notice a fourth quarter the quarterly figures cannot show
  latestReport: { form: string; filedOn: string } | null;
}

const NOTHING: Omit<DriftRead, "status" | "reason"> = {
  quarters: [],
  latest: null,
  announcement: null,
  reaction: null,
  reactionNote: null,
  reading: null,
  newerReport: null,
  asOf: null,
};

export function readDrift(input: DriftInput): DriftRead {
  const all = surprises(input.quarters);
  const asOf = input.stock.at(-1)?.date ?? null;
  const latest = all.at(-1) ?? null;
  if (!latest) {
    return {
      ...NOTHING,
      status: "unmeasured",
      reason: "no quarterly earnings per share are stored, or no quarter has the same quarter a year earlier beside it — run npm run ingest-edgar",
      asOf,
    };
  }

  const announcement = announcementOf(latest.periodEnd, latest.filedOn, input.releases);
  let reaction: Reaction | null = null;
  let reactionNote: string | null = null;
  if (input.stock.length === 0) {
    reactionNote = "no price history is stored for this company";
  } else {
    const r = reactionTo(input.stock, input.market, announcement.on);
    if (r.status === "measured") reaction = r.reaction;
    else reactionNote = r.reason;
  }

  const newer = input.latestReport && input.latestReport.filedOn > addDays(latest.filedOn, 7) ? input.latestReport : null;
  return {
    status: "measured",
    reason: null,
    quarters: all.slice(-TABLE_ROWS),
    latest,
    announcement,
    reaction,
    reactionNote,
    reading: readingOf(latest, reaction),
    newerReport: newer
      ? `A ${newer.form} was filed on ${newer.filedOn}, after this quarter's report. A fourth quarter is not in the quarterly figures the desk stores, so this is the latest quarter it can read.`
      : null,
    asOf,
  };
}
