import { DIMENSIONS, type DimensionKey, type Score } from "./roster";
import type { CheckStats } from "./factcheck";
import type { EvidenceCoverage } from "./evidence";

/* ---------------------------------------------------------------------------
   The consensus arithmetic. No model is asked how much the models agree, or how
   confident the committee should be: both are computed here from the scores the
   seats gave, the checker's results and the evidence coverage, so the number on
   the page can be re-derived from the rows behind it.
--------------------------------------------------------------------------- */

export interface Vote {
  seat: string;
  modelId: string;
  score: Score;
}

export type Rating = "strong" | "positive" | "mixed" | "negative" | "weak" | "unknown";

export interface DimensionResult {
  key: DimensionKey;
  label: string;
  votes: Vote[];
  mean: number | null;
  // 1 when every seat gave the same score, 0 when they sat at opposite ends of
  // the scale; null when fewer than two seats scored it
  agreement: number | null;
  // the judge's score when there was one, otherwise the mean
  resolved: number | null;
  rating: Rating;
  label2: string;
  contested: boolean;
  note: string | null;
}

// Below this agreement a dimension is reported as contested, whatever its mean.
export const CONTESTED_BELOW = 0.6;

// The largest possible standard deviation of scores on a -2..+2 scale is 2 (half
// the seats at each end), so dividing by it puts agreement on 0..1.
export function agreementOf(scores: number[]): number | null {
  if (scores.length < 2) return null;
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
  return Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / 2));
}

export function ratingOf(value: number | null): Rating {
  if (value === null) return "unknown";
  if (value >= 1.25) return "strong";
  if (value >= 0.5) return "positive";
  if (value > -0.5) return "mixed";
  if (value > -1.25) return "negative";
  return "weak";
}

// "Strong valuation" reads wrong; each dimension gets words that fit it.
const WORDS: Partial<Record<DimensionKey, Record<Rating, string>>> = {
  valuation: {
    strong: "attractive",
    positive: "reasonable",
    mixed: "full",
    negative: "stretched",
    weak: "expensive",
    unknown: "unknown",
  },
  macro: {
    strong: "strong tailwind",
    positive: "tailwind",
    mixed: "neutral",
    negative: "headwind",
    weak: "strong headwind",
    unknown: "unknown",
  },
  balance_sheet: {
    strong: "fortress",
    positive: "sound",
    mixed: "adequate",
    negative: "stretched",
    weak: "fragile",
    unknown: "unknown",
  },
};

export function describe(key: DimensionKey, rating: Rating): string {
  return WORDS[key]?.[rating] ?? rating;
}

export interface ScoredView {
  seat: string;
  modelId: string;
  dimensions: Partial<Record<DimensionKey, { score: Score | null }>>;
}

export function dimensionConsensus(
  views: ScoredView[],
  judge?: Partial<Record<DimensionKey, { score: Score | null; contested: boolean; note: string }>>
): DimensionResult[] {
  return DIMENSIONS.map((d) => {
    const dimVotes: Vote[] = [];
    for (const view of views) {
      const s = view.dimensions[d.key]?.score;
      if (s !== null && s !== undefined) dimVotes.push({ seat: view.seat, modelId: view.modelId, score: s });
    }
    const scores = dimVotes.map((v) => v.score);
    const mean = scores.length > 0 ? scores.reduce((s: number, x) => s + x, 0) / scores.length : null;
    const agreement = agreementOf(scores);
    const ruling = judge?.[d.key];
    const resolved = ruling && ruling.score !== null ? ruling.score : mean;
    const rating = ratingOf(resolved);

    return {
      key: d.key,
      label: d.label,
      votes: dimVotes,
      mean,
      agreement,
      resolved,
      rating,
      label2: describe(d.key, rating),
      contested: (agreement !== null && agreement < CONTESTED_BELOW) || ruling?.contested === true,
      note: ruling?.note || null,
    };
  });
}

/* ----------------------------------------------------------------- confidence */

export interface ConfidenceReason {
  ok: boolean;
  text: string;
}

export interface Confidence {
  score: number;
  label: "Low" | "Medium" | "Medium-high" | "High";
  reasons: ConfidenceReason[];
  parts: { agreement: number | null; accuracy: number | null; evidence: number | null; coverage: number };
}

const WEIGHTS = { agreement: 0.35, accuracy: 0.3, evidence: 0.15, coverage: 0.2 };

// One model cannot disagree with itself, so a single-seat run has no measured
// agreement and its confidence is capped: it may be right, but nothing checked it.
const SINGLE_SEAT_CAP = 0.58;

export function labelFor(score: number): Confidence["label"] {
  if (score >= 0.72) return "High";
  if (score >= 0.6) return "Medium-high";
  if (score >= 0.45) return "Medium";
  return "Low";
}

export function confidenceOf(input: {
  dimensions: DimensionResult[];
  checks: CheckStats;
  coverage: EvidenceCoverage;
  seats: number;
  degraded: string[];
}): Confidence {
  const { dimensions, checks, coverage, seats, degraded } = input;
  const reasons: ConfidenceReason[] = [];

  const measured = dimensions.filter((d) => d.agreement !== null);
  const agreement =
    measured.length > 0 ? measured.reduce((s, d) => s + (d.agreement as number), 0) / measured.length : null;
  const coverageShare = coverage.expected > 0 ? coverage.present / coverage.expected : 0;

  const parts = { agreement, accuracy: checks.accuracy, evidence: checks.evidenceRate, coverage: coverageShare };

  let weighted = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as Array<[keyof typeof WEIGHTS, number]>) {
    const value = parts[key];
    if (value === null) continue;
    weighted += value * weight;
    weightUsed += weight;
  }
  let score = weightUsed > 0 ? weighted / weightUsed : 0;

  // An average can hide the thing that matters: a committee whose claims keep
  // failing the checker is not highly confident however well it agrees, and each
  // contested dimension is uncertainty the average smooths over.
  const contestedCount = dimensions.filter((d) => d.contested).length;
  score -= 0.03 * contestedCount;
  if (checks.accuracy !== null && checks.accuracy < 0.6) score = Math.min(score, 0.5);
  else if (checks.accuracy !== null && checks.accuracy < 0.8) score = Math.min(score, 0.66);
  score = Math.max(0, Math.min(1, score));

  // agreement
  if (seats < 2) {
    score = Math.min(score, SINGLE_SEAT_CAP);
    reasons.push({ ok: false, text: "One model only — agreement between models was not measured" });
  } else {
    const agreed = measured.filter((d) => !d.contested);
    reasons.push({
      ok: agreed.length === measured.length,
      text: `${seats} models scored independently; they agree on ${agreed.length} of ${measured.length} dimensions`,
    });
  }
  for (const d of dimensions.filter((x) => x.contested)) {
    reasons.push({
      ok: false,
      text: `Contested: ${d.label.toLowerCase()}${d.agreement !== null ? ` (${Math.round(d.agreement * 100)}% agreement)` : ""}`,
    });
  }

  // verification
  const tested = checks.verified + checks.miscited + checks.unsupported + checks.contradicted;
  if (tested > 0) {
    reasons.push({
      ok: checks.unsupported + checks.contradicted === 0,
      text: `${checks.verified} of ${tested} testable claims verified against the evidence`,
    });
  }
  if (checks.unsupported + checks.contradicted > 0) {
    reasons.push({
      ok: false,
      text: `${checks.unsupported + checks.contradicted} claims failed the fact check and were kept out of the conclusion`,
    });
  }

  // coverage
  const missing = coverage.inputs.filter((i) => !i.present).map((i) => i.name);
  reasons.push({
    ok: missing.length === 0,
    text:
      missing.length === 0
        ? `All ${coverage.expected} evidence inputs present`
        : `${coverage.present} of ${coverage.expected} evidence inputs present — missing ${missing.join(", ")}`,
  });

  for (const stage of degraded) {
    reasons.push({ ok: false, text: stage });
  }

  return { score, label: labelFor(score), reasons, parts };
}
