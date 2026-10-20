import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PathResult } from "../../lib/track/paths";
import type { PlanCheck, PlanGroup } from "../../lib/track/plan-check";
import { trackRecord, type RecordedCall, type TrackRecord } from "../../lib/track/record";
import type { Outcome, Verdict } from "../../lib/track/settle";

const read = vi.hoisted(() => ({
  record: null as TrackRecord | Error | null,
  calls: null as RecordedCall[] | Error | null,
  check: null as PlanCheck | Error | null,
}));

// The panels' data layer is not what is under test.
vi.mock("@/lib/track/data", () => ({
  readTrackRecord: async () => {
    if (read.record instanceof Error) throw read.record;
    return read.record;
  },
  recordedCalls: async () => {
    if (read.calls instanceof Error) throw read.calls;
    return read.calls;
  },
  planCheckData: async () => {
    if (read.check instanceof Error) throw read.check;
    return read.check;
  },
}));

const { TrackRecordPanel, TrackRecordView, StockTrackPanel, StockTrackView, PlanCheckPanel, PlanCheckView } = await import("../../app/components/TrackPanels");

const outcome = (verdict: Verdict, alpha: number | null, over: Partial<Outcome> = {}): Outcome => ({
  horizon: 20,
  verdict,
  reason: verdict === "excluded" ? "a split fell between 2026-01-05 and 2026-02-02" : null,
  entryDate: verdict === "excluded" ? null : "2026-01-05",
  entryClose: verdict === "excluded" ? null : 100,
  exitDate: verdict === "excluded" ? null : "2026-02-02",
  exitClose: verdict === "excluded" ? null : 105,
  stockReturn: alpha === null ? null : alpha + 0.01,
  marketReturn: alpha === null ? null : 0.01,
  alpha,
  path: null,
  ...over,
});

const path = (over: Partial<PathResult> = {}): PathResult => ({
  kind: "market", filled: true, fillDate: "2026-01-05", fillPrice: 100, stopped: false, stopDate: null, exitPrice: 104,
  exitKind: "horizon", sessionsToStop: null, r: 0.8, reached: [1.5], ambiguous: false, ...over,
});

let seq = 0;
const call = (ticker: string, rating: RecordedCall["rating"], outcomes: Outcome[]): RecordedCall => ({
  id: `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`,
  ticker,
  createdAt: `2026-01-${String(10 + seq).padStart(2, "0")}T12:00:00.000Z`,
  asOf: "2026-01-05",
  rating,
  action: rating === "buy" ? "buy" : "hold",
  refPrice: 100,
  headline: `${rating} ${ticker}: the figures lean one way`,
  decision: { blockers: ["earnings are due"] },
  outcomes,
});

/* ------------------------------------------------------------------ the record */

describe("TrackRecordView", () => {
  it("says what to do when no decision has been recorded", () => {
    const html = renderToStaticMarkup(TrackRecordView({ record: trackRecord([]) }));
    expect(html).toContain("No decision has been recorded yet");
    expect(html).not.toContain("<table");
  });

  const twelveRight = Array.from({ length: 12 }, (_, i) => call(`R${i}`, "buy", [outcome("right", 0.05, { path: path() })]));
  const record = trackRecord([
    ...twelveRight,
    call("SELLY", "sell", [outcome("wrong", 0.06)]),
    call("HELD", "hold", [outcome("no_claim", 0.01)]),
    call("SPLIT", "buy", [outcome("excluded", null)]),
    call("NEW", "overweight", []),
  ]);
  const html = renderToStaticMarkup(TrackRecordView({ record }));

  it("counts the decisions, those measured and those still waiting", () => {
    expect(html).toContain("16 decisions");
    expect(html).toContain("15 measured at least once");
    expect(html).toContain("1 still waiting for their first horizon");
    expect(html).toContain("1 not fairly measurable");
  });

  it("shows the hit rate of each group with its interval and the comparison with a coin toss", () => {
    expect(html).toContain("<td>20 sessions</td><td>Buy / Overweight</td>");
    expect(html).toContain("100% (76%–100%)");
    expect(html).toContain("better than a coin toss");
    // the bearish group has one call: it declines to compare and says how many more it needs
    expect(html).toContain("needs 9 more decided calls");
    // nothing has reached 5 or 60 sessions
    expect(html).toContain("nothing measured yet");
  });

  it("explains the grading, the flat band and why a hold is not graded", () => {
    expect(html).toContain("±1.1% at 5, ±2.2% at 20, ±3.9% at 60");
    expect(html).toContain("neither side");
    expect(html).toContain("Holds make no call against the market");
  });

  it("shows how the plans' stops and reward levels fared", () => {
    expect(html).toContain("How the plans’ stops and reward levels fared");
    expect(html).toContain("Reached 1.5R first");
    expect(html).toContain("+0.80R");
  });

  it("lists the calls, newest first, each linking to its stock with what is still waiting", () => {
    expect(html).toContain('href="/research/NEW"');
    expect(html.indexOf("NEW")).toBeLessThan(html.indexOf("R0"));
    expect(html).toContain("waiting on 5, 20, 60 sessions");
    expect(html).toContain("waiting on 5, 60 sessions");
    expect(html).toContain("20 sessions: right (+5.0%)");
    expect(html).toContain("20 sessions: not measured");
  });

  it("puts what the record shows behind each call", () => {
    expect(html).toContain("What the record shows");
    expect(html).toContain("At the time the desk held back from buying: earnings are due.");
    expect(html).toContain("The plan reached 1.5R without hitting its stop in the 20 sessions (+0.8R).");
  });

  it("says it describes the past and that its intervals are optimistic", () => {
    expect(html).toContain("It describes the past; it is not a forecast.");
    expect(html).toContain("narrower than they should be");
    expect(html).toContain("10 decided");
  });

  it("names the S&P 500 and the lack of a model", () => {
    expect(html).toContain("against the S&amp;P 500");
    expect(html).toContain("no model");
  });

  it("omits the plan table when no decision had a walked plan", () => {
    const bare = renderToStaticMarkup(TrackRecordView({ record: trackRecord([call("AAA", "buy", [outcome("right", 0.05)])]) }));
    expect(bare).not.toContain("How the plans");
  });

  it("calls a clearly worse group worse than a coin toss", () => {
    const bad = trackRecord(Array.from({ length: 12 }, (_, i) => call(`B${i}`, "buy", [outcome(i === 0 ? "right" : "wrong", i === 0 ? 0.05 : -0.05)])));
    expect(renderToStaticMarkup(TrackRecordView({ record: bad }))).toContain("worse than a coin toss");
  });
});

describe("TrackRecordPanel", () => {
  it("reads the record and renders it", async () => {
    read.record = trackRecord([call("AAA", "buy", [outcome("right", 0.05)])]);
    const html = renderToStaticMarkup(await TrackRecordPanel({ userId: "u1" }));
    expect(html).toContain("1 decisions");
    expect(html).toContain("AAA");
  });

  it("says so, rather than failing the page, when the record cannot be read", async () => {
    read.record = new Error("connection refused");
    const html = renderToStaticMarkup(await TrackRecordPanel({ userId: "u1" }));
    expect(html).toContain("The track record could not be read: connection refused.");
  });
});

/* ------------------------------------------------------------------ one stock */

describe("StockTrackView", () => {
  it("offers to record a decision when there is none on the stock", () => {
    const html = renderToStaticMarkup(StockTrackView({ ticker: "AAA", calls: [] }));
    expect(html).toContain("Your earlier calls");
    expect(html).toContain("No decision recorded on AAA yet");
  });

  it("lists the stock's calls and links to the whole record", () => {
    const calls = trackRecord([call("AAA", "buy", [outcome("right", 0.05)])]).calls;
    const html = renderToStaticMarkup(StockTrackView({ ticker: "AAA", calls }));
    expect(html).toContain("20 sessions: right (+5.0%)");
    expect(html).toContain('href="/track"');
    expect(html).toContain("The committee sees the figures from calls that have been measured.");
  });
});

describe("StockTrackPanel", () => {
  it("reads the stock's decisions and renders them", async () => {
    read.calls = [call("AAA", "overweight", [outcome("wrong", -0.05)])];
    const html = renderToStaticMarkup(await StockTrackPanel({ userId: "u1", ticker: "AAA" }));
    expect(html).toContain("Overweight");
    expect(html).toContain("20 sessions: wrong");
  });

  it("says so when the decisions cannot be read", async () => {
    read.calls = new Error("down");
    expect(renderToStaticMarkup(await StockTrackPanel({ userId: "u1", ticker: "AAA" }))).toContain("Earlier calls could not be read: down.");
  });
});

/* ------------------------------------------------------------------ the plan check */

const group = (over: Partial<PlanGroup> = {}): PlanGroup => ({
  entries: 40, filled: 36, stopped: 18,
  reached: [{ multiple: 1.5, count: 18 }, { multiple: 2, count: 12 }, { multiple: 3, count: 6 }],
  meanR: 0.1, medianR: -0.2, meanHoldR: 0.3, ...over,
});

const check = (over: Partial<PlanCheck> = {}): PlanCheck => ({
  status: "measured", reason: null, horizon: 20, stopAtrs: 2, rewardMultiples: [1.5, 2, 3], tickers: 12,
  from: "2025-04-01", to: "2026-09-01",
  all: group(), market: group({ entries: 30, filled: 30, stopped: 15 }), pullback: group({ entries: 10, filled: 6, stopped: 3 }),
  medianRiskShare: 0.052, enough: true, ...over,
});

describe("PlanCheckView", () => {
  const html = renderToStaticMarkup(PlanCheckView({ check: check() }));

  it("describes what was tested", () => {
    expect(html).toContain("40 plans");
    expect(html).toContain("12 stocks");
    expect(html).toContain("2025-04-01 to 2026-09-01");
    expect(html).toContain("stop 2 ATRs, about 5% of the price");
    expect(html).toContain("Every 20 sessions on each stock");
  });

  it("shows how many filled plans were stopped and reached each level, with and without the stop", () => {
    expect(html).toContain("<td>All</td>");
    expect(html).toContain("<td>At the last close</td>");
    expect(html).toContain("<td>Waiting for a pullback</td>");
    expect(html).toContain("Reached 1.5R first");
    expect(html).toContain("Reached 3R first");
    // 18 of 36 filled
    expect(html).toContain('<td class="num">50%</td>');
    expect(html).toContain("+0.10R");
    expect(html).toContain("+0.30R");
  });

  it("explains R, the same-session rule and why the entries are fewer than they look", () => {
    expect(html).toContain("1R is the distance from the entry to the stop");
    expect(html).toContain("the stop is counted");
    expect(html).toContain("fewer independent observations than they look");
    expect(html).toContain("it is not a forecast");
  });

  it("calls a small sample an illustration and not a measurement", () => {
    expect(html).not.toContain("an illustration");
    expect(renderToStaticMarkup(PlanCheckView({ check: check({ enough: false }) }))).toContain("Fewer than 30 plans: read these as an illustration, not a measurement.");
  });

  it("leaves out a kind of entry that has no plans", () => {
    const only = renderToStaticMarkup(PlanCheckView({ check: check({ pullback: group({ entries: 0, filled: 0, stopped: 0, meanR: null, medianR: null, meanHoldR: null, reached: [] }) }) }));
    expect(only).not.toContain("Waiting for a pullback");
  });

  it("shows the reason instead of numbers when it could not be measured", () => {
    const html2 = renderToStaticMarkup(PlanCheckView({ check: check({ status: "unmeasured", reason: "no stock has stored prices; run npm run fetch-prices" }) }));
    expect(html2).toContain("run npm run fetch-prices");
    expect(html2).not.toContain("<table");
  });
});

describe("PlanCheckPanel", () => {
  it("reads the check and renders it", async () => {
    read.check = check();
    expect(renderToStaticMarkup(await PlanCheckPanel())).toContain("40 plans");
  });

  it("says so when the check cannot be read", async () => {
    read.check = new Error("down");
    expect(renderToStaticMarkup(await PlanCheckPanel())).toContain("The plan check could not be read: down.");
  });
});
