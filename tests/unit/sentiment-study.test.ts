import { describe, expect, it } from "vitest";
import type { Sentiment } from "../../lib/sentiment";
import { STUDY_RULES, dayLabels, groupOf, indexOnOrBefore, studyOf, windowOf, type Close, type StudyInput, type TaggedHeadline } from "../../lib/sentiment/study";

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isWeekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

// Consecutive weekdays from a Monday, with the given closes.
function bars(closes: number[], from = "2026-03-02"): Close[] {
  const out: Close[] = [];
  let date = from;
  for (const close of closes) {
    while (!isWeekday(date)) date = plus(date, 1);
    out.push({ date, close });
    date = plus(date, 1);
  }
  return out;
}

const head = (companyId: string, date: string, label: Sentiment): TaggedHeadline => ({ companyId, date, label });
const input = (over: Partial<StudyInput>): StudyInput => ({ headlines: [], bars: new Map(), market: bars([100, 100, 100, 100, 100, 100, 100, 100]), splits: new Map(), ...over });

describe("dayLabels", () => {
  it("reads a company-day by whether its bullish headlines outnumber its bearish ones", () => {
    const days = dayLabels([
      head("a", "2026-03-02", "bullish"),
      head("a", "2026-03-02", "bullish"),
      head("a", "2026-03-02", "bearish"),
      head("b", "2026-03-02", "bearish"),
      head("c", "2026-03-02", "bullish"),
      head("c", "2026-03-02", "bearish"),
      head("d", "2026-03-02", "neutral"),
    ]);
    const label = (id: string) => days.find((d) => d.companyId === id)?.label;
    expect(label("a")).toBe("bullish");
    expect(label("b")).toBe("bearish");
    expect(label("c")).toBe("neutral");
    expect(label("d")).toBe("neutral");
  });

  it("counts a story printed many times as one day, and the same company on two days as two", () => {
    const copies = Array.from({ length: 12 }, () => head("a", "2026-03-02", "bullish"));
    expect(dayLabels(copies)).toHaveLength(1);
    expect(dayLabels([head("a", "2026-03-02", "bullish"), head("a", "2026-03-03", "bearish")])).toHaveLength(2);
  });
});

describe("indexOnOrBefore", () => {
  const series = bars([1, 2, 3, 4]); // Mon 2 – Thu 5 March 2026
  it("finds the last bar on or before a date", () => {
    expect(indexOnOrBefore(series, "2026-03-03")).toBe(1);
    expect(indexOnOrBefore(series, "2026-03-07")).toBe(3); // a Saturday after the last bar
    expect(indexOnOrBefore(series, "2026-03-01")).toBe(-1);
    expect(indexOnOrBefore([], "2026-03-01")).toBe(-1);
  });
});

describe("groupOf", () => {
  it("works out the mean, the standard error and the share above zero", () => {
    const g = groupOf([0.01, 0.02, 0.03]);
    expect(g.n).toBe(3);
    expect(g.mean).toBeCloseTo(0.02, 12);
    expect(g.se).toBeCloseTo(Math.sqrt(0.0001 / 3), 12);
    expect(g.positive).toBe(1);
    expect(groupOf([-0.01, 0.01, 0.02, -0.02]).positive).toBe(0.5);
  });

  it("has no spread to report for fewer than two observations", () => {
    expect(groupOf([])).toEqual({ n: 0, mean: null, se: null, positive: null });
    expect(groupOf([0.05])).toMatchObject({ n: 1, mean: 0.05, se: null });
  });
});

describe("windowOf", () => {
  const around = (centre: number, n = 40) => Array.from({ length: n }, (_, i) => centre + (i % 2 === 0 ? 0.005 : -0.005));
  const samples = (bullish: number[], bearish: number[], neutral: number[] = []) => ({ bullish, neutral, bearish });

  it("says the labels followed the stock when bullish days beat bearish days by two standard errors", () => {
    const w = windowOf("d1", "Next session", false, samples(around(0.01), around(-0.01)));
    expect(w.verdict).toBe("followed");
    expect(w.spread?.value).toBeCloseTo(0.02, 10);
    expect(w.spread?.z).toBeGreaterThan(STUDY_RULES.z);
    expect(w.note).toBeNull();
  });

  it("says they reversed when it goes the other way", () => {
    expect(windowOf("d1", "x", false, samples(around(-0.01), around(0.01))).verdict).toBe("reversed");
  });

  it("finds no difference when the two groups look alike", () => {
    const w = windowOf("d5", "x", false, samples(around(0.002), around(0.002)));
    expect(w.verdict).toBe("no_difference");
    expect(w.spread?.z).toBeCloseTo(0, 10);
  });

  it("will not compare groups smaller than the minimum, and says how many more days it needs", () => {
    const w = windowOf("d1", "x", false, samples(around(0.01, 29), around(-0.01, 12)));
    expect(w.verdict).toBe("not_enough");
    expect(w.note).toBe(`needs 1 more bullish days and ${STUDY_RULES.minPerGroup - 12} more bearish days before the two can be compared`);
    // the spread is still computed, for reading
    expect(w.spread).not.toBeNull();
  });

  it("has nothing to say about an empty group", () => {
    const w = windowOf("d1", "x", false, samples(around(0.01), []));
    expect(w.verdict).toBe("not_enough");
    expect(w.spread).toBeNull();
    expect(w.groups.bearish).toEqual({ n: 0, mean: null, se: null, positive: null });
  });

  it("keeps the concurrent flag so the same-day window is never read as a test", () => {
    expect(windowOf("sameDay", "Same day", true, samples(around(0.01), around(-0.01))).concurrent).toBe(true);
  });
});

describe("studyOf", () => {
  it("is unmeasured, with a reason, when there is nothing to measure", () => {
    expect(studyOf(input({}))).toMatchObject({ status: "unmeasured", windows: [] });
    expect(studyOf(input({})).reason).toContain("no headline has a label");

    const noMarket = studyOf(input({ headlines: [head("a", "2026-03-04", "bullish")], market: null }));
    expect(noMarket.reason).toContain("npm run fetch-prices");
    expect(noMarket.reason).not.toContain("yahoo");

    const noPrices = studyOf(input({ headlines: [head("a", "2026-03-04", "bullish")] }));
    expect(noPrices.status).toBe("unmeasured");
    expect(noPrices.reason).toContain("none of the labelled days has stored prices");
  });

  it("measures the stock less the market from the close of the day the news appeared", () => {
    // Mon..Fri closes of 100, 102, 104.04, 101.9592, 110; the market is flat then +1% on Thursday.
    const stock = bars([100, 102, 104.04, 101.9592, 110, 110, 110, 110]);
    const market = bars([200, 200, 200, 202, 202, 202, 202, 202]);
    const r = studyOf(input({ headlines: [head("a", "2026-03-04", "bullish")], bars: new Map([["a", stock]]), market }));

    expect(r).toMatchObject({ status: "measured", days: 1, companies: 1, from: "2026-03-04", to: "2026-03-04" });
    const [same, d1, d5] = r.windows;
    // Wednesday's close against Tuesday's: +2.0%, the market flat
    expect(same.groups.bullish.mean).toBeCloseTo(104.04 / 102 - 1, 10);
    expect(same.concurrent).toBe(true);
    // Thursday against Wednesday: the stock −2%, the market +1%
    expect(d1.groups.bullish.mean).toBeCloseTo(101.9592 / 104.04 - 1 - 0.01, 10);
    // five sessions on, the following Wednesday: the stock +5.7%, the market +1%
    expect(d5.groups.bullish.mean).toBeCloseTo(110 / 104.04 - 1 - 0.01, 10);
    // one day is far short of the thirty a group needs before it is compared
    expect(d1.verdict).toBe("not_enough");
  });

  it("takes the previous close for news that appeared on a weekend, and leaves it out of the same-day window", () => {
    const stock = bars([100, 101, 102, 103, 104, 106, 107, 108]); // Mon 2 – Wed 11 March
    const r = studyOf(input({ headlines: [head("a", "2026-03-07", "bearish")], bars: new Map([["a", stock]]) }));
    const [same, d1] = r.windows;
    expect(same.groups.bearish.n).toBe(0);
    // Friday 6th's close to Monday 9th's
    expect(d1.groups.bearish.mean).toBeCloseTo(106 / 104 - 1, 10);
  });

  it("drops a window that spans a split, but keeps the ones that do not", () => {
    const stock = bars([100, 101, 102, 103, 104, 105, 106, 107]);
    const headlines = [head("a", "2026-03-03", "bullish")];
    const split = studyOf(input({ headlines, bars: new Map([["a", stock]]), splits: new Map([["a", ["2026-03-04"]]]) }));
    expect(split.windows[1].groups.bullish.n).toBe(0); // Tue close to Wed close crosses the 4th
    const earlier = studyOf(input({ headlines, bars: new Map([["a", stock]]), splits: new Map([["a", ["2026-03-03"]]]) }));
    expect(earlier.windows[1].groups.bullish.n).toBe(1); // the split is on the entry day, already in the entry close
  });

  it("drops a window across a gap in the stored prices", () => {
    const stock: Close[] = [
      { date: "2026-03-02", close: 100 },
      { date: "2026-03-03", close: 101 },
      { date: "2026-03-30", close: 110 }, // four weeks of missing bars
    ];
    const market: Close[] = stock.map((b) => ({ date: b.date, close: 100 }));
    const r = studyOf(input({ headlines: [head("a", "2026-03-03", "bullish")], bars: new Map([["a", stock]]), market }));
    expect(r.windows[1].groups.bullish.n).toBe(0);
  });

  it("needs the market's close on both ends of a window", () => {
    const stock = bars([100, 101, 102, 103, 104, 105, 106, 107]);
    const market = bars([100, 100, 100, 100]); // stops before the stock's window ends
    const r = studyOf(input({ headlines: [head("a", "2026-03-06", "bullish")], bars: new Map([["a", stock]]), market }));
    expect(r.status).toBe("unmeasured");
    expect(r.reason).toContain("none of the labelled days has stored prices around it");
  });

  it("finds the labels followed the stock when enough days line up", () => {
    // 40 bullish companies rise 2% the next session and 40 bearish ones fall 2%, each by a slightly different amount.
    const stocks = new Map<string, Close[]>();
    const headlines: TaggedHeadline[] = [];
    for (let i = 0; i < 80; i++) {
      const up = i < 40;
      const move = (up ? 1 : -1) * (0.02 + 0.001 * (i % 5));
      stocks.set(`c${i}`, bars([100, 100, 100 * (1 + move), 100 * (1 + move), 100 * (1 + move), 100 * (1 + move), 100 * (1 + move), 100 * (1 + move)]));
      headlines.push(head(`c${i}`, "2026-03-03", up ? "bullish" : "bearish"));
    }
    const r = studyOf(input({ headlines, bars: stocks }));
    expect(r.days).toBe(80);
    expect(r.companies).toBe(80);
    const d1 = r.windows.find((w) => w.key === "d1")!;
    expect(d1.groups.bullish.n).toBe(40);
    expect(d1.groups.bearish.n).toBe(40);
    expect(d1.verdict).toBe("followed");
    // the move holds for the five-session window too, and nothing had happened by the close of the day itself
    expect(r.windows.find((w) => w.key === "d5")!.verdict).toBe("followed");
    const same = r.windows.find((w) => w.key === "sameDay")!;
    expect(same.concurrent).toBe(true);
    expect(same.groups.bullish.mean).toBeCloseTo(0, 12);
  });
});
