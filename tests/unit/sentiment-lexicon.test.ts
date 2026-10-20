import { describe, expect, it } from "vitest";
import { LEXICON_PROVIDER, summarize, tagByLexicon } from "../../lib/sentiment";
import { LEXICON_RULES, readHeadline, tokensOf } from "../../lib/sentiment/lexicon";
import { tagByWordList } from "../../lib/sentiment/legacy";
import { benchmarkSummary } from "../../lib/sentiment/benchmark";

const read = readHeadline;
const terms = (title: string) => read(title).hits.map((h) => h.term);

describe("the rule-based headline tagger", () => {
  it("labels plain good and bad news and leaves routine news neutral", () => {
    expect(read("Apple beats earnings estimates")).toMatchObject({ label: "bullish", score: 2 });
    expect(read("Meta plans layoffs")).toMatchObject({ label: "bearish", score: -2 });
    expect(read("Apple unveils new iPhone")).toMatchObject({ label: "neutral", score: 0, hits: [] });
    expect(read("Fed holds rates steady").label).toBe("neutral");
    expect(read("")).toMatchObject({ label: "neutral", score: 0, hits: [] });
  });

  it("flips a word a negator reaches", () => {
    expect(read("Apple does not beat earnings estimates")).toMatchObject({ label: "bearish", score: -2 });
    expect(read("Apple fails to beat estimates").label).toBe("bearish");
  });

  it("weighs the clause after 'but' over the one before it", () => {
    const r = read("Nvidia profit rises but guidance disappoints");
    expect(r.label).toBe("bearish");
    const weight = (term: string) => r.hits.find((h) => h.term === term)!.weight;
    // the good news before it is halved and the bad news after it is lifted by half again
    expect(weight("profit")).toBeCloseTo(1 * LEXICON_RULES.beforeBut, 6);
    expect(weight("disappoints")).toBeCloseTo(-2 * LEXICON_RULES.afterBut, 6);
    expect(r.score).toBeCloseTo(r.hits.reduce((sum, h) => sum + h.weight, 0), 6);
  });

  it("discounts what follows 'despite', so the main clause decides", () => {
    expect(read("Tesla shares surge despite recall").label).toBe("bullish");
    expect(read("Tesla shares fall despite strong earnings").label).toBe("bearish");
    expect(read("Tesla shares surge despite recall").score).toBeCloseTo(2 + LEXICON_RULES.concession * -2, 6);
  });

  it("damps a hypothetical and a question rather than reading them as news", () => {
    expect(read("Nvidia could surge if demand holds").score).toBeLessThan(read("Nvidia surges").score);
    const asked = read("Will Apple surge after earnings?");
    expect(asked.label).toBe("neutral");
    expect(Math.abs(asked.score)).toBeLessThan(LEXICON_RULES.threshold);
  });

  it("reads a percentage move by its direction and size", () => {
    expect(terms("Apple stock up 12% on record sales")).toContain("up 12%");
    expect(read("Apple stock up 12% on record sales").hits.find((h) => h.term === "up 12%")?.weight).toBe(LEXICON_RULES.percentStrong);
    expect(read("Apple stock down 3% on weak demand").hits.find((h) => h.term === "down 3%")?.weight).toBe(-LEXICON_RULES.percentMild);
  });

  it("reads what a verb did to a figure, not the verb alone", () => {
    expect(read("Microsoft raises dividend").label).toBe("bullish");
    expect(read("Microsoft cuts jobs").label).toBe("bearish");
    expect(read("Microsoft cuts forecast").label).toBe("bearish");
    // the verb alone is only mildly bad; with a figure to cut it is firmly so
    expect(read("Microsoft cuts ribbon").score).toBe(-1);
    expect(read("Microsoft cuts jobs").score).toBe(-2);
  });

  it("reads a rising burden as bad news", () => {
    expect(read("Costs are rising for Boeing")).toMatchObject({ label: "bearish" });
    expect(read("Revenue is rising for Boeing").label).toBe("bullish");
  });

  it("reads 'above' and 'below' against a benchmark", () => {
    expect(read("Amazon revenue above estimates").label).toBe("bullish");
    expect(read("Amazon revenue below estimates").label).toBe("bearish");
  });

  it("reads closing a site as bad news, whether the noun is singular or plural", () => {
    expect(read("Intel closes plant in Ohio")).toMatchObject({ label: "bearish", score: -2 });
    expect(read("Starbucks closes store in Seattle").label).toBe("bearish");
    expect(read("Ford closes factories").label).toBe("bearish");
    // the sale of a plant is not the closing of one
    expect(read("Nvidia closes purchase of chip plant").label).toBe("neutral");
  });

  it("reads ending a trouble as good news, whether the noun is singular or plural", () => {
    expect(read("Boeing ends production troubles")).toMatchObject({ label: "bullish", score: 1.5 });
    expect(read("Pfizer settles lawsuits").label).toBe("bullish");
    expect(read("Judge ends dispute between Apple and Epic").label).toBe("bullish");
    // the trouble on its own is still not news of an ending
    expect(read("Dispute escalates between Apple and Epic").label).toBe("neutral");
  });

  it("reads striking a deal in any tense, and still reads a workers' strike as bad", () => {
    for (const title of ["Intel strikes deal with Nvidia", "Intel struck a deal with Nvidia", "Boeing strikes deal with union"]) {
      expect(read(title)).toMatchObject({ label: "bullish", score: 1.5 });
    }
    expect(read("Workers strike at Boeing plant").label).toBe("bearish");
  });

  it("does not take the season for a fall in the shares", () => {
    expect(terms("Retailers brace for a slow fall season")).not.toContain("fall");
  });

  it("does not take weight loss for a loss", () => {
    expect(read("Weight loss drug maker posts record sales")).toMatchObject({ label: "bullish" });
    expect(read("Weight loss drug maker posts record sales").hits.find((h) => h.term === "weight loss")?.weight).toBe(0);
  });

  it("is the same every time", () => {
    const title = "Nvidia profit rises but guidance disappoints";
    expect(read(title)).toEqual(read(title));
  });

  it("splits a headline into lowercase tokens, keeping a percentage whole", () => {
    expect(tokensOf("Apple’s stock UP 12%!")).toEqual(expect.arrayContaining(["stock", "up", "12%"]));
  });
});

describe("the sentiment facade", () => {
  it("tags with the rules and names the provider", () => {
    expect(LEXICON_PROVIDER).toBe("lexicon:2");
    expect(tagByLexicon("Apple beats earnings estimates")).toBe("bullish");
    for (const title of ["Meta plans layoffs", "Fed holds rates steady", "Amazon revenue below estimates"]) {
      expect(tagByLexicon(title)).toBe(read(title).label);
    }
  });

  it("summarises counts into a score from -100 to 100", () => {
    expect(summarize([])).toEqual({ bullish: 0, neutral: 0, bearish: 0, tagged: 0, score: 0 });
    expect(summarize(["bullish", "bullish", "bearish", "neutral"])).toEqual({ bullish: 2, neutral: 1, bearish: 1, tagged: 4, score: 25 });
    expect(summarize(["bearish", "bearish"]).score).toBe(-100);
  });
});

describe("the rules against the labelled sets", () => {
  const { dev, heldOut } = benchmarkSummary();

  // A floor, not a target: a change to the vocabulary that costs more than a
  // headline or two on the set it was fitted to has broken something.
  it("keep the development set they were fitted to", () => {
    expect(dev.n).toBe(240);
    expect(dev.rules.accuracy).toBeGreaterThanOrEqual(0.97);
  });

  it("hold on headlines they were not fitted to", () => {
    expect(heldOut.n).toBe(120);
    expect(heldOut.rules.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(heldOut.rules.macroF1).toBeGreaterThanOrEqual(0.9);
  });

  it("beat the word list they replaced on both", () => {
    expect(dev.rules.accuracy).toBeGreaterThan(dev.wordList.accuracy);
    expect(heldOut.rules.accuracy).toBeGreaterThan(heldOut.wordList.accuracy + 0.1);
  });

  it("do not do it by calling everything neutral", () => {
    for (const split of [dev, heldOut]) {
      for (const label of ["bullish", "neutral", "bearish"] as const) expect(split.rules.perClass[label].recall ?? 0).toBeGreaterThan(0.8);
    }
  });

  it("leave the old word list as it was", () => {
    expect(tagByWordList("Apple beats earnings estimates")).toBe("bullish");
    expect(tagByWordList("Apple unveils new iPhone")).toBe("neutral");
  });
});
