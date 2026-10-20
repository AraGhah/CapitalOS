import { describe, expect, it } from "vitest";
import {
  DRIFT_RULES,
  announcementOf,
  quartersFrom,
  reactionTo,
  readDrift,
  readingOf,
  surprises,
  type Bar,
  type FactRow,
  type QuarterFiling,
  type Reaction,
  type Surprise,
} from "../../lib/earnings/drift";

/* ---------------------------------------------------------------------------
   Worked by hand. Four earlier year-on-year changes of 0.08, 0.12, 0.08 and
   0.12 have a mean of 0.10 and a sample deviation of sqrt(4 × 0.02² / 3) =
   0.023094, so a fifth change of 0.16 is (0.16 − 0.10) / 0.023094 = 2.598
   deviations above what the company usually does.
--------------------------------------------------------------------------- */

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// A quarter whose EPS is a year earlier's plus `change`.
function quarter(periodEnd: string, change: number, over: Partial<QuarterFiling> = {}): QuarterFiling {
  return {
    accession: `A-${periodEnd}`,
    form: "10-Q",
    filedOn: plus(periodEnd, 40),
    periodEnd,
    current: { eps: 1 + change, netIncome: null, shares: null },
    yearAgo: { eps: 1, netIncome: null, shares: null },
    ...over,
  };
}

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
const CHANGES = [0.08, 0.12, 0.08, 0.12, 0.16];
const five = () => ENDS.map((end, i) => quarter(end, CHANGES[i]));

describe("the surprise", () => {
  it("scales a change by how much the company's changes usually vary", () => {
    const [q1, q2, q3, q4, q5] = surprises(five());
    expect(q5.sue).toBeCloseTo(2.598, 3);
    expect(q5.deviation).toBeCloseTo(0.023094, 5);
    expect(q5.history).toBe(4);
    expect(q5.change).toBeCloseTo(0.16, 10);
    expect([q1, q2, q3, q4].map((q) => q.sue)).toEqual([null, null, null, null]);
    expect([q1, q2, q3, q4].map((q) => q.history)).toEqual([0, 1, 2, 3]);
  });

  it("measures against the trend, so a company that always adds the same amount is not surprising for adding it", () => {
    const steady = ENDS.map((end, i) => quarter(end, i === 4 ? 0.1 : [0.09, 0.11, 0.09, 0.11][i]));
    // earlier changes average 0.10; a fifth of 0.10 is exactly on the trend
    expect(surprises(steady)[4].sue).toBeCloseTo(0, 6);
  });

  it("has no surprise when the earlier changes never varied (nothing to scale by)", () => {
    const flat = ENDS.map((end, i) => quarter(end, i === 4 ? 0.2 : 0.1));
    const last = surprises(flat)[4];
    expect(last.history).toBe(4);
    expect(last.deviation).toBeCloseTo(0, 9);
    expect(last.sue).toBeNull();
  });

  it("looks back over at most the last eight changes", () => {
    const ends = Array.from({ length: 11 }, (_, i) => plus("2023-03-31", i * 91));
    // two wild early changes, then nine ordinary ones
    const q = ends.map((end, i) => quarter(end, i < 2 ? 5 : 0.1 + (i % 2) * 0.02));
    const last = surprises(q)[10];
    expect(last.history).toBe(DRIFT_RULES.maxHistory);
    expect(last.deviation).toBeLessThan(0.05);
  });

  it("reads the later of two filings for the same quarter", () => {
    const original = quarter("2026-03-31", 0.1, { accession: "ORIG", filedOn: "2026-05-01" });
    const amended = quarter("2026-03-31", 0.3, { accession: "AMEND", filedOn: "2026-06-15" });
    const out = surprises([original, amended]);
    expect(out).toHaveLength(1);
    expect(out[0].accession).toBe("AMEND");
    expect(out[0].change).toBeCloseTo(0.3, 10);
  });

  it("falls back to net income over diluted shares when a filing reports no EPS, and says so", () => {
    const q = quarter("2026-03-31", 0, {
      current: { eps: null, netIncome: 120, shares: 100 },
      yearAgo: { eps: null, netIncome: 100, shares: 100 },
    });
    const [s] = surprises([q]);
    expect(s).toMatchObject({ basis: "derived", eps: 1.2, yearAgo: 1 });
    expect(s.change).toBeCloseTo(0.2, 10);
    expect(surprises(five())[0].basis).toBe("reported");
  });

  it("skips a quarter it cannot read at all", () => {
    const empty = quarter("2026-03-31", 0, { current: { eps: null, netIncome: null, shares: null } });
    expect(surprises([empty])).toEqual([]);
    // a zero share count is not a divisor
    const zero = quarter("2026-03-31", 0, { current: { eps: null, netIncome: 5, shares: 0 }, yearAgo: { eps: null, netIncome: 5, shares: 0 } });
    expect(surprises([zero])).toEqual([]);
  });
});

describe("the quarters a filing carries", () => {
  const row = (metric: string, periodEnd: string, value: number, over: Partial<FactRow> = {}): FactRow => ({
    accession: "A1",
    form: "10-Q",
    filedOn: "2026-08-05",
    metric,
    periodEnd,
    value,
    ...over,
  });

  it("takes the filing's own quarter and the same quarter a year before, from the one filing", () => {
    const rows = [
      row("eps_diluted", "2026-06-30", 1.2),
      row("eps_diluted", "2025-06-30", 1),
      row("net_income", "2026-06-30", 120),
      row("net_income", "2025-06-30", 100),
      row("shares_diluted", "2026-06-30", 100),
      row("shares_diluted", "2025-06-30", 100),
    ];
    expect(quartersFrom(rows)).toEqual([
      {
        accession: "A1",
        form: "10-Q",
        filedOn: "2026-08-05",
        periodEnd: "2026-06-30",
        current: { eps: 1.2, netIncome: 120, shares: 100 },
        yearAgo: { eps: 1, netIncome: 100, shares: 100 },
      },
    ]);
  });

  it("never takes a neighbouring quarter as the comparative", () => {
    // the prior quarter (91 days earlier) is in the filing too; only the quarter a year earlier will do
    const rows = [row("eps_diluted", "2026-06-30", 1.2), row("eps_diluted", "2026-03-31", 1.1), row("eps_diluted", "2025-06-30", 1)];
    const [q] = quartersFrom(rows);
    expect(q.yearAgo.eps).toBe(1);
    expect(quartersFrom([row("eps_diluted", "2026-06-30", 1.2), row("eps_diluted", "2026-03-31", 1.1)])).toEqual([]);
  });

  it("allows a few days either side of a year, for 52-week fiscal calendars", () => {
    expect(quartersFrom([row("eps_diluted", "2026-06-30", 1.2), row("eps_diluted", "2025-07-02", 1)])).toHaveLength(1);
    expect(quartersFrom([row("eps_diluted", "2026-06-30", 1.2), row("eps_diluted", "2025-05-31", 1)])).toHaveLength(0);
  });

  it("keeps filings apart", () => {
    const rows = [
      row("eps_diluted", "2026-06-30", 1.2),
      row("eps_diluted", "2025-06-30", 1),
      row("eps_diluted", "2025-06-30", 1, { accession: "A0", filedOn: "2025-08-05" }),
      row("eps_diluted", "2024-06-30", 0.9, { accession: "A0", filedOn: "2025-08-05" }),
    ];
    const out = quartersFrom(rows);
    expect(out.map((q) => q.accession).sort()).toEqual(["A0", "A1"]);
    expect(out.find((q) => q.accession === "A0")?.yearAgo.eps).toBe(0.9);
  });
});

describe("dating the announcement", () => {
  it("uses the earliest earnings release after the quarter closed and before the report", () => {
    expect(announcementOf("2026-06-30", "2026-08-05", ["2026-04-28", "2026-07-28", "2026-10-27"])).toEqual({ on: "2026-07-28", dating: "release" });
  });

  it("takes the earliest of two releases in the window", () => {
    expect(announcementOf("2026-06-30", "2026-08-05", ["2026-07-20", "2026-07-28"]).on).toBe("2026-07-20");
  });

  it("ignores a release from the quarter before, which falls within a week of the close", () => {
    expect(announcementOf("2026-06-30", "2026-08-05", ["2026-07-03"]).dating).toBe("filing");
  });

  it("allows an 8-K filed a few days after the 10-Q, but not weeks after", () => {
    expect(announcementOf("2026-06-30", "2026-08-05", ["2026-08-08"]).dating).toBe("release");
    expect(announcementOf("2026-06-30", "2026-08-05", ["2026-08-09"]).dating).toBe("filing");
  });

  it("falls back to the date the periodic report was filed, and says that is what it did", () => {
    expect(announcementOf("2026-06-30", "2026-08-05", [])).toEqual({ on: "2026-08-05", dating: "filing" });
  });
});

describe("the reaction", () => {
  const dates = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05"];
  const series = (closes: number[]): Bar[] => closes.map((close, i) => ({ date: dates[i], close }));
  const stock = series([100, 100, 100, 101, 105, 106, 107, 108]);
  const market = series([400, 400, 400, 401, 404, 405, 406, 408]);

  it("runs from the close before the announcement day to the close after it, less the market", () => {
    const r = reactionTo(stock, market, "2026-07-30");
    expect(r.status).toBe("measured");
    const reaction = (r as { reaction: Reaction }).reaction;
    expect(reaction).toMatchObject({ from: "2026-07-29", to: "2026-07-31", adjusted: true, sessionsSince: 3 });
    expect(reaction.stock).toBeCloseTo(0.05, 10);
    expect(reaction.market).toBeCloseTo(0.01, 10);
    expect(reaction.abnormal).toBeCloseTo(0.04, 10);
  });

  it("reads the drift since, also less the market", () => {
    const { reaction } = reactionTo(stock, market, "2026-07-30") as { reaction: Reaction };
    // 108 / 105 − 1 = 2.857%; 408 / 404 − 1 = 0.990%
    expect(reaction.drift).toBeCloseTo(108 / 105 - 1 - (408 / 404 - 1), 10);
  });

  it("starts from the next session when the announcement fell on a weekend", () => {
    const { reaction } = reactionTo(stock, market, "2026-08-01") as { reaction: Reaction };
    expect(reaction).toMatchObject({ from: "2026-07-31", to: "2026-08-04", sessionsSince: 1 });
  });

  it("has no drift yet on the session after the reaction closed", () => {
    // announced on the second-to-last session, so the reaction closes on the last one
    const { reaction } = reactionTo(stock, market, "2026-08-04") as { reaction: Reaction };
    expect(reaction).toMatchObject({ to: "2026-08-05", sessionsSince: 0, drift: null });
  });

  it("uses the stock's own return, and says so, when the market series cannot cover the dates", () => {
    const patchy = market.filter((b) => b.date !== "2026-07-31");
    const { reaction } = reactionTo(stock, patchy, "2026-07-30") as { reaction: Reaction };
    expect(reaction.adjusted).toBe(false);
    expect(reaction.market).toBeNull();
    expect(reaction.abnormal).toBeCloseTo(0.05, 10);
    expect(reactionTo(stock, null, "2026-07-30")).toMatchObject({ status: "measured", reaction: { adjusted: false } });
  });

  it("says why when there is nothing to read", () => {
    expect(reactionTo(stock, market, "2026-08-10")).toEqual({ status: "unmeasured", reason: expect.stringContaining("after the last stored session") });
    expect(reactionTo(stock, market, "2026-07-27")).toEqual({ status: "unmeasured", reason: expect.stringContaining("starts on 2026-07-27") });
    expect(reactionTo(stock, market, "2026-08-05")).toEqual({ status: "unmeasured", reason: expect.stringContaining("has not closed yet") });
  });
});

describe("the reading", () => {
  const surprise = (sue: number | null, over: Partial<Surprise> = {}): Surprise => ({
    periodEnd: "2026-03-31",
    filedOn: "2026-05-10",
    accession: "A",
    form: "10-Q",
    eps: 1.16,
    yearAgo: 1,
    change: 0.16,
    basis: "reported",
    sue,
    history: 4,
    deviation: 0.023,
    ...over,
  });
  const reaction = (abnormal: number, sessionsSince = 3): Reaction => ({
    announcedOn: "2026-04-28",
    from: "2026-04-27",
    to: "2026-04-29",
    stock: abnormal,
    market: 0,
    abnormal,
    adjusted: true,
    sessionsSince,
    drift: 0.01,
  });

  it("confirms a beat the market rewarded", () => {
    const r = readingOf(surprise(2.6), reaction(0.04));
    expect(r).toMatchObject({ surprise: "beat", move: "up", setup: "confirmed", live: true });
    expect(r.summary).toContain("EPS 1.16 against 1.00 a year earlier");
    expect(r.summary).toContain("a beat of +2.6 standard deviations");
    expect(r.summary).toContain("+4.0% against the market");
    expect(r.summary).toContain("inside the 60-session window");
  });

  it("confirms a miss the market punished", () => {
    expect(readingOf(surprise(-1.5, { eps: 0.9, change: -0.1 }), reaction(-0.03))).toMatchObject({ surprise: "miss", move: "down", setup: "confirmed" });
  });

  it("does not confirm a beat the market sold, or shrugged at", () => {
    const sold = readingOf(surprise(2.6), reaction(-0.02));
    expect(sold).toMatchObject({ setup: "unconfirmed", move: "down" });
    expect(sold.summary).toContain("the other way");
    const shrugged = readingOf(surprise(2.6), reaction(0.002));
    expect(shrugged).toMatchObject({ setup: "unconfirmed", move: "flat" });
    expect(shrugged.summary).toContain("not enough to count");
  });

  it("draws the lines at one deviation of surprise and half a percent of reaction, inclusive", () => {
    expect(readingOf(surprise(1), reaction(0.005))).toMatchObject({ surprise: "beat", move: "up", setup: "confirmed" });
    expect(readingOf(surprise(-1), reaction(-0.005))).toMatchObject({ surprise: "miss", move: "down", setup: "confirmed" });
    expect(readingOf(surprise(0.99), reaction(0.04))).toMatchObject({ surprise: "in line", setup: "none" });
  });

  it("sees no setup in a quarter that was in line", () => {
    const r = readingOf(surprise(0.4), reaction(0.06));
    expect(r.setup).toBe("none");
    expect(r.summary).toContain("in line with the company's own record");
  });

  it("scores no surprise when the company has too few earlier quarters", () => {
    const r = readingOf(surprise(null, { history: 2, deviation: null }), reaction(0.04));
    expect(r).toMatchObject({ surprise: "unscaled", setup: "unmeasured" });
    expect(r.summary).toContain("only 2 earlier quarters");
    expect(r.summary).toContain(`needs ${DRIFT_RULES.minHistory}`);
  });

  it("does not claim the market agreed when the reaction could not be read", () => {
    const r = readingOf(surprise(2.6), null);
    expect(r).toMatchObject({ move: null, setup: "unmeasured", live: false });
    expect(r.summary).toContain("could not be measured");
  });

  it("says when the window in which drift has been documented has passed", () => {
    const r = readingOf(surprise(2.6), reaction(0.04, 75));
    expect(r.live).toBe(false);
    expect(r.setup).toBe("confirmed");
    expect(r.summary).toContain("past the 60-session window");
    expect(readingOf(surprise(2.6), reaction(0.04, 60)).live).toBe(true);
  });

  it("says the move is not adjusted for the market when it was not", () => {
    const r = readingOf(surprise(2.6), { ...reaction(0.04), adjusted: false });
    expect(r.summary).toContain("not adjusted for the market");
  });
});

describe("the whole read", () => {
  // trading days from a start date, skipping weekends
  function sessions(from: string, closes: number[]): Bar[] {
    const out: Bar[] = [];
    let date = from;
    for (const close of closes) {
      while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = plus(date, 1);
      out.push({ date, close });
      date = plus(date, 1);
    }
    return out;
  }
  // 2026-04-20 is a Monday; the announcement on the 28th is the 7th session
  const stock = sessions("2026-04-20", [100, 100, 100, 100, 100, 100, 101, 105, 106, 107]);
  const market = sessions("2026-04-20", [400, 400, 400, 400, 400, 400, 401, 404, 405, 406]);

  const quarters = () => ENDS.map((end, i) => quarter(end, CHANGES[i], i === 4 ? { filedOn: "2026-05-10" } : {}));

  it("puts the surprise, the dated announcement and the reaction together", () => {
    const read = readDrift({ quarters: quarters(), releases: ["2026-04-28"], stock, market, latestReport: null });
    expect(read.status).toBe("measured");
    expect(read.latest?.sue).toBeCloseTo(2.598, 3);
    expect(read.announcement).toEqual({ on: "2026-04-28", dating: "release" });
    expect(read.reaction?.from).toBe("2026-04-27");
    expect(read.reaction?.to).toBe("2026-04-29");
    expect(read.reaction?.abnormal).toBeGreaterThan(0.03);
    expect(read.reading?.setup).toBe("confirmed");
    expect(read.quarters).toHaveLength(5);
    expect(read.newerReport).toBeNull();
    expect(read.asOf).toBe("2026-05-01");
  });

  it("is unmeasured, and says what to run, when no quarter can be read", () => {
    const read = readDrift({ quarters: [], releases: [], stock, market, latestReport: null });
    expect(read.status).toBe("unmeasured");
    expect(read.reason).toContain("npm run ingest-edgar");
    expect(read.reading).toBeNull();
  });

  it("still gives the surprise when there are no prices, and says why there is no reaction", () => {
    const read = readDrift({ quarters: quarters(), releases: [], stock: [], market: null, latestReport: null });
    expect(read.status).toBe("measured");
    expect(read.reaction).toBeNull();
    expect(read.reactionNote).toContain("no price history");
    expect(read.reading?.setup).toBe("unmeasured");
    // no release stored: dated by the 10-Q
    expect(read.announcement?.dating).toBe("filing");
  });

  it("warns when a newer annual report holds a quarter the desk cannot read", () => {
    const read = readDrift({ quarters: quarters(), releases: [], stock, market, latestReport: { form: "10-K", filedOn: "2026-09-15" } });
    expect(read.newerReport).toContain("A 10-K was filed on 2026-09-15");
    // the report filed within a week of the quarter's own is the same news, not a newer one
    const same = readDrift({ quarters: quarters(), releases: [], stock, market, latestReport: { form: "10-Q", filedOn: "2026-05-12" } });
    expect(same.newerReport).toBeNull();
  });

  it("keeps the last eight quarters for the table", () => {
    const ends = Array.from({ length: 12 }, (_, i) => plus("2023-03-31", i * 91));
    const read = readDrift({ quarters: ends.map((e, i) => quarter(e, 0.1 + (i % 2) * 0.02)), releases: [], stock, market, latestReport: null });
    expect(read.quarters).toHaveLength(8);
    expect(read.quarters.at(-1)).toBe(read.latest);
  });
});
