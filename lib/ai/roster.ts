import { RULE_METRICS } from "../theses";

/* ---------------------------------------------------------------------------
   The committee.

   Each seat is written the way CrewAI writes an agent — a role, a goal and a
   backstory — and each job the way it writes a task: what to do and exactly
   what to hand back. The seats are arranged in phases, ChatDev-fashion, so each
   phase hands a smaller, checked set of material to the next:

     analysts ─┐                    ┌─ fact check ─┐
               ├─ bull · bear · ────┤              ├─ judge ─ synthesizer
   specialists ┘   challenger       └──────────────┘

   Analysts work blind: none sees another's answer, which is what keeps their
   agreement worth measuring.
--------------------------------------------------------------------------- */

export type Score = -2 | -1 | 0 | 1 | 2;

export const DIMENSIONS = [
  { key: "business_quality", label: "Business quality", scale: "+2 exceptional franchise, -2 poor business" },
  { key: "growth", label: "Growth", scale: "+2 fast and durable growth, -2 shrinking" },
  { key: "profitability", label: "Profitability", scale: "+2 very high and improving margins/returns, -2 loss-making or collapsing" },
  { key: "balance_sheet", label: "Balance sheet", scale: "+2 fortress balance sheet, -2 dangerously levered" },
  { key: "valuation", label: "Valuation", scale: "+2 clearly inexpensive for what the evidence shows, -2 priced far beyond what the evidence supports" },
  { key: "competitive_position", label: "Competitive position", scale: "+2 dominant and widening moat, -2 losing ground" },
  { key: "news_flow", label: "News flow", scale: "+2 strongly positive recent news and price action, -2 strongly negative" },
  { key: "macro", label: "Macro backdrop", scale: "+2 strong tailwind for this company, -2 strong headwind" },
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number]["key"];
export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key) as DimensionKey[];

export interface Seat {
  id: string;
  name: string;
  role: string;
  goal: string;
  backstory: string;
  dimensions: DimensionKey[];
}

export const ANALYST: Seat = {
  id: "analyst",
  name: "Independent analyst",
  role: "Independent equity analyst",
  goal: "Form a complete, evidence-grounded view of the company across every dimension, on your own.",
  backstory:
    "You have covered companies across sectors for twenty years. You distrust narratives that the numbers do not carry, and you say plainly when the evidence is too thin to judge.",
  dimensions: DIMENSION_KEYS,
};

// The specialists sit only on an Investment Committee. Each scores its own
// dimensions and nothing else, so its view adds depth where it is expert
// rather than a fifth opinion on everything.
export const SPECIALISTS: Seat[] = [
  {
    id: "financial",
    name: "Financial analyst",
    role: "Financial statement analyst",
    goal: "Judge growth, profitability and balance-sheet strength from the reported figures alone.",
    backstory:
      "You were an auditor before you were an analyst. You read cash flow before earnings, and you notice when margins and cash conversion tell different stories.",
    dimensions: ["growth", "profitability", "balance_sheet"],
  },
  {
    id: "valuation",
    name: "Valuation analyst",
    role: "Valuation specialist",
    goal: "Judge whether the price is justified by what the evidence shows the business produces.",
    backstory:
      "You price businesses for a living. You think in multiples, yields and what growth a price implies, and you are unmoved by a story that the multiples cannot support.",
    dimensions: ["valuation"],
  },
  {
    id: "industry",
    name: "Industry analyst",
    role: "Industry and competition analyst",
    goal: "Judge the durability of the company's franchise and its position against competitors.",
    backstory:
      "You map industries: who supplies whom, who is gaining share, where margins are being competed away. You separate a moat from a head start.",
    dimensions: ["competitive_position", "business_quality"],
  },
  {
    id: "macro",
    name: "Macro analyst",
    role: "Macro strategist",
    goal: "Judge how rates, inflation, growth and the dollar in the evidence bear on this particular company.",
    backstory:
      "You trade the connection between the economy and single stocks. You never apply a macro view to a company without saying through which channel it acts.",
    dimensions: ["macro"],
  },
  {
    id: "news",
    name: "News analyst",
    role: "News and sentiment analyst",
    goal: "Judge what the recent headlines and price action actually say, separating signal from repetition.",
    backstory:
      "You run a newsroom's markets desk. You know ten articles about one event are one event, and that a price move is evidence of expectations, not of fundamentals.",
    dimensions: ["news_flow"],
  },
  {
    id: "risk",
    name: "Risk analyst",
    role: "Risk officer",
    goal: "Find everything that could make an investment in this company go wrong, and rank it by severity.",
    backstory:
      "You sit on the risk committee. Your job is to be the person who asked about the thing that later went wrong. You rank risks by what the evidence supports, not by how dramatic they sound.",
    dimensions: [],
  },
];

/* ---------------------------------------------------------------- the rules */

const CONSTITUTION = `RULES THAT BIND EVERY SEAT
- Use only the evidence pack above. You have no other knowledge of this company, its prices or its results.
- Every factual statement must cite the evidence items it comes from by id, e.g. ["E4","E12"].
- Any number you write must appear in an item you cite. You may restate a ratio as a percentage (0.2834 as 28.3%) or round it, but never compute a new figure, and never state a price target or a forecast.
- Separate fact from judgement. Judgements go in reasons and theses; claims are facts.
- If the evidence is too thin to judge something, say so and score it null. Missing evidence is not neutral evidence.
- Reply with one JSON object and nothing else.`;

const METRIC_RULE = `A rule is optional and only allowed when the condition can be checked against a future annual filing:
{"metric": one of ${JSON.stringify(RULE_METRICS)}, "operator": "<" | ">" | "<=" | ">=", "value": number}
Ratios are decimals (15% is 0.15).`;

function seatHeader(seat: Seat): string {
  return `ROLE: ${seat.role}\nGOAL: ${seat.goal}\nBACKSTORY: ${seat.backstory}`;
}

function scaleFor(keys: readonly DimensionKey[]): string {
  return DIMENSIONS.filter((d) => keys.includes(d.key))
    .map((d) => `  "${d.key}": ${d.scale}`)
    .join("\n");
}

/* ------------------------------------------------------------- analyst task */

export function analystInstructions(seat: Seat, focus: string | null): string {
  const dims = seat.dimensions;
  const scoring =
    dims.length > 0
      ? `Score each of these dimensions from -2 to +2, or null when the evidence cannot support a score:\n${scaleFor(dims)}`
      : "You do not score dimensions. Put your effort into the risks list.";

  return `${seatHeader(seat)}

${CONSTITUTION}

TASK
Analyse the company in the evidence pack from your seat.${focus ? `\nThe committee has been asked specifically: "${focus}". Address it in your summary.` : ""}
${scoring}

EXPECTED OUTPUT
{
  "summary": "2-3 sentences: your view and the one thing it hinges on",
  "dimensions": {${dims.map((d) => `\n    "${d}": {"score": -2..2 or null, "reason": "one sentence", "evidence": ["E.."]}`).join(",")}
  },
  "claims": [{"text": "one factual sentence", "evidence": ["E.."]}],
  "bull": ["one sentence each"],
  "bear": ["one sentence each"],
  "risks": [{"text": "one sentence", "severity": "low" | "medium" | "high", "evidence": ["E.."]}],
  "catalysts": ["one sentence each"],
  "assumptions": [{"text": "an assumption your view depends on", "metric": "...", "operator": "...", "value": 0}],
  "thesis": "1-2 sentences"
}
Give ${seat.id === "analyst" ? "6 to 10" : "3 to 6"} claims${seat.id === "risk" ? " and 4 to 8 risks" : ""}.
${METRIC_RULE}`;
}

/* --------------------------------------------------------------- bull / bear */

export function advocateInstructions(side: "bull" | "bear"): string {
  const seat =
    side === "bull"
      ? {
          role: "Bull advocate",
          goal: "Make the strongest honest case that an investment in this company succeeds.",
          backstory: "You argue the long side in the committee room. You win by evidence, not enthusiasm, and you concede what you cannot defend.",
        }
      : {
          role: "Bear advocate",
          goal: "Make the strongest honest case that an investment in this company fails.",
          backstory: "You argue the short side in the committee room. You win by evidence, not alarm, and you concede what you cannot attack.",
        };

  return `ROLE: ${seat.role}\nGOAL: ${seat.goal}\nBACKSTORY: ${seat.backstory}

${CONSTITUTION}

TASK
You are given the evidence pack and the anonymised views of the committee's analysts. Build the ${side} case.
Each argument must stand on cited evidence. Rate its strength: 3 = the evidence directly shows it, 2 = the evidence strongly suggests it, 1 = plausible but thinly supported.

EXPECTED OUTPUT
{
  "arguments": [{"text": "one sentence", "evidence": ["E.."], "strength": 1 | 2 | 3}],
  "strongest": "your single strongest point, one sentence",
  "concession": "the strongest point on the other side, which you cannot rebut, one sentence"
}
Give 3 to 6 arguments.`;
}

/* ---------------------------------------------------------------- challenger */

export function challengerInstructions(): string {
  return `ROLE: Challenger
GOAL: Prove the committee's emerging view wrong.
BACKSTORY: You are paid to find the hole in the argument before the market does. You ask what would have to be true, what the price already assumes, and what the committee is not looking at.

${CONSTITUTION}

TASK
You are given the evidence pack and the committee's preliminary consensus. For each part of it you can attack, say what would make it wrong.
Consider: what assumptions it requires; what in the evidence contradicts it; whether the market price already reflects it; survivorship or recency bias; accounting quality (cash flow versus earnings); competitors; concentration.

EXPECTED OUTPUT
{
  "challenges": [{"target": "the dimension or claim you attack", "question": "the question the committee must answer", "why": "one sentence", "evidence": ["E.."]}],
  "priced_in": "one sentence on what the current price appears to assume, citing valuation evidence",
  "blind_spot": "the single most important thing the committee is not considering"
}
Give 3 to 6 challenges.`;
}

/* ------------------------------------------------------------- fact checker */

export function factCheckerInstructions(): string {
  return `ROLE: Fact checker
GOAL: Decide, claim by claim, whether the cited evidence supports what the claim says.
BACKSTORY: You work the verification desk. You have no opinions about the company. You check the sentence against the source and nothing else.

TASK
Each claim below is followed by the evidence items it cites, quoted in full. For each claim decide:
- "supported": the cited items say this, or a fair reading of them does
- "unsupported": the cited items do not say this — it may be true, but not from this evidence
- "contradicted": the cited items say otherwise
Judge only against the quoted items. Do not use anything you know about the company.

EXPECTED OUTPUT
{"checks": [{"id": "claim id", "verdict": "supported" | "unsupported" | "contradicted", "reason": "under 20 words"}]}
Include every claim id exactly once. Reply with the JSON object only.`;
}

/* --------------------------------------------------------------------- judge */

export function judgeInstructions(): string {
  return `ROLE: Judge
GOAL: Decide what the committee's evidence actually supports, where it does not, and where honest disagreement remains.
BACKSTORY: You chair the investment committee. You do not pick a favourite analyst; you weigh arguments on their evidence and you keep disagreements on the record rather than smoothing them over.

${CONSTITUTION}

TASK
You receive the analysts' views (anonymised as Analyst A, B, …), the specialists, the bull and bear cases, the challenger, and the fact-check result of every claim (verified / sourced / miscited / unsupported / contradicted). Claims code has already marked unsupported or contradicted are out; do not revive them.
1. Mark any remaining claim that is weak (true but overstated, or poorly supported) or that should be rejected (misleading, or a judgement dressed as a fact). Claims you do not list are accepted.
2. For each dimension, give the score the evidence best supports, and whether it is contested (the arguments on each side are both well-supported).
3. Record the real disagreements: what each side holds, why it matters, and what evidence would settle it.
4. Grade each analyst from 0 to 10 on: logic, financial_reasoning, risk_awareness, completeness, assumptions (made explicit), uncertainty (communicated honestly).

EXPECTED OUTPUT
{
  "claims": [{"id": "claim id", "verdict": "weak" | "reject", "reason": "one sentence"}],
  "dimensions": {"<dimension>": {"score": -2..2 or null, "contested": true | false, "note": "one sentence"}},
  "disagreements": [{"topic": "...", "sides": ["one position", "the other"], "why_it_matters": "...", "would_resolve": "what evidence would settle it"}],
  "analyst_grades": {"A": {"logic": 0-10, "financial_reasoning": 0-10, "risk_awareness": 0-10, "completeness": 0-10, "assumptions": 0-10, "uncertainty": 0-10}},
  "critical_uncertainty": "the single unknown the conclusion depends on most"
}
Dimensions: ${DIMENSION_KEYS.join(", ")}.`;
}

/* -------------------------------------------------------------- synthesizer */

export function synthesizerInstructions(focus: string | null): string {
  return `ROLE: Synthesizer
GOAL: Write the committee's final conclusion from what survived verification and judgement — nothing else.
BACKSTORY: You write the committee's minutes for the person who will make the decision. You are precise, you keep the disagreements visible, and you never add a fact the committee did not establish.

${CONSTITUTION}

TASK
Write the Capital Consensus. You receive the accepted claims, the claims marked weak (use with care, say so), the dimension ratings computed from the committee, the disagreements, and the challenges.${focus ? `\nAnswer the question the committee was convened for: "${focus}".` : ""}
Every number in the headline, thesis and cases must appear in the evidence. Rejected and unsupported claims have been removed; do not reintroduce what they said.
Give invalidation conditions: what evidence in a future filing would show the thesis is wrong. Write them as rules where you can.

EXPECTED OUTPUT
{
  "headline": "one line, under 100 characters",
  "thesis": "2-4 sentences",
  "answer": ${focus ? `"a direct answer to the committee's question, 1-3 sentences"` : "null"},
  "cases": {"bull": "what has to go right, 1-2 sentences", "base": "the most likely path given the evidence, 1-2 sentences", "bear": "what could go wrong, 1-2 sentences"},
  "claims": [{"text": "one factual sentence", "evidence": ["E.."]}],
  "risks": [{"text": "one sentence", "severity": "low" | "medium" | "high", "evidence": ["E.."]}],
  "catalysts": ["one sentence each"],
  "primary_disagreement": "one sentence",
  "critical_uncertainty": "one sentence",
  "assumptions": [{"text": "...", "metric": "...", "operator": "...", "value": 0}],
  "invalidation": [{"text": "evidence that would break the thesis", "metric": "...", "operator": "...", "value": 0}],
  "monitor": ["metrics or events to watch"]
}
${METRIC_RULE}
For invalidation rules the condition is the breaking condition: {"metric": "gross_margin", "operator": "<", "value": 0.6} means the thesis breaks if gross margin falls below 60%.`;
}

/* ------------------------------------------------------------ normalizers */

// Models drift from the schema in small ways — a string where a list belongs, a
// score of "1" — so everything is coerced field by field and anything that
// cannot be read is dropped, never guessed at.

export interface CitedText {
  text: string;
  evidence: string[];
}

export interface Risk extends CitedText {
  severity: "low" | "medium" | "high";
}

export interface RuleText {
  text: string;
  metric: string | null;
  operator: "<" | ">" | "<=" | ">=" | null;
  value: number | null;
}

export interface DimensionView {
  score: Score | null;
  reason: string;
  evidence: string[];
}

export interface AnalystView {
  summary: string;
  dimensions: Partial<Record<DimensionKey, DimensionView>>;
  claims: CitedText[];
  bull: string[];
  bear: string[];
  risks: Risk[];
  catalysts: string[];
  assumptions: RuleText[];
  thesis: string;
}

export interface AdvocateView {
  arguments: Array<CitedText & { strength: 1 | 2 | 3 }>;
  strongest: string;
  concession: string;
}

export interface ChallengerView {
  challenges: Array<{ target: string; question: string; why: string; evidence: string[] }>;
  pricedIn: string;
  blindSpot: string;
}

export interface JudgeView {
  claims: Array<{ id: string; verdict: "weak" | "reject"; reason: string }>;
  dimensions: Partial<Record<DimensionKey, { score: Score | null; contested: boolean; note: string }>>;
  disagreements: Disagreement[];
  grades: Record<string, Record<string, number>>;
  criticalUncertainty: string;
}

export interface Disagreement {
  topic: string;
  sides: string[];
  whyItMatters: string;
  wouldResolve: string;
}

export interface SynthesisView {
  headline: string;
  thesis: string;
  answer: string | null;
  cases: { bull: string; base: string; bear: string };
  claims: CitedText[];
  risks: Risk[];
  catalysts: string[];
  primaryDisagreement: string;
  criticalUncertainty: string;
  assumptions: RuleText[];
  invalidation: RuleText[];
  monitor: string[];
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

function str(v: unknown, max = 600): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

function strings(v: unknown, limit = 8): string[] {
  return list(v)
    .map((item) => (typeof item === "string" ? item : str(obj(item).text)))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function ids(v: unknown): string[] {
  return [
    ...new Set(
      list(v)
        .map((id) => String(id).trim().replace(/^\[|\]$/g, "").toUpperCase())
        .filter((id) => /^E\d+$/.test(id))
    ),
  ];
}

export function score(v: unknown): Score | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-2, Math.min(2, Math.round(n))) as Score;
}

function cited(v: unknown, limit = 12): CitedText[] {
  return list(v)
    .map((item) =>
      typeof item === "string"
        ? { text: item.trim(), evidence: ids(item.match(/E\d+/g) ?? []) }
        : { text: str(obj(item).text), evidence: ids(obj(item).evidence) }
    )
    .filter((c) => c.text)
    .slice(0, limit);
}

function severity(v: unknown): Risk["severity"] {
  return v === "high" || v === "low" ? v : "medium";
}

function risks(v: unknown, limit = 10): Risk[] {
  return list(v)
    .map((item) => {
      const o = typeof item === "string" ? { text: item } : obj(item);
      return { text: str(o.text), evidence: ids(o.evidence), severity: severity(o.severity) };
    })
    .filter((r) => r.text)
    .slice(0, limit);
}

const OPERATORS = ["<", ">", "<=", ">="] as const;

function rules(v: unknown, limit = 6): RuleText[] {
  return list(v)
    .map((item) => {
      const o = typeof item === "string" ? { text: item } : obj(item);
      const metric = typeof o.metric === "string" && RULE_METRICS.includes(o.metric) ? o.metric : null;
      const operator = OPERATORS.find((op) => op === o.operator) ?? null;
      const value = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : null;
      const complete = metric !== null && operator !== null && value !== null;
      return {
        text: str(o.text),
        metric: complete ? metric : null,
        operator: complete ? operator : null,
        value: complete ? value : null,
      };
    })
    .filter((r) => r.text)
    .slice(0, limit);
}

function dimensionKey(k: string): k is DimensionKey {
  return (DIMENSION_KEYS as string[]).includes(k);
}

export function toAnalystView(raw: unknown, allowed: DimensionKey[]): AnalystView {
  const o = obj(raw);
  const dims: AnalystView["dimensions"] = {};
  for (const [k, v] of Object.entries(obj(o.dimensions))) {
    if (!dimensionKey(k) || !allowed.includes(k)) continue;
    const d = typeof v === "number" ? { score: v } : obj(v);
    dims[k] = { score: score(d.score), reason: str(d.reason, 300), evidence: ids(d.evidence) };
  }
  return {
    summary: str(o.summary, 800),
    dimensions: dims,
    claims: cited(o.claims),
    bull: strings(o.bull),
    bear: strings(o.bear),
    risks: risks(o.risks),
    catalysts: strings(o.catalysts),
    assumptions: rules(o.assumptions),
    thesis: str(o.thesis, 800),
  };
}

export function toAdvocateView(raw: unknown): AdvocateView {
  const o = obj(raw);
  return {
    arguments: list(o.arguments)
      .map((item) => {
        const a = obj(item);
        const strength = Number(a.strength);
        return {
          text: str(a.text),
          evidence: ids(a.evidence),
          strength: (strength >= 3 ? 3 : strength <= 1 ? 1 : 2) as 1 | 2 | 3,
        };
      })
      .filter((a) => a.text)
      .slice(0, 8),
    strongest: str(o.strongest, 400),
    concession: str(o.concession, 400),
  };
}

export function toChallengerView(raw: unknown): ChallengerView {
  const o = obj(raw);
  return {
    challenges: list(o.challenges)
      .map((item) => {
        const c = obj(item);
        return { target: str(c.target, 120), question: str(c.question, 400), why: str(c.why, 400), evidence: ids(c.evidence) };
      })
      .filter((c) => c.question)
      .slice(0, 8),
    pricedIn: str(o.priced_in, 500),
    blindSpot: str(o.blind_spot, 500),
  };
}

export function toFactChecks(
  raw: unknown
): Array<{ id: string; verdict: "supported" | "unsupported" | "contradicted"; reason: string }> {
  return list(obj(raw).checks)
    .map((item) => {
      const c = obj(item);
      const verdict =
        c.verdict === "contradicted" || c.verdict === "unsupported" || c.verdict === "supported"
          ? (c.verdict as "supported" | "unsupported" | "contradicted")
          : null;
      return verdict ? { id: str(c.id, 40), verdict, reason: str(c.reason, 200) } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null && Boolean(c.id));
}

function disagreements(v: unknown): Disagreement[] {
  return list(v)
    .map((item) => {
      const d = obj(item);
      return {
        topic: str(d.topic, 200),
        sides: strings(d.sides, 4),
        whyItMatters: str(d.why_it_matters, 400),
        wouldResolve: str(d.would_resolve, 400),
      };
    })
    .filter((d) => d.topic)
    .slice(0, 6);
}

export const GRADE_CRITERIA = [
  "logic",
  "financial_reasoning",
  "risk_awareness",
  "completeness",
  "assumptions",
  "uncertainty",
] as const;

export function toJudgeView(raw: unknown): JudgeView {
  const o = obj(raw);

  const dims: JudgeView["dimensions"] = {};
  for (const [k, v] of Object.entries(obj(o.dimensions))) {
    if (!dimensionKey(k)) continue;
    const d = obj(v);
    dims[k] = { score: score(d.score), contested: d.contested === true, note: str(d.note, 300) };
  }

  const grades: JudgeView["grades"] = {};
  for (const [letter, g] of Object.entries(obj(o.analyst_grades))) {
    const out: Record<string, number> = {};
    for (const criterion of GRADE_CRITERIA) {
      const n = Number(obj(g)[criterion]);
      if (Number.isFinite(n)) out[criterion] = Math.max(0, Math.min(10, n));
    }
    grades[letter.replace(/^Analyst\s+/i, "").trim().toUpperCase()] = out;
  }

  return {
    claims: list(o.claims)
      .map((item) => {
        const c = obj(item);
        const verdict: "weak" | "reject" | null =
          c.verdict === "reject" ? "reject" : c.verdict === "weak" ? "weak" : null;
        return verdict ? { id: str(c.id, 40), verdict, reason: str(c.reason, 300) } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && Boolean(c.id)),
    dimensions: dims,
    disagreements: disagreements(o.disagreements),
    grades,
    criticalUncertainty: str(o.critical_uncertainty, 400),
  };
}

export function toSynthesisView(raw: unknown): SynthesisView {
  const o = obj(raw);
  const cases = obj(o.cases);
  return {
    headline: str(o.headline, 160),
    thesis: str(o.thesis, 1200),
    answer: str(o.answer, 800) || null,
    cases: { bull: str(cases.bull, 600), base: str(cases.base, 600), bear: str(cases.bear, 600) },
    claims: cited(o.claims, 14),
    risks: risks(o.risks),
    catalysts: strings(o.catalysts),
    primaryDisagreement: str(o.primary_disagreement, 400),
    criticalUncertainty: str(o.critical_uncertainty, 400),
    assumptions: rules(o.assumptions),
    invalidation: rules(o.invalidation),
    monitor: strings(o.monitor, 10),
  };
}
