import type { Sentiment } from "../sentiment";

// The word list the analyst used until the explainable tagger (lexicon.ts)
// replaced it. Kept only as the baseline the benchmark compares against, so the
// page can show what the change bought; nothing labels a headline with it.

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

export function tagByWordList(title: string): Sentiment {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
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
