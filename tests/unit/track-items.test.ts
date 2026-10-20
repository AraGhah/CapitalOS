import { describe, expect, it } from "vitest";
import { trackItems } from "../../lib/ai/track-items";
import type { RecordedCall } from "../../lib/track/record";
import type { Outcome } from "../../lib/track/settle";

const SOURCE = { kind: "computed", ref: "computed from the decision_outcomes table by lib/track" };

const outcome = (horizon: number, over: Partial<Outcome> = {}): Outcome => ({
  horizon,
  verdict: "right",
  reason: null,
  entryDate: "2026-01-05",
  entryClose: 100,
  exitDate: `2026-02-${String(horizon).padStart(2, "0")}`,
  exitClose: 108,
  stockReturn: 0.08,
  marketReturn: 0.03,
  alpha: 0.05,
  path: null,
  ...over,
});

let n = 0;
const call = (outcomes: Outcome[], over: Partial<RecordedCall> = {}): RecordedCall => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
  ticker: "AAA",
  createdAt: "2026-01-05T12:00:00.000Z",
  asOf: "2026-01-05",
  rating: "buy",
  action: "buy",
  refPrice: 100,
  headline: "Buy",
  decision: {},
  outcomes,
  ...over,
});

describe("trackItems", () => {
  it("adds nothing when no decision has been measured", () => {
    expect(trackItems([], SOURCE)).toEqual([]);
    expect(trackItems([call([])], SOURCE)).toEqual([]);
    expect(trackItems([call([outcome(20, { verdict: "excluded", reason: "a split", stockReturn: null, marketReturn: null, alpha: null })])], SOURCE)).toEqual([]);
  });

  it("opens with a note saying these describe the past, then the figures of each call", () => {
    const items = trackItems([call([outcome(20)])], SOURCE);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ kind: "track", label: "The desk's own earlier decisions on this stock" });
    expect(items[0].text).toContain("1 earlier decision the person recorded");
    expect(items[0].text).toContain("do not say what the stock will do next");
    expect(items[0].value).toBeUndefined();
    expect(items.every((i) => i.kind === "track" && i.source === SOURCE)).toBe(true);
  });

  it("quotes the stock's return, the market's and the difference as ratios the fact checker can test", () => {
    const [, stock, market, alpha] = trackItems([call([outcome(20)])], SOURCE);
    expect(stock).toMatchObject({ value: 0.08, unit: "ratio", asOf: "2026-02-20" });
    expect(stock.label).toBe("Stock return over the 20 sessions after it (Buy decision of 2026-01-05)");
    expect(market).toMatchObject({ value: 0.03, unit: "ratio" });
    expect(market.label).toContain("S&P 500 return");
    expect(alpha).toMatchObject({ value: 0.05, unit: "ratio" });
    expect(alpha.label).toContain("stock less S&P 500");
  });

  it("says in words how the call turned out", () => {
    const verdicts = (["right", "wrong", "flat", "no_claim"] as const).map((verdict) => trackItems([call([outcome(20, { verdict })])], SOURCE)[4].text);
    expect(verdicts[0]).toMatch(/^right:/);
    expect(verdicts[1]).toMatch(/^wrong:/);
    expect(verdicts[2]).toMatch(/^too close to call:/);
    expect(verdicts[3]).toMatch(/^no call:/);
  });

  it("quotes the longest horizon that was measured", () => {
    const items = trackItems([call([outcome(5, { alpha: 0.01 }), outcome(60, { alpha: 0.2 }), outcome(20, { alpha: 0.05 })])], SOURCE);
    expect(items[3].value).toBe(0.2);
    expect(items[3].label).toContain("60 sessions");
  });

  it("skips an excluded horizon and quotes the longest one that was measured", () => {
    const items = trackItems([call([outcome(5), outcome(20, { verdict: "excluded", reason: "a split", stockReturn: null, marketReturn: null, alpha: null })])], SOURCE);
    expect(items[3].label).toContain("5 sessions");
  });

  it("quotes at most three calls, in the order given (newest first)", () => {
    const calls = ["A", "B", "C", "D"].map((t, i) => call([outcome(20)], { ticker: t, asOf: `2026-01-0${i + 1}` }));
    const items = trackItems(calls, SOURCE);
    expect(items).toHaveLength(1 + 3 * 4);
    expect(items[0].text).toContain("3 earlier decisions");
    expect(items.filter((i) => i.label.startsWith("Stock return")).map((i) => i.label.match(/of (\S+)\)/)?.[1])).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(trackItems(calls, SOURCE, 1)).toHaveLength(5);
  });

  it("dates a call by its record when it has no price date", () => {
    const items = trackItems([call([outcome(20)], { asOf: null, createdAt: "2026-03-09T10:00:00.000Z" })], SOURCE);
    expect(items[1].label).toContain("decision of 2026-03-09");
  });

  it("does not quote the ticker, the person or any lesson", () => {
    const text = JSON.stringify(trackItems([call([outcome(20)])], SOURCE));
    expect(text).not.toContain("AAA");
    expect(text.toLowerCase()).not.toContain("lesson");
  });
});
