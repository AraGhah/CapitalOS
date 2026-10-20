import { describe, expect, it } from "vitest";
import type { Sentiment } from "../../lib/sentiment";
import { DEV, HELD_OUT, type Gold } from "../../lib/sentiment/gold";
import { benchmarkSummary, evaluate, explain, majorityAccuracy, parseGold, wilson } from "../../lib/sentiment/benchmark";

const B: Sentiment = "bullish";
const N: Sentiment = "neutral";
const R: Sentiment = "bearish";

const gold = (labels: Sentiment[], kinds: Gold["kind"][] = []): Gold[] => labels.map((label, i) => ({ title: `headline ${i}`, label, kind: kinds[i] ?? "plain" }));

describe("evaluate", () => {
  // reader:  B B N N R R
  // tagger:  B N N N R B
  //   bullish: 2 said, 1 right; predicted twice (one is the bearish headline)
  //   neutral: 2 said, 2 right; predicted three times
  //   bearish: 2 said, 1 right; predicted once
  const result = evaluate("tagger", gold([B, B, N, N, R, R]), [B, N, N, N, R, B]);

  it("counts the confusion matrix by what the reader said and what the tagger said", () => {
    expect(result.confusion).toEqual({
      bullish: { bullish: 1, neutral: 1, bearish: 0 },
      neutral: { bullish: 0, neutral: 2, bearish: 0 },
      bearish: { bullish: 1, neutral: 0, bearish: 1 },
    });
    expect(result.n).toBe(6);
    expect(result.accuracy).toBeCloseTo(4 / 6, 10);
  });

  it("works out precision, recall and F1 for each class", () => {
    expect(result.perClass.bullish).toMatchObject({ precision: 0.5, recall: 0.5, support: 2 });
    expect(result.perClass.bullish.f1).toBeCloseTo(0.5, 10);
    expect(result.perClass.neutral.precision).toBeCloseTo(2 / 3, 10);
    expect(result.perClass.neutral.recall).toBe(1);
    expect(result.perClass.neutral.f1).toBeCloseTo(0.8, 10);
    expect(result.perClass.bearish).toMatchObject({ precision: 1, recall: 0.5 });
    expect(result.perClass.bearish.f1).toBeCloseTo(2 / 3, 10);
  });

  it("averages F1 plainly for the macro figure and by support for the weighted one", () => {
    expect(result.macroF1).toBeCloseTo((0.5 + 0.8 + 2 / 3) / 3, 10);
    // equal support, so the two agree here
    expect(result.weightedF1).toBeCloseTo(result.macroF1, 10);

    // reader: B B B N R    tagger: B B N N B  — nothing is ever tagged bearish
    const lopsided = evaluate("lopsided", gold([B, B, B, N, R]), [B, B, N, N, B]);
    expect(lopsided.accuracy).toBeCloseTo(3 / 5, 10);
    expect(lopsided.perClass.bearish).toMatchObject({ precision: null, recall: 0, f1: 0, support: 1 });
    expect(lopsided.macroF1).toBeCloseTo((2 / 3 + 2 / 3 + 0) / 3, 10);
    expect(lopsided.weightedF1).toBeCloseTo((3 * (2 / 3) + 1 * (2 / 3) + 0) / 5, 10);
  });

  it("lists the misses with what the tagger saw", () => {
    const withReason = evaluate("tagger", gold([B, N]), [N, N], (title) => `saw nothing in ${title}`);
    expect(withReason.misses).toEqual([{ title: "headline 0", expected: "bullish", got: "neutral", kind: "plain", why: "saw nothing in headline 0" }]);
  });

  it("scores each kind of headline separately, worst first", () => {
    const byKind = evaluate("tagger", gold([B, B, N, R], ["negation", "negation", "routine", "routine"]), [R, B, N, R]);
    expect(byKind.byKind).toEqual([
      { kind: "negation", n: 2, accuracy: 0.5 },
      { kind: "routine", n: 2, accuracy: 1 },
    ]);
  });

  it("refuses labels that do not line up with the headlines", () => {
    expect(() => evaluate("short", gold([B, N]), [B])).toThrow("short: 1 labels for 2 headlines");
  });

  it("scores an empty set as nothing rather than dividing by zero", () => {
    const none = evaluate("none", [], []);
    expect(none).toMatchObject({ n: 0, accuracy: 0, macroF1: 0, weightedF1: 0, interval: [0, 0] });
  });
});

describe("wilson", () => {
  it("is the usual 95% interval", () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
  });

  it("stays inside 0 and 1 and does not collapse at the extremes", () => {
    const [lo, hi] = wilson(10, 10);
    expect(hi).toBe(1);
    expect(lo).toBeGreaterThan(0.7);
    expect(lo).toBeLessThan(0.75);
    const [zeroLo, zeroHi] = wilson(0, 10);
    expect(zeroLo).toBe(0);
    expect(zeroHi).toBeGreaterThan(0.2);
  });

  it("narrows as the set grows", () => {
    const narrow = wilson(900, 1000);
    const wide = wilson(90, 100);
    expect(narrow[1] - narrow[0]).toBeLessThan(wide[1] - wide[0]);
  });
});

describe("majorityAccuracy", () => {
  it("is the share of the commonest label", () => {
    expect(majorityAccuracy(gold([B, B, B, N, R]))).toBeCloseTo(0.6, 10);
    expect(majorityAccuracy([])).toBe(0);
  });
});

describe("explain", () => {
  it("names the words that moved the score", () => {
    expect(explain("Apple beats earnings estimates")).toBe("beats +2 → +2");
    expect(explain("Apple unveils new iPhone")).toBe("no sentiment words");
  });
});

describe("parseGold", () => {
  it("reads a file of the user's own labelled headlines", () => {
    expect(parseGold([{ title: " Apple beats ", label: "bullish" }, { title: "Meta cuts jobs", label: "bearish", kind: "phrase" }])).toEqual([
      { title: "Apple beats", label: "bullish", kind: "plain" },
      { title: "Meta cuts jobs", label: "bearish", kind: "phrase" },
    ]);
  });

  it("names what is wrong rather than skipping the item", () => {
    expect(() => parseGold({})).toThrow("expected a JSON array");
    expect(() => parseGold([{ title: "", label: "bullish" }])).toThrow("item 0: title");
    expect(() => parseGold([{ title: "ok", label: "bullish" }, { title: "x", label: "up" }])).toThrow("item 1: label");
    expect(() => parseGold([{ title: "x", label: "neutral", kind: "weird" }])).toThrow("item 0: kind");
    expect(() => parseGold([null])).toThrow("item 0: title");
  });
});

describe("the labelled sets", () => {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

  it("are balanced, so always saying one thing scores a third", () => {
    for (const set of [DEV, HELD_OUT]) {
      for (const label of [B, N, R]) expect(set.filter((g) => g.label === label).length).toBe(set.length / 3);
    }
    expect(HELD_OUT).toHaveLength(120);
    expect(DEV).toHaveLength(240);
    expect(majorityAccuracy(HELD_OUT)).toBeCloseTo(1 / 3, 10);
  });

  it("share no headline between the development and held-out sets", () => {
    const seen = new Set(DEV.map((g) => norm(g.title)));
    expect(HELD_OUT.filter((g) => seen.has(norm(g.title)))).toEqual([]);
  });

  it("repeat no headline within a set", () => {
    for (const set of [DEV, HELD_OUT]) expect(new Set(set.map((g) => norm(g.title))).size).toBe(set.length);
  });
});

describe("benchmarkSummary", () => {
  it("reports both sets for the rules and the word list without the headlines themselves", () => {
    const summary = benchmarkSummary();
    expect(summary.heldOut).toMatchObject({ n: 120, name: "held out" });
    expect(summary.dev).toMatchObject({ n: 240, name: "development" });
    expect(summary.heldOut.rules.name).toBe("rules (current)");
    expect(summary.heldOut.wordList.name).toBe("word list (before)");
    expect(JSON.stringify(summary)).not.toContain('"gold"');
  });

  it("is worked out once", () => {
    expect(benchmarkSummary()).toBe(benchmarkSummary());
  });
});
