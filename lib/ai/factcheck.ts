import type { EvidenceItem, EvidencePack } from "./evidence";

/* ---------------------------------------------------------------------------
   The fact checker, the half of it that is code.

   Every number a model writes is pulled out of its sentence and compared with
   the evidence items the sentence cites. The comparison is arithmetic with a
   rounding allowance taken from how precisely the model wrote the figure, so
   "28%" matches 0.2834 and "$281.7B" matches 281,724,000,000 — and a figure
   the pack never contained cannot match anything, however plausible it reads.

   What code cannot settle — whether a qualitative sentence is a fair reading of
   the headline it cites — is left as "sourced" for the model checker to rule on.
--------------------------------------------------------------------------- */

export type CheckVerdict =
  | "verified" // every figure matches an item the claim cites
  | "sourced" // cites real evidence but has no figure for code to test
  | "miscited" // the figures are real, but in items the claim does not cite
  | "unsupported" // a figure appears nowhere in the pack, or the citations do not exist
  | "contradicted" // the model checker found the cited evidence says otherwise
  | "unsourced"; // no citation and no figure: an opinion, not a fact

export interface Claim {
  key: string;
  text: string;
  evidence: string[];
  agent: string;
  modelId: string;
  stage: string;
}

export interface Check {
  verdict: CheckVerdict;
  method: "code" | "model";
  reason: string;
}

export interface Figure {
  raw: string;
  candidates: Array<{
    value: number;
    units: Array<string | undefined>;
    tolerance: number;
    // when set, the candidate only applies to items whose label matches
    labels?: RegExp;
  }>;
  // the direction the sentence gives the figure ("fell 4%", "-4%"), when it
  // gives one; null for a level ("fell to 4%") or a figure with no direction
  direction?: "up" | "down" | null;
}

const DOWN_WORDS = /\b(fell|falls?|falling|declin\w*|dropp?\w*|down|lower|shr[ai]nk\w*|contract\w*|decreas\w*|slump\w*|plung\w*|cut|loss(es)?|negative|worse)\b/g;
const UP_WORDS = /\b(grew|grow\w*|rose|rises?|rising|up|increas\w*|gain\w*|higher|expand\w*|jump\w*|surg\w*|climb\w*|positive|improv\w*)\b/g;

// The last direction word in the few words before a figure. "to" right before
// it makes the figure a level ("fell to 4%"), which has no direction.
function directionBefore(context: string, explicitMinus: boolean): "up" | "down" | null {
  if (explicitMinus) return "down";
  const window = context.slice(-48).toLowerCase();
  if (/\b(to|at|of)\s*\$?\s*$/.test(window)) return null;
  let last: { at: number; dir: "up" | "down" } | null = null;
  for (const m of window.matchAll(DOWN_WORDS)) if (!last || m.index! > last.at) last = { at: m.index!, dir: "down" };
  for (const m of window.matchAll(UP_WORDS)) if (!last || m.index! > last.at) last = { at: m.index!, dir: "up" };
  return last?.dir ?? null;
}

// Numbers that are labels rather than quantities: evidence ids, dates, filing
// forms, fiscal periods and look-back windows.
const LABELS: RegExp[] = [
  /\[?\bE\d+\b\]?/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b10-[KQ]\b/gi,
  /\b(?:FY|Q)\s?\d{1,4}\b/gi,
  /\b\d+\s?-?(?:year|yr|week|wk|month|mo|day|quarter|session)s?\b/gi,
  /\b(?:S&P|Russell)\s?\d+\b/gi,
];

// The lookbehind keeps digits that are part of a word ("COVID-19", "A100") out.
const NUMBER =
  /(?<![\w.\-−])([-−])?(\$)?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|percent\b|pp\b|bps\b|x\b|×|trillion\b|billion\b|million\b|thousand\b|tn\b|bn\b|mn\b|[TBMK]\b)?/gi;

const SCALE: Record<string, number> = {
  t: 1e12, tn: 1e12, trillion: 1e12,
  b: 1e9, bn: 1e9, billion: 1e9,
  m: 1e6, mn: 1e6, million: 1e6,
  k: 1e3, thousand: 1e3,
};

export function extractFigures(text: string): Figure[] {
  let clean = text;
  for (const label of LABELS) clean = clean.replace(label, " ");

  const figures: Figure[] = [];
  for (const match of clean.matchAll(NUMBER)) {
    const [raw, minus, dollar, whole, fraction, unitRaw] = match;
    const unit = unitRaw?.toLowerCase();
    const digits = fraction?.length ?? 0;
    const magnitude = Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`);
    if (!Number.isFinite(magnitude)) continue;
    const value = minus ? -magnitude : magnitude;
    const half = 0.5 * 10 ** -digits;

    // A bare whole number with no unit is usually a count or a year ("three
    // quarters", "since 2019"), not a figure worth testing.
    if (!unit && !dollar && digits === 0 && (magnitude <= 12 || (magnitude >= 1900 && magnitude <= 2100))) {
      continue;
    }

    const candidates: Figure["candidates"] = [];
    if (unit === "%" || unit === "percent") {
      candidates.push({ value: value / 100, units: ["ratio", undefined], tolerance: half / 100 });
      candidates.push({ value, units: ["percent", undefined], tolerance: half });
    } else if (unit === "pp") {
      candidates.push({ value: value / 100, units: ["ratio"], tolerance: half / 100 });
      candidates.push({ value, units: ["percent"], tolerance: half });
    } else if (unit === "bps") {
      candidates.push({ value: value / 10_000, units: ["ratio"], tolerance: half / 10_000 });
      candidates.push({ value: value / 100, units: ["percent"], tolerance: half / 100 });
    } else if (unit === "x" || unit === "×") {
      candidates.push({ value, units: ["multiple", undefined], tolerance: half });
    } else if (unit && SCALE[unit] !== undefined) {
      const scale = SCALE[unit];
      candidates.push({ value: value * scale, units: ["usd", "shares", "count"], tolerance: half * scale });
    } else if (dollar) {
      candidates.push({ value, units: ["usd"], tolerance: half });
    } else {
      // A bare number is a multiple, a rate, a count or a score. It is not a
      // dollar or share figure: "revenue of 281.7" without a unit or a scale
      // must not pass as $281.7 because some item happens to hold that amount.
      candidates.push({ value, units: [undefined, "multiple", "percent", "count"], tolerance: half });
      // Percentiles are stored on a 0..1 scale and often written out of 100;
      // that reading is only allowed against a percentile.
      candidates.push({ value: value / 100, units: [undefined], tolerance: half / 100, labels: /percentile/i });
    }

    const isChange = unit === "%" || unit === "percent" || unit === "pp" || unit === "bps";
    const direction = isChange ? directionBefore(clean.slice(0, match.index), Boolean(minus)) : null;
    figures.push({ raw: raw.trim(), candidates, direction });
  }
  return figures;
}

// Magnitudes are compared without sign, because "revenue fell 4%" is a fair way
// to write a growth figure of −0.04. What the sentence says about direction is
// checked separately: "revenue grew 4%" against −0.04 is not a restatement, it
// is the opposite claim, and is refused.
const RELATIVE_SLACK = 0.015;

// Items whose sign means up or down rather than being part of a level.
const CHANGE_LABEL = /growth|change|return|trend|drawdown|y\/y|year over year|below the 52-week high/i;

export function matches(figure: Figure, item: EvidenceItem): boolean {
  if (item.value === undefined) return false;
  if (
    figure.direction &&
    item.value !== 0 &&
    CHANGE_LABEL.test(item.label) &&
    (figure.direction === "down") !== item.value < 0
  ) {
    return false;
  }
  const actual = Math.abs(item.value);

  return figure.candidates.some((c) => {
    if (!c.units.includes(item.unit)) return false;
    if (c.labels && !c.labels.test(item.label)) return false;
    const claimed = Math.abs(c.value);
    const allowance = Math.max(c.tolerance * 1.001, actual * RELATIVE_SLACK);
    return Math.abs(claimed - actual) <= allowance;
  });
}

export function checkClaim(claim: Claim, pack: EvidencePack): Check {
  const byId = new Map(pack.items.map((i) => [i.id, i]));
  const cited = claim.evidence.map((id) => byId.get(id)).filter((i): i is EvidenceItem => Boolean(i));
  const phantom = claim.evidence.filter((id) => !byId.has(id));
  const figures = extractFigures(claim.text);

  if (figures.length === 0) {
    if (cited.length > 0) {
      return { verdict: "sourced", method: "code", reason: `cites ${cited.map((i) => i.id).join(", ")}; no figure to test` };
    }
    if (phantom.length > 0) {
      return { verdict: "unsupported", method: "code", reason: `cites evidence that does not exist: ${phantom.join(", ")}` };
    }
    return { verdict: "unsourced", method: "code", reason: "no evidence cited" };
  }

  const missing: string[] = [];
  const elsewhere: string[] = [];

  for (const figure of figures) {
    if (cited.some((item) => matches(figure, item))) continue;
    const found = pack.items.find((item) => matches(figure, item));
    if (found) elsewhere.push(`${figure.raw} is in ${found.id}`);
    else missing.push(figure.raw);
  }

  if (missing.length > 0) {
    return {
      verdict: "unsupported",
      method: "code",
      reason: `${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not appear in any evidence item`,
    };
  }
  if (elsewhere.length > 0) {
    return { verdict: "miscited", method: "code", reason: `figure found under a different item: ${elsewhere.join("; ")}` };
  }
  return {
    verdict: "verified",
    method: "code",
    reason: `${figures.length} ${figures.length === 1 ? "figure matches" : "figures match"} ${cited.map((i) => i.id).join(", ")}`,
  };
}

// For prose that cites nothing — the synthesizer's headline and cases — every
// figure has to exist somewhere in the pack.
export function unsupportedFigures(text: string, pack: EvidencePack): string[] {
  return extractFigures(text)
    .filter((figure) => !pack.items.some((item) => matches(figure, item)))
    .map((figure) => figure.raw);
}

export interface CheckStats {
  total: number;
  verified: number;
  sourced: number;
  miscited: number;
  unsupported: number;
  contradicted: number;
  unsourced: number;
  // of the claims code or the checker could actually test, the share that held
  accuracy: number | null;
  // the share of claims that cite real evidence
  evidenceRate: number | null;
}

export function summarizeChecks(checks: Check[]): CheckStats {
  const count = (v: CheckVerdict) => checks.filter((c) => c.verdict === v).length;
  const stats = {
    total: checks.length,
    verified: count("verified"),
    sourced: count("sourced"),
    miscited: count("miscited"),
    unsupported: count("unsupported"),
    contradicted: count("contradicted"),
    unsourced: count("unsourced"),
  };
  const tested = stats.verified + stats.miscited + stats.unsupported + stats.contradicted;
  const citing = stats.verified + stats.sourced + stats.miscited + stats.contradicted;

  return {
    ...stats,
    accuracy: tested === 0 ? null : stats.verified / tested,
    evidenceRate: stats.total === 0 ? null : citing / stats.total,
  };
}
