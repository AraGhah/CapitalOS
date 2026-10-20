import { tagHeadline } from "./sentiment/lexicon";

// The analyst reads headlines with the model when a key is configured. This is
// what it falls back to otherwise: the rule-based tagger in sentiment/lexicon.ts,
// reported as such, so the meter still works on a fresh clone without anyone
// mistaking it for a model having read the news.

export type Sentiment = "bullish" | "neutral" | "bearish";

// Stored with each headline it labels (headlines.sentiment_provider). "lexicon"
// is the 40-word list this tagger replaced; scripts/retag-sentiment.ts moves
// those headlines onto the current rules.
export const LEXICON_PROVIDER = "lexicon:2";

export function tagByLexicon(title: string): Sentiment {
  return tagHeadline(title);
}

export interface SentimentSummary {
  bullish: number;
  neutral: number;
  bearish: number;
  tagged: number;
  // −100 (wholly bearish) to +100 (wholly bullish), from the tagged counts alone
  score: number;
}

export function summarize(tags: Sentiment[]): SentimentSummary {
  const bullish = tags.filter((t) => t === "bullish").length;
  const bearish = tags.filter((t) => t === "bearish").length;
  const neutral = tags.filter((t) => t === "neutral").length;
  const tagged = tags.length;

  return {
    bullish,
    neutral,
    bearish,
    tagged,
    score: tagged === 0 ? 0 : ((bullish - bearish) / tagged) * 100,
  };
}
