import type { Sentiment } from "../sentiment";
import { DEV, HELD_OUT, type Gold, type Kind } from "./gold";
import { readHeadline } from "./lexicon";
import { tagByWordList } from "./legacy";

/* ---------------------------------------------------------------------------
   How often a tagger agrees with a careful reader. The measures are the ones
   FinGPT's benchmark reports for its sentiment models: accuracy and F1, here
   with the per-class figures and the confusion matrix behind them, and an
   interval on the accuracy, because 120 headlines cannot tell 80% from 85%.

   Pure: a tagger goes in, numbers come out. A model can be benchmarked the same
   way (scripts/benchmark-sentiment.ts --model) by passing its labels.
--------------------------------------------------------------------------- */

export const LABELS: readonly Sentiment[] = ["bullish", "neutral", "bearish"];

export interface ClassScore {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  // how many headlines the reader labelled this
  support: number;
}

export interface Miss {
  title: string;
  expected: Sentiment;
  got: Sentiment;
  kind: Kind;
  // what the tagger saw in it, when it can say
  why: string;
}

export interface BenchmarkResult {
  name: string;
  n: number;
  accuracy: number;
  // 95% Wilson interval on the accuracy
  interval: [number, number];
  // the plain mean of the three classes' F1, so a tagger cannot score by saying "neutral"
  macroF1: number;
  // the mean weighted by how many headlines each class has: the figure FinGPT reports
  weightedF1: number;
  perClass: Record<Sentiment, ClassScore>;
  // confusion[expected][got]
  confusion: Record<Sentiment, Record<Sentiment, number>>;
  byKind: Array<{ kind: Kind; n: number; accuracy: number }>;
  misses: Miss[];
}

// The Wilson score interval: well behaved at the small counts and the extreme
// proportions that a hand-labelled set produces.
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const zero = (): Record<Sentiment, Record<Sentiment, number>> => ({
  bullish: { bullish: 0, neutral: 0, bearish: 0 },
  neutral: { bullish: 0, neutral: 0, bearish: 0 },
  bearish: { bullish: 0, neutral: 0, bearish: 0 },
});

export function evaluate(
  name: string,
  gold: Gold[],
  labels: Sentiment[],
  why: (title: string) => string = () => ""
): BenchmarkResult {
  if (labels.length !== gold.length) throw new Error(`${name}: ${labels.length} labels for ${gold.length} headlines`);

  const confusion = zero();
  const misses: Miss[] = [];
  const kinds = new Map<Kind, { n: number; right: number }>();
  gold.forEach((item, i) => {
    const got = labels[i];
    confusion[item.label][got] += 1;
    const tally = kinds.get(item.kind) ?? { n: 0, right: 0 };
    tally.n += 1;
    if (got === item.label) tally.right += 1;
    else misses.push({ title: item.title, expected: item.label, got, kind: item.kind, why: why(item.title) });
    kinds.set(item.kind, tally);
  });

  const n = gold.length;
  const right = LABELS.reduce((sum, l) => sum + confusion[l][l], 0);
  const perClass = {} as Record<Sentiment, ClassScore>;
  for (const l of LABELS) {
    const support = LABELS.reduce((sum, g) => sum + confusion[l][g], 0);
    const predicted = LABELS.reduce((sum, e) => sum + confusion[e][l], 0);
    const precision = predicted === 0 ? null : confusion[l][l] / predicted;
    const recall = support === 0 ? null : confusion[l][l] / support;
    const f1 = precision === null || recall === null ? (support === 0 && predicted === 0 ? null : 0) : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[l] = { precision, recall, f1, support };
  }
  const present = LABELS.filter((l) => perClass[l].support > 0);
  const macroF1 = present.length === 0 ? 0 : present.reduce((sum, l) => sum + (perClass[l].f1 ?? 0), 0) / present.length;
  const weightedF1 = n === 0 ? 0 : LABELS.reduce((sum, l) => sum + (perClass[l].f1 ?? 0) * perClass[l].support, 0) / n;

  return {
    name,
    n,
    accuracy: n === 0 ? 0 : right / n,
    interval: wilson(right, n),
    macroF1,
    weightedF1,
    perClass,
    confusion,
    byKind: [...kinds.entries()].map(([kind, t]) => ({ kind, n: t.n, accuracy: t.right / t.n })).sort((a, b) => a.accuracy - b.accuracy || a.kind.localeCompare(b.kind)),
    misses,
  };
}

// What always saying the most common label would score: the figure a tagger has to beat.
export function majorityAccuracy(gold: Gold[]): number {
  if (gold.length === 0) return 0;
  return Math.max(...LABELS.map((l) => gold.filter((g) => g.label === l).length)) / gold.length;
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Number(Math.abs(n).toFixed(2))}`;

export function explain(title: string): string {
  const { hits, score } = readHeadline(title);
  if (hits.length === 0) return "no sentiment words";
  return `${hits.map((h) => `${h.term} ${signed(h.weight)}`).join(", ")} → ${signed(score)}`;
}

const KINDS: readonly Kind[] = ["plain", "phrase", "numeric", "analyst", "negation", "contrast", "routine", "advice"];

// A labelled file of the user's own: [{ "title": "...", "label": "bullish" }, …],
// with an optional "kind". Anything malformed is named rather than skipped, so a
// typo cannot quietly shrink the set the score is computed on.
export function parseGold(raw: unknown): Gold[] {
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of { title, label } objects");
  return raw.map((item, i) => {
    const row = (item ?? {}) as { title?: unknown; label?: unknown; kind?: unknown };
    if (typeof row.title !== "string" || row.title.trim() === "") throw new Error(`item ${i}: title must be a non-empty string`);
    if (!LABELS.includes(row.label as Sentiment)) throw new Error(`item ${i}: label must be bullish, neutral or bearish`);
    const kind = row.kind === undefined ? "plain" : row.kind;
    if (!KINDS.includes(kind as Kind)) throw new Error(`item ${i}: kind must be one of ${KINDS.join(", ")}`);
    return { title: row.title.trim(), label: row.label as Sentiment, kind: kind as Kind };
  });
}

/* ------------------------------------------------------- the shipped taggers */

export interface Split {
  name: string;
  gold: Gold[];
  majority: number;
  rules: BenchmarkResult;
  wordList: BenchmarkResult;
}

export interface BenchmarkReport {
  // the set the rules were fitted to, and the set they were not
  dev: Split;
  heldOut: Split;
}

function split(name: string, gold: Gold[]): Split {
  return {
    name,
    gold,
    majority: majorityAccuracy(gold),
    rules: evaluate("rules (current)", gold, gold.map((g) => readHeadline(g.title).label), explain),
    wordList: evaluate("word list (before)", gold, gold.map((g) => tagByWordList(g.title))),
  };
}

export function runBenchmark(): BenchmarkReport {
  return { dev: split("development", DEV), heldOut: split("held out", HELD_OUT) };
}

// The report without the headlines themselves: what a page or a tool returns.
export interface SplitSummary {
  name: string;
  n: number;
  majority: number;
  rules: BenchmarkResult;
  wordList: BenchmarkResult;
}

export interface BenchmarkSummary {
  dev: SplitSummary;
  heldOut: SplitSummary;
}

const summaryOfSplit = ({ name, gold, majority, rules, wordList }: Split): SplitSummary => ({ name, n: gold.length, majority, rules, wordList });

// The sets and the rules are fixed, so the answer is too: worked out once per process.
let remembered: BenchmarkSummary | null = null;

export function benchmarkSummary(): BenchmarkSummary {
  if (!remembered) {
    const report = runBenchmark();
    remembered = { dev: summaryOfSplit(report.dev), heldOut: summaryOfSplit(report.heldOut) };
  }
  return remembered;
}
