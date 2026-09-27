import { scoutFeeds, FEED_LABELS, type FeedId } from "./feeds";
import {
  getHeadlines,
  getUntagged,
  saveTags,
  storeHeadlines,
  type FeedReport,
  type HeadlineRow,
  type Verdict,
} from "./dossier";
import { summarize, tagByLexicon, type Sentiment, type SentimentSummary } from "./sentiment";
import { completeJson, hasModel, inputHash, MODEL, NoModelError } from "./llm";
import { latestMetrics } from "./scoring";
import type { CompanyRow } from "./company";

/* ---------------------------------------------------------------------------
   Three agents, run in sequence. Each one reports what it did and hands the
   next one its output. None of them invents a price or a figure: the scout only
   fetches, the analyst only labels headlines it was given, and the strategist
   only reads those labels and the stored fundamentals.
--------------------------------------------------------------------------- */

// How many headlines one run works with. The analyst tags everything inside this
// window in a single pass: leaving some untagged would change the labels on the
// next run, and with them the cache key, so an unchanged company would never
// actually hit the cache.
const WINDOW = 200;

/* --------------------------------------------------------------------- scout */

export interface ScoutResult {
  feeds: FeedReport[];
  fetched: number;
  stored: number;
  headlines: HeadlineRow[];
}

export async function scout(company: CompanyRow): Promise<ScoutResult> {
  const results = await scoutFeeds(company.ticker, company.name);

  const feeds: FeedReport[] = [];
  let fetched = 0;
  let stored = 0;

  for (const result of results) {
    fetched += result.articles.length;
    if (result.articles.length > 0) {
      stored += await storeHeadlines(company.id, result.feed, result.articles);
    }
    feeds.push({
      feed: result.feed,
      label: result.label,
      count: result.articles.length,
      error: result.error,
    });
  }

  return { feeds, fetched, stored, headlines: await getHeadlines(company.id, WINDOW) };
}

/* ------------------------------------------------------------------- analyst */

export interface AnalystResult {
  sentiment: SentimentSummary;
  tagged: number;
  provider: string;
  headlines: HeadlineRow[];
}

const ANALYST_SYSTEM = `You label financial news headlines for a personal research desk.

For each headline, decide what it implies for the company's share price:
- "bullish": the news is good for the business or the stock
- "bearish": the news is bad for the business or the stock
- "neutral": routine coverage, unclear implications, or not really about the company

Judge only the headline you are given. Do not use anything you remember about the
company, and do not guess at facts the headline does not state. A headline that is
mostly about another company is neutral for this one.

Reply with JSON only: [{"i": <index>, "s": "bullish"|"neutral"|"bearish"}]
Include every index you were given, exactly once.`;

const TAG_BATCH = 40;


// Tagging happens in batches so one pipeline run costs a handful of requests
// rather than one per headline.
export async function analyst(company: CompanyRow): Promise<AnalystResult> {
  const untagged = await getUntagged(company.id, WINDOW);
  const useModel = hasModel();
  const provider = useModel ? MODEL : "lexicon";

  let tagged = 0;

  for (let i = 0; i < untagged.length; i += TAG_BATCH) {
    const batch = untagged.slice(i, i + TAG_BATCH);
    const tags = useModel ? await tagWithModel(batch) : batch.map((h) => tagByLexicon(h.title));

    tagged += await saveTags(
      batch.map((headline, j) => ({ id: headline.id, sentiment: tags[j] })),
      provider
    );
  }

  const headlines = await getHeadlines(company.id, WINDOW);
  const sentiment = summarize(
    headlines.map((h) => h.sentiment).filter((s): s is Sentiment => s !== null)
  );

  return { sentiment, tagged, provider, headlines };
}

async function tagWithModel(batch: HeadlineRow[]): Promise<Sentiment[]> {
  const listed = batch.map((h, i) => `${i}. ${h.title}`).join("\n");

  const parsed = await completeJson<Array<{ i: number; s: string }>>({
    system: ANALYST_SYSTEM,
    messages: [{ role: "user", content: listed }],
    maxTokens: 2048,
  });

  // A model that skips or invents an index should not shift every other label,
  // so results are placed by index and anything missing stays neutral.
  const tags: Sentiment[] = batch.map(() => "neutral");
  for (const item of parsed) {
    if (!Number.isInteger(item.i) || item.i < 0 || item.i >= batch.length) continue;
    if (item.s === "bullish" || item.s === "bearish" || item.s === "neutral") {
      tags[item.i] = item.s;
    }
  }
  return tags;
}

/* ---------------------------------------------------------------- strategist */

export interface StrategistResult {
  verdict: Verdict;
  confidence: number | null;
  risk: "low" | "medium" | "high" | null;
  horizon: string | null;
  brief: { headline: string | null; summary: string | null; entryPlan: string | null };
  bull: string[];
  bear: string[];
  catalysts: string[];
  provider: string;
}

const VERDICTS: Verdict[] = ["BUY", "ACCUMULATE", "HOLD", "WAIT", "AVOID"];

const STRATEGIST_SYSTEM = `You are the strategist on a single person's research desk. You are given
recent headlines about one company, each already labelled bullish, neutral or bearish, plus whatever
fundamentals the desk has stored.

Write a short editorial brief and a verdict. Rules:
- Use only the headlines and figures given to you. If something is not in the input, do not assert it.
- Never state a price, a target, or a number that is not in the input.
- The entry plan describes conditions to watch for, not a prediction.
- Be plain and specific. No hedging filler, no "as an AI", no disclaimers.
- Bull, bear and catalyst points are one short sentence each, drawn from the headlines given.

Reply with JSON only:
{
  "verdict": "BUY" | "ACCUMULATE" | "HOLD" | "WAIT" | "AVOID",
  "confidence": <0..1>,
  "risk": "low" | "medium" | "high",
  "horizon": "<e.g. 3-6 months>",
  "brief_headline": "<one editorial line, under 90 characters>",
  "brief_summary": "<2-4 sentences on what this news means>",
  "entry_plan": "<1-2 sentences on what would have to be true to buy>",
  "bull": ["..."],
  "bear": ["..."],
  "catalysts": ["..."]
}`;

export async function strategist(
  company: CompanyRow,
  headlines: HeadlineRow[],
  sentiment: SentimentSummary
): Promise<StrategistResult> {
  const metrics = await safeMetrics(company.id);

  if (!hasModel()) {
    // No key: the verdict still comes out, from the tagged counts alone, and the
    // editorial fields stay empty rather than being filled with something that
    // reads like a model wrote it.
    return {
      ...ruleVerdict(sentiment),
      brief: { headline: null, summary: null, entryPlan: null },
      bull: [],
      bear: [],
      catalysts: [],
      provider: "rules:sentiment-counts",
    };
  }

  const payload = {
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    sentiment_counts: sentiment,
    stored_fundamentals: metrics,
    headlines: headlines.slice(0, 60).map((h) => ({
      title: h.title,
      outlet: h.domain,
      when: h.publishedAt?.slice(0, 10) ?? null,
      label: h.sentiment,
    })),
  };

  const parsed = await completeJson<{
    verdict?: string;
    confidence?: number;
    risk?: string;
    horizon?: string;
    brief_headline?: string;
    brief_summary?: string;
    entry_plan?: string;
    bull?: string[];
    bear?: string[];
    catalysts?: string[];
  }>({
    system: STRATEGIST_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    maxTokens: 2048,
  });

  const verdict = VERDICTS.includes(parsed.verdict as Verdict)
    ? (parsed.verdict as Verdict)
    : ruleVerdict(sentiment).verdict;

  const risk = ["low", "medium", "high"].includes(parsed.risk ?? "")
    ? (parsed.risk as "low" | "medium" | "high")
    : null;

  return {
    verdict,
    confidence:
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : null,
    risk,
    horizon: parsed.horizon?.trim() || null,
    brief: {
      headline: parsed.brief_headline?.trim() || null,
      summary: parsed.brief_summary?.trim() || null,
      entryPlan: parsed.entry_plan?.trim() || null,
    },
    bull: cleanList(parsed.bull),
    bear: cleanList(parsed.bear),
    catalysts: cleanList(parsed.catalysts),
    provider: MODEL,
  };
}

function cleanList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

// The fallback, and the tie-breaker when the model answers with a verdict that is
// not one of the five. Derived only from the counts, so it is reproducible.
function ruleVerdict(sentiment: SentimentSummary): {
  verdict: Verdict;
  confidence: number | null;
  risk: "low" | "medium" | "high";
  horizon: string | null;
} {
  const { score, tagged } = sentiment;

  const verdict: Verdict =
    tagged === 0 ? "WAIT" : score >= 45 ? "BUY" : score >= 15 ? "ACCUMULATE" : score > -15 ? "HOLD" : score > -45 ? "WAIT" : "AVOID";

  return {
    verdict,
    // Coverage, reused as the only defensible stand-in for certainty: how much
    // evidence the call rests on, capped so it never reads as a sure thing.
    confidence: tagged === 0 ? null : Math.min(0.8, tagged / 60),
    risk: tagged < 10 ? "high" : Math.abs(score) < 20 ? "medium" : "low",
    horizon: null,
  };
}

// Maps do not survive JSON.stringify, so the figures are flattened before they
// go anywhere near the model. Only stored, reported numbers end up here.
async function safeMetrics(companyId: string) {
  try {
    const metrics = await latestMetrics(companyId);
    if (!metrics.periodEnd) return null;

    return {
      period_end: metrics.periodEnd,
      reported: Object.fromEntries([...metrics.raw].map(([k, v]) => [k, v.toString()])),
      derived: Object.fromEntries([...metrics.derived].map(([k, v]) => [k, v.toString()])),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the hash */

// The cache key: the exact headline set plus the labels on it. New coverage or a
// re-tag changes it; opening the page again does not.
export function dossierHash(company: CompanyRow, headlines: HeadlineRow[]): string {
  return inputHash({
    ticker: company.ticker,
    headlines: headlines
      .map((h) => `${h.url}|${h.sentiment ?? ""}`)
      .sort(),
  });
}

export { FEED_LABELS, NoModelError };
export type { FeedId };
