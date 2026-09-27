// The analyst reads headlines with the model when a key is configured. This is
// what it falls back to otherwise: a plain word list, reported as such, so the
// meter still works on a fresh clone without anyone mistaking it for a model
// having read the news.

export type Sentiment = "bullish" | "neutral" | "bearish";

const BULLISH = [
  "beat", "beats", "upgrade", "upgraded", "raises", "raised", "surge", "surges", "surged",
  "jump", "jumps", "jumped", "rally", "rallies", "soar", "soars", "record", "profit",
  "outperform", "growth", "wins", "win", "won", "approval", "approved", "expands",
  "expansion", "partnership", "buyback", "dividend", "strong", "tops", "rises", "rose",
  "gains", "gain", "bullish", "breakthrough", "demand", "boost", "boosts", "optimistic",
];

const BEARISH = [
  "miss", "misses", "missed", "downgrade", "downgraded", "cuts", "cut", "plunge", "plunges",
  "plunged", "slump", "slumps", "fall", "falls", "fell", "drop", "drops", "dropped",
  "loss", "losses", "lawsuit", "sues", "probe", "investigation", "recall", "layoffs",
  "layoff", "fraud", "warns", "warning", "weak", "weaker", "decline", "declines", "slows",
  "slowdown", "bearish", "risk", "fine", "fined", "delay", "delays", "delayed", "halt",
  "resigns", "bankruptcy", "short", "downturn", "concerns", "sinks", "tumbles",
];

const NEGATORS = new Set(["not", "no", "never", "without", "despite", "fails", "fail"]);

function words(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// A negator flips the term that follows it, which is the difference between
// "beats expectations" and "fails to beat expectations".
export function tagByLexicon(title: string): Sentiment {
  const tokens = words(title);
  let score = 0;

  tokens.forEach((token, i) => {
    const flip = i > 0 && NEGATORS.has(tokens[i - 1]) ? -1 : 1;
    if (BULLISH.includes(token)) score += flip;
    else if (BEARISH.includes(token)) score -= flip;
  });

  if (score > 0) return "bullish";
  if (score < 0) return "bearish";
  return "neutral";
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
