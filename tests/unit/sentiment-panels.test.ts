import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SentimentStudyRead } from "../../lib/sentiment/data";
import { windowOf, type Group, type StudyResult } from "../../lib/sentiment/study";
import { benchmarkSummary } from "../../lib/sentiment/benchmark";

const read = vi.hoisted(() => ({ current: null as SentimentStudyRead | Error | null }));

// The panel's data layer is not what is under test.
vi.mock("@/lib/sentiment/data", () => ({
  sentimentStudy: async () => {
    if (read.current instanceof Error) throw read.current;
    return read.current;
  },
}));

const { SentimentBenchmarkPanel, SentimentBenchmarkView } = await import("../../app/components/SentimentBenchmarkPanel");
const { SentimentStudyPanel, SentimentStudyView } = await import("../../app/components/SentimentStudyPanel");

describe("SentimentBenchmarkView", () => {
  const html = renderToStaticMarkup(SentimentBenchmarkView({ summary: benchmarkSummary() }));
  const { heldOut, dev } = benchmarkSummary();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  it("leads with the held-out accuracy and what it is up against", () => {
    expect(html).toContain("Labelling accuracy");
    expect(html).toContain(`${pct(heldOut.rules.accuracy)} on headlines it was not fitted to`);
    expect(html).toContain(`old word list ${(heldOut.wordList.accuracy * 100).toFixed(0)}%`);
    expect(html).toContain("guessing the commonest label 33%");
  });

  it("scores both taggers on both sets, with the interval", () => {
    for (const split of ["held out", "development"]) expect(html).toContain(`<td>${split}</td>`);
    expect(html).toContain("rules (current)");
    expect(html).toContain("word list (before)");
    expect(html).toContain(`${pct(heldOut.rules.interval[0])} – ${pct(heldOut.rules.interval[1])}`);
    expect(html).toContain(`<td class="num">${dev.n}</td>`);
  });

  it("shows where the held-out headlines went and how it did by kind", () => {
    expect(html).toContain("Where the held-out headlines went");
    expect(html).toContain("By kind of headline");
    expect(html).toContain(">routine</td>");
  });

  it("lists every miss, with what the tagger saw", () => {
    expect(html).toContain(`The ${heldOut.rules.misses.length} it got wrong`);
    expect(html.split("read as ").length - 1).toBe(heldOut.rules.misses.length);
  });

  it("says plainly that the figure is an upper bound and how to get a trustworthy one", () => {
    expect(html).toContain("Read this as an upper bound");
    expect(html).toContain("83%");
    expect(html).toContain("--gold=yours.json");
  });

  it("renders from the shipped sets without a database", () => {
    expect(renderToStaticMarkup(SentimentBenchmarkPanel())).toContain("Labelling accuracy");
  });
});

/* ------------------------------------------------------------------ the study */

const group = (n: number, mean: number | null): Group => ({ n, mean, se: mean === null ? null : 0.004, positive: mean === null ? null : 0.6 });
const samples = (n: number, bull: number, bear: number) => ({
  bullish: Array.from({ length: n }, (_, i) => bull + (i % 2 ? 0.004 : -0.004)),
  neutral: Array.from({ length: n }, (_, i) => 0 + (i % 2 ? 0.004 : -0.004)),
  bearish: Array.from({ length: n }, (_, i) => bear + (i % 2 ? 0.004 : -0.004)),
});

const measured = (over: Partial<StudyResult> = {}): StudyResult => ({
  status: "measured",
  reason: null,
  days: 410,
  companies: 12,
  from: "2026-01-05",
  to: "2026-10-02",
  windows: [
    windowOf("sameDay", "Same day (concurrent with the news)", true, samples(40, 0.02, -0.02)),
    windowOf("d1", "Next session after that day's close", false, samples(40, 0.01, -0.01)),
    windowOf("d5", "Next 5 sessions after that day's close", false, samples(12, 0.01, -0.01)),
  ],
  ...over,
});

const study = (over: Partial<SentimentStudyRead> = {}): SentimentStudyRead => ({
  headlines: 900,
  byLabel: { bullish: 300, neutral: 450, bearish: 150 },
  all: measured(),
  by: [{ labeller: "rules", headlines: 900, study: measured() }],
  ...over,
});

const view = (r = study()) => renderToStaticMarkup(SentimentStudyView({ read: r }));

describe("SentimentStudyView", () => {
  it("counts the labelled headlines by label", () => {
    const html = view();
    expect(html).toContain("300 bullish");
    expect(html).toContain("450 neutral");
    expect(html).toContain("150 bearish");
  });

  it("shows each window's groups and says whether the labels followed the stock", () => {
    const html = view();
    expect(html).toContain("Next session after that day&#x27;s close");
    expect(html).toContain('class="pill good">bullish days did better</span>');
    expect(html).toContain("+1.00%");
    expect(html).toContain("−1.00%");
    expect(html).toContain("±0.06%");
    expect(html).toContain("(z = 22.1; the bar is 2)");
    expect(html).toContain("410 company-days across 12 companies, 2026-01-05 to 2026-10-02");
  });

  it("shows the same-day window as concurrent and never as a verdict", () => {
    const html = view();
    expect(html).toContain("concurrent: shown, not tested");
    expect(html.split("bullish days did better").length - 1).toBe(1);
  });

  it("says what is missing for a window that has too few days", () => {
    const html = view();
    expect(html).toContain("not enough days</span>");
    expect(html).toContain("needs 18 more bullish days and 18 more bearish days before the two can be compared");
  });

  it("shows the unmeasured reason instead of numbers", () => {
    const unmeasured: StudyResult = { status: "unmeasured", reason: "the S&P 500 benchmark has no stored prices; run npm run fetch-prices", days: 0, companies: 0, from: null, to: null, windows: [] };
    const html = view(study({ all: unmeasured, by: [{ labeller: "rules", headlines: 900, study: unmeasured }] }));
    expect(html).toContain("run npm run fetch-prices");
    expect(html).not.toContain("<table");
  });

  it("separates the labellers when more than one has labelled anything", () => {
    const html = view(
      study({
        by: [
          { labeller: "word list", headlines: 600, study: measured() },
          { labeller: "rules", headlines: 300, study: measured() },
        ],
      })
    );
    expect(html).toContain("Labelled by the old word list");
    expect(html).toContain("Labelled by the rules");
    expect(html).not.toContain("All labelled headlines");
  });

  it("does not repeat a lone labeller's figures under two headings", () => {
    expect(view()).toContain("All labelled headlines");
  });

  it("says it measures the past and that the committee does not read it", () => {
    const html = view();
    expect(html).toContain("not a forecast");
    expect(html).toContain("the committee does not read it");
    expect(html).toContain("narrower than they should be");
  });

  it("handles a group with no days at all", () => {
    const empty = windowOf("d1", "Next session after that day's close", false, { bullish: [], neutral: [], bearish: [] });
    expect(empty.groups.bullish).toEqual(group(0, null));
    const html = view(study({ all: measured({ windows: [empty] }), by: [] }));
    expect(html).toContain("—");
  });
});

describe("SentimentStudyPanel", () => {
  it("reads the study and renders it", async () => {
    read.current = study();
    expect(renderToStaticMarkup(await SentimentStudyPanel())).toContain("Did the labels line up with the stock?");
  });

  it("says so, rather than failing the page, when the study cannot be read", async () => {
    read.current = new Error("connection refused");
    const html = renderToStaticMarkup(await SentimentStudyPanel());
    expect(html).toContain("The study could not be read: connection refused.");
  });
});
