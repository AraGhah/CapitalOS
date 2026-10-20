import type { Sentiment } from "../sentiment";

/* ---------------------------------------------------------------------------
   The rule-based headline tagger: what labels every headline when no model key
   is set, which is how this desk runs.

   A headline is read the way a person skims it. Words carry a signed weight;
   a few patterns carry more than their words (a raised target, a cut dividend,
   "up 22%"); and the surroundings change what a word means: "not as weak as
   feared" is good news, "despite record sales" discounts the sales, a clause
   after "but" outweighs the one before it, "could surge" is not news, and a
   question is not a report. Every point of the score comes from a named term,
   so `readHeadline` can say why a headline was labelled as it was.

   It is a word list with grammar, not a model. It cannot know which company a
   headline is about, or read a headline whose meaning is in what it leaves
   out. lib/sentiment/benchmark.ts measures how often it is right.
--------------------------------------------------------------------------- */

export const LEXICON_RULES = {
  // a headline is bullish at or above this score, bearish at or below its negative
  threshold: 1,
  // a negator flips the terms in the next few words, but not across a comma
  negationReach: 3,
  // a clause after "despite" or "although" counts for this share of its weight
  concession: 0.25,
  // "could", "might", "if": a possibility, not news
  hypothetical: 0.4,
  // a headline that asks a question reports nothing
  question: 0.4,
  // "slightly rose" / "sharply fell": the next term counts for this share
  softener: 0.5,
  intensifier: 1.5,
  // the clause before "but" is the setup, the clause after it is the point
  beforeBut: 0.5,
  afterBut: 1.5,
  // "up 22%": the weight of a percentage move, and the size that makes it strong
  percentMild: 1,
  percentStrong: 2,
  percentStrongAt: 10,
  // how far a verb looks for its object ("raises full-year guidance")
  objectReach: 3,
} as const;

/* ------------------------------------------------------------------ the words */

// The forms of a regular word: surge → surges, surged, surging; drop → dropped.
function forms(base: string): string[] {
  const out = new Set([base, `${base}s`]);
  if (/(s|x|z|ch|sh|o)$/.test(base)) out.add(`${base}es`);
  const endsE = base.endsWith("e");
  const endsY = /[^aeiou]y$/.test(base);
  const stem = endsE || endsY ? base.slice(0, -1) : base;
  out.add(endsE ? `${base}d` : endsY ? `${stem}ied` : `${base}ed`);
  if (endsY) out.add(`${stem}ies`);
  out.add(`${stem}ing`);
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(base)) {
    const last = base.slice(-1);
    out.add(`${base}${last}ed`);
    out.add(`${base}${last}ing`);
  }
  return [...out];
}

const table = new Map<string, number>();
function add(weight: number, inflected: string[], exact: string[] = []) {
  for (const base of inflected) for (const form of forms(base)) if (!table.has(form)) table.set(form, weight);
  for (const word of exact) table.set(word, weight);
}

add(2, ["surge", "soar", "skyrocket", "outperform", "upgrade", "beat", "rally", "approve", "boom", "thrive", "exceed", "impress", "crush"], [
  "blowout", "breakthrough", "approval", "record", "tops", "topped", "topping", "stellar", "windfall", "triumph", "spectacular", "impressive", "exceptional",
]);
add(1.5, ["jump", "climb", "gain", "rebound", "surpass", "win", "secure", "boost", "outpace", "rise", "succeed"], ["rose", "risen", "won", "lands", "landed", "upside", "bullish"]);
add(1, ["recover", "improve", "accelerate", "strengthen", "grow"], [
  "grew", "grown", "strong", "stronger", "strongest", "strength", "robust", "upbeat", "optimistic", "profitable", "profit", "profits", "success", "successful",
  "positive", "favorable", "favourable", "tailwind", "tailwinds", "resilient", "momentum", "buyback", "buybacks", "repurchase", "milestone",
  "innovative", "solid", "healthy", "recovery", "improvement", "discovery",
]);
add(0.5, [], [
  "growth", "partnership", "deal", "deals", "contract", "contracts", "agreement", "agreements", "raise", "raises", "raised", "lift", "lifts", "lifted", "hire", "hires",
  "invest", "invests", "investment", "award", "awarded", "demand", "expand", "expands", "expanded", "expansion",
]);

add(-2, ["plunge", "plummet", "crash", "collapse", "tumble", "sink", "slump", "slash", "downgrade", "miss", "sue", "probe", "recall", "default", "delist", "halt", "reject", "disappoint", "warn", "resign", "hack", "breach", "tank", "flop", "crater"], [
  "bankruptcy", "bankrupt", "fraud", "scandal", "lawsuit", "lawsuits", "investigation", "investigations", "outage", "fined", "layoffs", "layoff", "crisis",
  "sank", "sunk", "subpoena", "subpoenaed", "meltdown", "flopped",
]);
add(-1.5, ["fall", "drop", "decline", "dip", "slip", "slide", "lose", "weaken", "slow", "struggle", "trouble", "hurt", "slam", "shrink", "delay", "worsen", "deteriorate", "underperform"], [
  "fell", "fallen", "lost", "loss", "losses", "weak", "weaker", "weakest", "weakness", "slowdown", "downturn", "recession", "shortfall", "penalty", "penalties",
  "violation", "violations", "closure", "closures", "shutdown", "fail", "fails", "failed", "failing", "failure", "failures", "bearish", "shrank", "shrunk",
]);
add(-1, ["worry", "fear", "pressure"], [
  "cancel", "cancels", "cancelled", "canceled", "canceling", "cancelling", "abuse", "abuses", "concern", "concerns", "headwind", "headwinds", "shortage", "shortages", "uncertainty", "scrutiny", "litigation", "cut", "cuts", "cutting", "dump", "damage",
  "damaged", "disruption", "disruptions", "strike", "strikes",
]);
add(-1.5, [], ["antitrust"]);
add(-1, [], ["criminal", "charged"]);
add(-0.5, [], ["risk", "risks", "risky", "volatile", "volatility", "cautious", "caution", "lower", "lowers", "lowered", "reduce", "reduces", "reduced", "reducing", "uncertain", "wary", "softer", "soft"]);

// Phrases whose meaning is not the sum of their words, longest match first.
const phrases = new Map<string, number>();
function phrase(weight: number, ...parts: string[]) {
  phrases.set(parts.join(" "), weight);
}
phrase(2, "all", "time", "high");
phrase(2.5, "record", "high");
phrase(1.5, "new", "high");
phrase(1, "52", "week", "high");
phrase(2, "better", "than", "expected");
phrase(2, "above", "expectations");
phrase(1.5, "ahead", "of", "expectations");
phrase(1, "stock", "split");
phrase(1.5, "share", "buyback");
phrase(2, "dividend", "increase");
phrase(2, "dividend", "hike");
phrase(1, "buy", "rating");
phrase(2.5, "positive", "data");
phrase(2, "positive", "results");
phrase(2.5, "fda", "approval");
for (const met of ["meets", "met", "meet"]) phrase(2.5, met, "primary", "endpoint");
phrase(-2.5, "record", "low");
phrase(-3, "record", "loss");
phrase(-3, "record", "losses");
phrase(-2.5, "record", "fine");
phrase(-3, "going", "concern");
phrase(-3, "profit", "warning");
phrase(-2, "class", "action");
phrase(-1.5, "short", "seller");
phrase(-1.5, "short", "sellers");
phrase(-2.5, "data", "breach");
phrase(-2.5, "job", "cuts");
phrase(-2, "worse", "than", "expected");
phrase(-2, "below", "expectations");
phrase(-2, "short", "of", "expectations");
for (const fall of ["falls", "fall", "fell"]) phrase(-2, fall, "short");
phrase(-1.5, "sell", "off");
phrase(-1, "sell", "rating");
phrase(-1.5, "price", "war");
phrase(-0.5, "profit", "taking");
phrase(-1, "52", "week", "low");
phrase(1, "edges", "up");
phrase(1, "edges", "higher");
phrase(-1, "edges", "down");
phrase(-1, "edges", "lower");
phrase(1.5, "more", "than", "double");
for (const blow of ["blow", "blows", "blew"]) phrase(2, blow, "past");
phrase(-1.5, "billion", "settlement");
phrase(-1.5, "million", "settlement");
phrase(0, "weight", "loss");
phrase(-2, "multi", "year", "low");
phrase(-1.5, "new", "low");
phrase(-2, "billion", "fine");
phrase(-2, "million", "fine");
for (const reach of ["hit", "reach", "meet", "achieve", "deliver"]) phrase(-1.5, "not", "expected", "to", reach);
const LONGEST_PHRASE = Math.max(...[...phrases.keys()].map((p) => p.split(" ").length));

/* --------------------------------------------------------------- the grammar */

const set = (...bases: string[]) => new Set(bases.flatMap(forms));

// A verb that moves a number up or down, and what it moves.
const LIFTS = set("raise", "lift", "boost", "hike", "increase", "bump", "restore", "reinstate", "resume");
const CUTS = set("cut", "lower", "slash", "trim", "reduce", "withdraw", "suspend", "scrap", "axe", "pull", "halve");
const FIGURES = new Set([
  "guidance", "outlook", "forecast", "forecasts", "target", "targets", "estimate", "estimates", "dividend", "dividends", "view", "projection", "projections",
  "payout", "rating", "expectations",
]);
const STAFF = new Set(["jobs", "workforce", "staff", "positions", "headcount", "employees"]);

// "drops probe", "settles lawsuit": the verb ends the trouble.
const ENDS = set("drop", "dismiss", "end", "settle", "resolve", "clear");
const TROUBLES = new Set([
  "probe", "probes", "investigation", "investigations", "lawsuit", "lawsuits", "case", "cases", "charges", "suit", "suits", "litigation", "inquiry", "inquiries",
  "dispute", "disputes", "troubles", "problems", "feud",
]);

const CLOSES = set("close", "shut", "shutter");
const SITES = new Set([
  "stores", "plants", "factories", "locations", "branches", "offices", "restaurants", "mines", "facilities",
  "store", "plant", "factory", "location", "branch", "office", "restaurant", "mine", "facility",
]);

const DEALS = new Set(["deal", "agreement", "pact"]);

// "ahead of Wall Street estimates", "below forecasts": a result set against what was expected.
const ABOVE = new Set(["above", "ahead"]);
const BELOW = new Set(["below", "behind"]);
const BENCHMARKS = new Set(["estimates", "expectations", "forecasts", "forecast", "targets", "consensus", "projections", "views"]);
// "meets goals", "hits targets"
const MEETS = set("meet", "achieve", "hit", "reach");
const GOALS = new Set(["goal", "goals", "target", "targets", "estimates", "expectations", "forecasts", "forecast", "consensus"]);
// A rise in one of these is bad news: "costs surge", "defaults rise".
const BURDENS = new Set(["cost", "costs", "expense", "expenses", "inflation", "debt", "debts", "deficit", "losses", "loss", "defaults", "delinquencies", "layoffs", "layoff", "outages"]);
const MOVERS_UP = set("surge", "soar", "jump", "climb", "rise", "rally", "spike", "gain", "grow", "balloon");
const SEASON_BEFORE = new Set(["this", "next", "last", "each", "every"]);
const AMOUNTS = new Set(["million", "billion", "trillion"]);
const SEASON_NOUNS = new Set(["menu", "season", "collection", "lineup", "line", "launch", "event", "semester", "campaign"]);

// Direction words that mean nothing until a percentage follows ("up 22%").
const UP = new Set(["up", "higher", "increase", "increases", "increased"]);
const DOWN = new Set(["down", "decrease", "decreases", "decreased"]);

const NEGATORS = new Set(["not", "no", "never", "without", "nor", "neither", "unable", "unlikely", "cannot", ...forms("avoid"), ...forms("fail")]);
const CONCESSIONS = new Set(["despite", "although", "though", "notwithstanding"]);
const CONTRASTS = new Set(["but", "however"]);
const HYPOTHETICAL = new Set(["could", "might", "may", "would", "should", "if", "whether"]);
const SOFTENERS = new Set(["slightly", "modestly", "marginally", "barely", "little", "edges", "edged"]);
const INTENSIFIERS = new Set(["sharply", "steeply", "massively", "hugely", "dramatically", "significantly", "heavily"]);
const BOUNDARY = new Set([",", ";", ":", "?", "!"]);

/* ------------------------------------------------------------------ the read */

export interface Hit {
  // the words matched, as they stand in the headline
  term: string;
  // the points it added, after every adjustment
  weight: number;
  // why the weight is not the word's own: "negated", "after despite", "hypothetical"
  adjusted: string[];
}

export interface Reading {
  label: Sentiment;
  score: number;
  hits: Hit[];
}

export function tokensOf(title: string): string[] {
  const text = title
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(?<=\d),(?=\d{3}\b)/g, "")
    .replace(/\b(isn't|aren't|wasn't|weren't|won't|can't|couldn't|doesn't|don't|didn't|hasn't|haven't|hadn't|wouldn't|shouldn't|cannot)\b/g, "not")
    .replace(/'s\b/g, "")
    .replace(/(\d)\s*(?:percent|pct)\b/g, "$1%")
    .replace(/[-–—/]/g, " ");
  return text.match(/\d+(?:\.\d+)?%?|[a-z]+(?:'[a-z]+)?|[,;:?!]/g) ?? [];
}

const percentOf = (tokens: string[], from: number): number | null => {
  for (let j = from; j < Math.min(tokens.length, from + 3); j++) {
    if (BOUNDARY.has(tokens[j])) return null;
    if (/^\d+(\.\d+)?%$/.test(tokens[j])) return parseFloat(tokens[j]);
  }
  return null;
};

// The nearest of `words` after position i, within the reach and before a comma.
function objectAfter(tokens: string[], i: number, words: Set<string>[], reach: number = LEXICON_RULES.objectReach): number | null {
  for (let j = i + 1; j <= Math.min(tokens.length - 1, i + reach); j++) {
    if (BOUNDARY.has(tokens[j])) return null;
    if (words.some((w) => w.has(tokens[j]))) return j;
  }
  return null;
}

export function readHeadline(title: string): Reading {
  const tokens = tokensOf(title);
  const n = tokens.length;

  // What each position is worth by where it stands in the sentence.
  const multiplier = new Array<number>(n).fill(1);
  const notes: string[][] = tokens.map(() => []);
  const contrast = tokens.findIndex((t, i) => i > 0 && i < n - 1 && (CONTRASTS.has(t) || (t === "yet" && tokens[i - 1] !== "not")));
  if (contrast !== -1) {
    for (let i = 0; i < n; i++) {
      if (i < contrast) {
        multiplier[i] *= LEXICON_RULES.beforeBut;
        notes[i].push("before but");
      } else if (i > contrast) {
        multiplier[i] *= LEXICON_RULES.afterBut;
        notes[i].push("after but");
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const marker = CONCESSIONS.has(tokens[i]) || (tokens[i] === "even" && (tokens[i + 1] === "as" || tokens[i + 1] === "though")) || (tokens[i] === "spite" && tokens[i - 1] === "in");
    if (!marker) continue;
    for (let j = i + 1; j < n && !BOUNDARY.has(tokens[j]); j++) {
      multiplier[j] *= LEXICON_RULES.concession;
      notes[j].push("conceded");
    }
  }

  const hits: Hit[] = [];
  const used = new Array<boolean>(n).fill(false);

  // A term's final weight, from its own and the words around it.
  const record = (from: number, to: number, base: number, note?: string) => {
    let weight = base;
    const adjusted = [...notes[from]];
    if (note) adjusted.push(note);
    weight *= multiplier[from];

    for (let k = from - 1; k >= Math.max(0, from - LEXICON_RULES.negationReach); k--) {
      if (BOUNDARY.has(tokens[k])) break;
      if (NEGATORS.has(tokens[k])) {
        weight = -weight;
        adjusted.push(`negated by ${tokens[k]}`);
        break;
      }
    }
    for (let k = from - 1; k >= Math.max(0, from - 3); k--) {
      if (BOUNDARY.has(tokens[k])) break;
      if (HYPOTHETICAL.has(tokens[k])) {
        weight *= LEXICON_RULES.hypothetical;
        adjusted.push(`hypothetical (${tokens[k]})`);
        break;
      }
    }
    for (let k = from - 1; k >= Math.max(0, from - 2); k--) {
      if (BOUNDARY.has(tokens[k])) break;
      if (SOFTENERS.has(tokens[k])) {
        weight *= LEXICON_RULES.softener;
        adjusted.push(`softened (${tokens[k]})`);
        break;
      }
      if (INTENSIFIERS.has(tokens[k])) {
        weight *= LEXICON_RULES.intensifier;
        adjusted.push(`intensified (${tokens[k]})`);
        break;
      }
    }
    for (let k = from; k <= to; k++) used[k] = true;
    hits.push({ term: tokens.slice(from, to + 1).join(" "), weight, adjusted });
  };

  for (let i = 0; i < n; i++) {
    if (used[i] || BOUNDARY.has(tokens[i])) continue;
    const token = tokens[i];

    // a phrase
    let matched = false;
    for (let len = Math.min(LONGEST_PHRASE, n - i); len >= 2 && !matched; len--) {
      const key = tokens.slice(i, i + len).join(" ");
      const weight = phrases.get(key);
      if (weight !== undefined && !tokens.slice(i, i + len).some((t) => BOUNDARY.has(t))) {
        record(i, i + len - 1, weight);
        matched = true;
      }
    }
    if (matched) continue;

    // a verb and the figure it moves
    if (LIFTS.has(token)) {
      const at = objectAfter(tokens, i, [FIGURES]);
      if (at !== null) {
        record(i, at, 2);
        continue;
      }
    }
    if (CUTS.has(token)) {
      const at = objectAfter(tokens, i, [FIGURES, STAFF]);
      if (at !== null) {
        record(i, at, -2);
        continue;
      }
    }
    if (ENDS.has(token)) {
      const at = objectAfter(tokens, i, [TROUBLES]);
      if (at !== null) {
        record(i, at, 1.5);
        continue;
      }
    }
    if (CLOSES.has(token)) {
      const at = objectAfter(tokens, i, [SITES]);
      if (at !== null) {
        record(i, at, -2);
        continue;
      }
    }
    if (token === "strike" || token === "strikes" || token === "struck") {
      const at = objectAfter(tokens, i, [DEALS]);
      if (at !== null && at - i <= 2) {
        record(i, at, 1.5);
        continue;
      }
    }

    // a result against what was expected
    if (ABOVE.has(token) || BELOW.has(token)) {
      const at = objectAfter(tokens, i, [BENCHMARKS], LEXICON_RULES.objectReach + 1);
      if (at !== null) {
        record(i, at, ABOVE.has(token) ? 2 : -2);
        continue;
      }
    }
    if (MEETS.has(token)) {
      const at = objectAfter(tokens, i, [GOALS], 2);
      if (at !== null) {
        record(i, at, 1.5);
        continue;
      }
    }

    // "fine" is a penalty only after an amount ("a $1.3 billion EU fine"); "fall" is the season before a menu
    if (token === "fine" && tokens.slice(Math.max(0, i - 3), i).some((t) => AMOUNTS.has(t))) {
      record(i, i, -2);
      continue;
    }
    if (token === "fall" && (SEASON_NOUNS.has(tokens[i + 1] ?? "") || SEASON_BEFORE.has(tokens[i - 1] ?? "") || (tokens[i - 1] === "for" && (i + 1 >= n || BOUNDARY.has(tokens[i + 1]))))) continue;

    // "up 22%"
    if (UP.has(token) || DOWN.has(token)) {
      const pct = percentOf(tokens, i + 1);
      if (pct !== null) {
        const size = pct >= LEXICON_RULES.percentStrongAt ? LEXICON_RULES.percentStrong : LEXICON_RULES.percentMild;
        record(i, i + 1, UP.has(token) ? size : -size);
        continue;
      }
    }

    // a word; a rise in a burden is bad news
    const weight = table.get(token);
    if (weight !== undefined) {
      const burden = MOVERS_UP.has(token) && tokens.slice(Math.max(0, i - 2), i).some((t) => BURDENS.has(t));
      if (burden) record(i, i, -Math.abs(weight), "a rising burden");
      else record(i, i, weight);
    }
  }

  let score = hits.reduce((sum, h) => sum + h.weight, 0);
  if (title.includes("?")) score *= LEXICON_RULES.question;

  const label: Sentiment = score >= LEXICON_RULES.threshold ? "bullish" : score <= -LEXICON_RULES.threshold ? "bearish" : "neutral";
  return { label, score, hits };
}

export function tagHeadline(title: string): Sentiment {
  return readHeadline(title).label;
}
