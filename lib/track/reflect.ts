import { RATING_LABEL, type DecisionRating } from "../decision/rating";
import { flatBand, type Outcome } from "./settle";

/* ---------------------------------------------------------------------------
   What a settled decision says about itself, in words.

   TradingAgents has a model write a reflection on each resolved decision and
   hands the lessons to the next run. A model asked to explain why it was wrong
   will produce a fluent reason whether or not it knows one, so the reflection
   here states only what the stored record shows: what the rating was, what it
   leaned on, what held it back, what the stock then did against the market, and
   what happened to the plan's stop and reward levels. What to learn from that
   is for the person to write in the journal.

   Pure: a stored decision and its outcomes in, sentences out.
--------------------------------------------------------------------------- */

// The parts of a stored decision (decisions.decision) the reflection reads. Every
// field is optional: older records, and records with no rating, say less.
export interface StoredDecision {
  rating?: {
    composite?: number | null;
    contributions?: Array<{ label?: string; resolved?: number | null; weight?: number; contested?: boolean }>;
    steps?: Array<{ rule?: string; from?: string; to?: string; reason?: string }>;
  };
  blockers?: string[];
}

export interface ReflectionInput {
  rating: DecisionRating;
  asOf: string | null;
  refPrice: number | null;
  decision: StoredDecision;
  outcomes: Outcome[];
}

const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const VERDICT_WORDS: Record<Outcome["verdict"], string> = {
  right: "the call was right",
  wrong: "the call was wrong",
  flat: "too close to call",
  no_claim: "a hold makes no call against the market",
  excluded: "not measured",
};

export function outcomeLine(o: Outcome): string {
  if (o.verdict === "excluded" || o.stockReturn === null || o.marketReturn === null || o.alpha === null) {
    return `After ${o.horizon} sessions: not measured, because ${o.reason ?? "it could not be measured fairly"}.`;
  }
  const verdict = o.verdict === "flat" ? `too close to call (inside ±${(flatBand(o.horizon) * 100).toFixed(1)}%)` : VERDICT_WORDS[o.verdict];
  return `After ${o.horizon} sessions the stock was ${pct(o.stockReturn)} and the S&P 500 ${pct(o.marketReturn)}, so ${pct(o.alpha)} against the market: ${verdict}.`;
}

function pathLine(o: Outcome): string | null {
  const p = o.path;
  if (!p) return null;
  const through = `in the ${o.horizon} sessions`;
  if (!p.filled) return `The plan's pullback entry was never reached ${through}, so it would not have filled.`;
  const r = p.r === null ? "" : ` (${signed(p.r)}R)`;
  const reached = list(p.reached.map((m) => `${m}R`));
  if (p.stopped) {
    const before = p.reached.length > 0 ? `reached ${reached}, then ` : "";
    const ambiguous = p.ambiguous ? " A reward level was also touched that session; the order within a day is unknown, so it is not counted." : "";
    return `The plan ${before}hit its stop on ${p.stopDate}, ${p.sessionsToStop} sessions in${r}.${ambiguous}`;
  }
  return `The plan ${p.reached.length > 0 ? `reached ${reached} without hitting its stop` : "did not hit its stop or any reward level"} ${through}${r}.`;
}

function leaning(decision: StoredDecision): string[] {
  const scored = (decision.rating?.contributions ?? []).filter((c): c is { label: string; resolved: number; weight?: number; contested?: boolean } => typeof c.label === "string" && typeof c.resolved === "number");
  if (scored.length === 0) return [];
  const describe = (c: (typeof scored)[number]) => `${c.label.toLowerCase()} (${signed(c.resolved)}${c.contested ? ", contested" : ""})`;
  const byScore = [...scored].sort((a, b) => b.resolved - a.resolved);
  const lines: string[] = [];
  const best = byScore.filter((c) => c.resolved > 0).slice(0, 2);
  const worst = [...byScore].reverse().filter((c) => c.resolved < 0).slice(0, 2);
  if (best.length > 0) lines.push(`The committee scored ${list(best.map(describe))} highest.`);
  if (worst.length > 0) lines.push(`It scored ${list(worst.map(describe))} lowest.`);
  return lines;
}

export function reflect(input: ReflectionInput): string[] {
  const { rating, asOf, refPrice, decision } = input;
  const lines: string[] = [];
  const outcomes = [...input.outcomes].sort((a, b) => a.horizon - b.horizon);

  lines.push(`${RATING_LABEL[rating]}${asOf ? `, drawn from the ${asOf} close` : ""}${refPrice !== null ? ` of ${refPrice.toFixed(2)}` : ""}.`);

  for (const step of decision.rating?.steps ?? []) {
    if (step.reason) lines.push(`Held to ${RATING_LABEL[step.to as DecisionRating] ?? step.to} from ${RATING_LABEL[step.from as DecisionRating] ?? step.from}: ${step.reason}`);
  }
  lines.push(...leaning(decision));
  if ((decision.blockers ?? []).length > 0) lines.push(`At the time the desk held back from buying: ${list(decision.blockers as string[])}.`);

  for (const o of outcomes) lines.push(outcomeLine(o));

  // the plan's path at the longest horizon that has one
  const walked = [...outcomes].reverse().find((o) => o.path !== null);
  const path = walked ? pathLine(walked) : null;
  if (path) lines.push(path);

  return lines;
}
