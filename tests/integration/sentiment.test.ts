import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getBenchmark } from "../../app/api/sentiment/benchmark/route";
import { GET as getStudy } from "../../app/api/sentiment/study/route";
import { SentimentStudyPanel } from "../../app/components/SentimentStudyPanel";
import { BENCHMARK_TICKER } from "../../lib/constants";
import { pool } from "../../lib/db";
import { storeHeadlines } from "../../lib/dossier";
import { LEXICON_PROVIDER, type Sentiment } from "../../lib/sentiment";
import { labellerOf, sentimentStudy } from "../../lib/sentiment/data";
import { retag } from "../../lib/sentiment/retag";
import { company } from "./db";
import { call, signedInUser } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

// The study reads stored prices only; an outside feed being asked is a failure.
const noOutsideFeed = () => vi.stubGlobal("fetch", async () => { throw new Error("an outside feed was asked"); });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plus = (date: string, days: number) => iso(Date.parse(`${date}T00:00:00Z`) + days * DAY);

// A Monday about six weeks back: inside the study's look-back whenever the tests run.
function lastMonday(): string {
  let date = iso(Date.now() - 42 * DAY);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = plus(date, -1);
  return date;
}
const MONDAY = lastMonday();

// One weekday close per entry, from MONDAY.
async function seedPrices(companyId: string, closes: number[]) {
  let date = MONDAY;
  for (const close of closes) {
    while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = plus(date, 1);
    await pool.query(`INSERT INTO prices_daily (company_id, date, open, high, low, close, volume) VALUES ($1, $2, $3, $3, $3, $3, 1000000)`, [companyId, date, close]);
    date = plus(date, 1);
  }
}

let urls = 0;
async function headline(companyId: string, opts: { title?: string; date: string; sentiment: Sentiment | null; provider?: string | null }) {
  const url = `https://news.example.com/story-${++urls}`;
  await storeHeadlines(companyId, "gdelt", [{ url, title: opts.title ?? `Story ${urls}`, domain: "news.example.com", publishedAt: `${opts.date}T12:00:00.000Z` }]);
  await pool.query(`UPDATE headlines SET sentiment = $3, sentiment_provider = $4 WHERE company_id = $1 AND url = $2`, [companyId, url, opts.sentiment, opts.provider ?? null]);
}

const window = (read: Awaited<ReturnType<typeof sentimentStudy>>, key: string) => read.all.windows.find((w) => w.key === key)!;

describe("labellerOf", () => {
  it("names who labelled a headline from the provider stored with it", () => {
    expect(labellerOf(LEXICON_PROVIDER)).toBe("rules");
    expect(labellerOf("lexicon")).toBe("word list");
    expect(labellerOf("claude-sonnet-5-5")).toBe("model");
    expect(labellerOf(null)).toBe("model");
  });
});

describe("sentimentStudy", () => {
  it("is unmeasured, and says what to run, when the desk has no labelled headlines", async () => {
    noOutsideFeed();
    const read = await sentimentStudy();
    expect(read).toMatchObject({ headlines: 0, byLabel: { bullish: 0, neutral: 0, bearish: 0 }, by: [] });
    expect(read.all.status).toBe("unmeasured");
    expect(read.all.reason).toContain("no headline has a label");
  });

  it("says the benchmark is missing when headlines are labelled but the S&P 500 has no prices", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, [100, 101, 102]);
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: LEXICON_PROVIDER });
    const read = await sentimentStudy();
    expect(read.all.status).toBe("unmeasured");
    expect(read.all.reason).toContain("npm run fetch-prices");
  });

  it("measures the next session and the next five from the stored closes, less the market's, and asks no outside feed", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, [100, 100, 110, 110, 110, 110, 110, 110, 110, 110]);
    await seedPrices(await company(BENCHMARK_TICKER), Array(10).fill(400));
    // Tuesday's news: entry at Tuesday's close of 100
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: LEXICON_PROVIDER });

    const read = await sentimentStudy();
    expect(read.headlines).toBe(1);
    expect(read.byLabel).toEqual({ bullish: 1, neutral: 0, bearish: 0 });
    expect(read.all).toMatchObject({ status: "measured", days: 1, companies: 1, from: plus(MONDAY, 1), to: plus(MONDAY, 1) });
    expect(window(read, "sameDay").groups.bullish.mean).toBeCloseTo(0, 10);
    expect(window(read, "d1").groups.bullish).toMatchObject({ n: 1 });
    expect(window(read, "d1").groups.bullish.mean).toBeCloseTo(0.1, 10);
    expect(window(read, "d5").groups.bullish.mean).toBeCloseTo(0.1, 10);
    // one day is not enough to compare bullish with bearish
    expect(window(read, "d1").verdict).toBe("not_enough");
  });

  it("subtracts the market's move", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, [100, 100, 110, 110, 110, 110, 110]);
    // the market rose 4% over the same session
    await seedPrices(await company(BENCHMARK_TICKER), [400, 400, 416, 416, 416, 416, 416]);
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bearish", provider: LEXICON_PROVIDER });
    const d1 = window(await sentimentStudy(), "d1");
    expect(d1.groups.bearish.mean).toBeCloseTo(0.06, 10);
  });

  it("keeps the labellers apart, in a fixed order", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, Array(10).fill(100));
    await seedPrices(await company(BENCHMARK_TICKER), Array(10).fill(400));
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: "claude-sonnet-5-5" });
    await headline(a, { date: plus(MONDAY, 2), sentiment: "neutral", provider: "lexicon" });
    await headline(a, { date: plus(MONDAY, 3), sentiment: "bearish", provider: LEXICON_PROVIDER });
    await headline(a, { date: plus(MONDAY, 3), sentiment: "bearish", provider: LEXICON_PROVIDER });
    const read = await sentimentStudy();
    expect(read.by.map((b) => [b.labeller, b.headlines])).toEqual([["rules", 2], ["word list", 1], ["model", 1]]);
    expect(read.headlines).toBe(4);
  });

  it("leaves out headlines with no label, no date, or older than the look-back", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, Array(6).fill(100));
    await seedPrices(await company(BENCHMARK_TICKER), Array(6).fill(400));
    await headline(a, { date: plus(MONDAY, 1), sentiment: null });
    await headline(a, { date: iso(Date.now() - 600 * DAY), sentiment: "bullish", provider: LEXICON_PROVIDER });
    await headline(a, { date: plus(MONDAY, 2), sentiment: "neutral", provider: LEXICON_PROVIDER });
    // labelled, but with no publication date
    await headline(a, { date: plus(MONDAY, 3), sentiment: "bullish", provider: LEXICON_PROVIDER });
    await pool.query(`UPDATE headlines SET published_at = NULL WHERE url = $1`, [`https://news.example.com/story-${urls}`]);
    const read = await sentimentStudy();
    expect(read.headlines).toBe(1);
    expect(read.byLabel).toEqual({ bullish: 0, neutral: 1, bearish: 0 });
  });

  it("drops a window that crosses a split, using the splits stored for the company", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, [100, 100, 50, 50, 50, 50, 50, 50]);
    await seedPrices(await company(BENCHMARK_TICKER), Array(8).fill(400));
    await pool.query(`INSERT INTO splits (company_id, date, ratio) VALUES ($1, $2, 2)`, [a, plus(MONDAY, 2)]);
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: LEXICON_PROVIDER });
    const d1 = window(await sentimentStudy(), "d1");
    expect(d1.groups.bullish.n).toBe(0);
  });
});

describe("GET /api/sentiment/study", () => {
  it("returns the study, uncached, to a signed-in user", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, Array(8).fill(100));
    await seedPrices(await company(BENCHMARK_TICKER), Array(8).fill(400));
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: LEXICON_PROVIDER });
    const u = await signedInUser();
    const res = await call(getStudy, { cookie: u.cookie, path: "/api/sentiment/study" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as { headlines: number; all: { status: string; windows: Array<{ key: string }> }; by: Array<{ labeller: string }> };
    expect(body.headlines).toBe(1);
    expect(body.all.status).toBe("measured");
    expect(body.all.windows.map((w) => w.key)).toEqual(["sameDay", "d1", "d5"]);
    expect(body.by.map((b) => b.labeller)).toEqual(["rules"]);
  });

  it("is a 401 signed out", async () => {
    expect((await call(getStudy, { path: "/api/sentiment/study" })).status).toBe(401);
  });
});

describe("GET /api/sentiment/benchmark", () => {
  it("returns both sets' scores for the rules and the word list, uncached, without the headlines", async () => {
    const u = await signedInUser();
    const res = await call(getBenchmark, { cookie: u.cookie, path: "/api/sentiment/benchmark" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as { heldOut: { n: number; rules: { accuracy: number; confusion: unknown }; wordList: { accuracy: number } }; dev: { n: number } };
    expect(body.heldOut.n).toBe(120);
    expect(body.dev.n).toBe(240);
    expect(body.heldOut.rules.accuracy).toBeGreaterThan(body.heldOut.wordList.accuracy);
    expect(body.heldOut.rules.confusion).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('"gold"');
  });

  it("is a 401 signed out", async () => {
    expect((await call(getBenchmark, { path: "/api/sentiment/benchmark" })).status).toBe(401);
  });
});

describe("the Sentiment Lab study panel", () => {
  it("renders the study read from the database", async () => {
    noOutsideFeed();
    const a = await company("AAA");
    await seedPrices(a, Array(8).fill(100));
    await seedPrices(await company(BENCHMARK_TICKER), Array(8).fill(400));
    await headline(a, { date: plus(MONDAY, 1), sentiment: "bullish", provider: LEXICON_PROVIDER });
    const html = renderToStaticMarkup(await SentimentStudyPanel());
    expect(html).toContain("1 bullish");
    expect(html).toContain("1 company-days across 1 company");
    expect(html).toContain("concurrent: shown, not tested");
  });
});

describe("retag", () => {
  async function seed() {
    const a = await company("AAA");
    const b = await company("BBB");
    // the old word list's labels, as it stored them
    await headline(a, { title: "Nvidia profit rises but guidance disappoints", date: plus(MONDAY, 1), sentiment: "neutral", provider: "lexicon" });
    await headline(a, { title: "Apple beats earnings estimates", date: plus(MONDAY, 2), sentiment: "bullish", provider: "lexicon" });
    await headline(b, { title: "Fed holds rates steady", date: plus(MONDAY, 2), sentiment: "bearish", provider: "lexicon" });
    // a model's label is never touched
    await headline(b, { title: "Meta plans layoffs", date: plus(MONDAY, 3), sentiment: "bullish", provider: "claude-sonnet-5-5" });
  }

  const stored = async () => (await pool.query(`SELECT title, sentiment, sentiment_provider FROM headlines ORDER BY title`)).rows as Array<{ title: string; sentiment: string; sentiment_provider: string }>;

  it("reports what would change and writes nothing on a dry run", async () => {
    await seed();
    const before = await stored();
    const report = await retag({ apply: false });
    expect(report).toMatchObject({ replaced: "lexicon", considered: 3, changed: 2, companies: 2, applied: false });
    expect(report.matrix.neutral.bearish).toBe(1);
    expect(report.matrix.bullish.bullish).toBe(1);
    expect(report.matrix.bearish.neutral).toBe(1);
    expect(await stored()).toEqual(before);
  });

  it("relabels with the rules, moves them to the rules' provider and leaves a model's labels alone", async () => {
    await seed();
    const report = await retag({ apply: true });
    expect(report.applied).toBe(true);
    expect(await stored()).toEqual([
      { title: "Apple beats earnings estimates", sentiment: "bullish", sentiment_provider: LEXICON_PROVIDER },
      { title: "Fed holds rates steady", sentiment: "neutral", sentiment_provider: LEXICON_PROVIDER },
      { title: "Meta plans layoffs", sentiment: "bullish", sentiment_provider: "claude-sonnet-5-5" },
      { title: "Nvidia profit rises but guidance disappoints", sentiment: "bearish", sentiment_provider: LEXICON_PROVIDER },
    ]);
  });

  it("finds nothing to do the second time", async () => {
    await seed();
    await retag({ apply: true });
    expect(await retag({ apply: true })).toMatchObject({ considered: 0, changed: 0, companies: 0 });
  });

  it("refuses to relabel a model's labels", async () => {
    await seed();
    await expect(retag({ apply: true, provider: "claude-sonnet-5-5" })).rejects.toThrow("not a rule-based provider");
    expect((await stored()).find((h) => h.title === "Meta plans layoffs")?.sentiment).toBe("bullish");
  });

  it("does not rewrite labels already on the current rules", async () => {
    await seed();
    await retag({ apply: true });
    const report = await retag({ apply: true, provider: LEXICON_PROVIDER });
    expect(report.applied).toBe(false);
    expect(report.considered).toBe(3);
  });
});
