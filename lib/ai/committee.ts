import { pool } from "../db";
import { ACCOUNT_ID } from "../constants";
import { resolveCompany } from "../resolve";
import { addToWatchlist, type CompanyRow } from "../company";
import { scout } from "../agents";
import { extractJson, inputHash } from "../llm";
import { buildEvidence, formatValue, renderEvidence, type EvidencePack } from "./evidence";
import {
  availableModels,
  pickForStage,
  rankForStage,
  seatAnalysts,
  stageRecords,
  type ModelSpec,
  type Stage,
  type StageRecord,
} from "./models";
import { callModel } from "./providers";
import {
  checkClaim,
  summarizeChecks,
  unsupportedFigures,
  type Check,
  type Claim,
} from "./factcheck";
import {
  ANALYST,
  GRADE_CRITERIA,
  SPECIALISTS,
  advocateInstructions,
  analystInstructions,
  challengerInstructions,
  factCheckerInstructions,
  judgeInstructions,
  synthesizerInstructions,
  toAdvocateView,
  toAnalystView,
  toChallengerView,
  toFactChecks,
  toJudgeView,
  toSynthesisView,
  type AdvocateView,
  type AnalystView,
  type ChallengerView,
  type Disagreement,
  type JudgeView,
  type Seat,
  type SynthesisView,
} from "./roster";
import { confidenceOf, dimensionConsensus, type DimensionResult, type ScoredView } from "./consensus";
import { modeSpec, plannedCalls, type Mode } from "./modes";
import type { ConsensusReport, ModelScorecard, ReportClaim, SeatSummary } from "./report";
import {
  createRun,
  failRun,
  findCachedRun,
  finishRun,
  reapStaleRuns,
  recordCall,
  runsToday,
  saveClaims,
  saveEvaluations,
  type EvaluationRow,
} from "./store";
import { remember } from "./memory";
import { addJournal } from "./journal";

/* ---------------------------------------------------------------------------
   The orchestrator.

   One request in — a ticker, a mode, optionally a question — and one Capital
   Consensus out. It decides which seats sit and which model fills each,
   builds the evidence once, runs the phases in order, and writes every call,
   claim and grade to the ledger as it goes. Each phase only ever receives
   material the phase before it has checked.
--------------------------------------------------------------------------- */

export class NoCommitteeError extends Error {
  constructor() {
    super(
      "No model is configured. Add ANTHROPIC_API_KEY to .env.local — or the key for any provider in models.json — to seat the committee."
    );
    this.name = "NoCommitteeError";
  }
}

const DAILY_RUN_BUDGET = Number(process.env.DAILY_CONSENSUS_BUDGET ?? 12);

export class CommitteeBudgetError extends Error {
  constructor() {
    super(`the daily budget of ${DAILY_RUN_BUDGET} committee runs is used up (DAILY_CONSENSUS_BUDGET)`);
    this.name = "CommitteeBudgetError";
  }
}

export type PhaseId = "evidence" | "analysis" | "debate" | "fact_check" | "judge" | "synthesis";

export interface PlanPhase {
  id: PhaseId;
  label: string;
  seats: Array<{ agent: string; model: string }>;
}

export type RunEvent =
  | { type: "plan"; ticker: string; name: string; mode: Mode; phases: PlanPhase[]; calls: number }
  | { type: "phase"; phase: PhaseId; status: "running" | "done" | "skipped"; note?: string }
  | { type: "call"; phase: PhaseId; agent: string; model: string; ok: boolean; tokens: number; ms: number; error?: string }
  | { type: "cached"; runId: string }
  | { type: "done"; runId: string }
  | { type: "error"; message: string };

export interface RunOptions {
  ticker: string;
  mode: Mode | "auto";
  focus?: string | null;
  // restrict the analyst seats to these registry ids
  modelIds?: string[];
  force?: boolean;
  // Replaces the provider call. The self-test uses it to drive a whole run with
  // scripted replies; nothing in the app passes it.
  caller?: typeof callModel;
}

/* ------------------------------------------------------------ run context */

// Every model call goes through here, so the meter cannot be bypassed.
class RunContext {
  calls = 0;
  failed = 0;
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  priced = 0;
  unpriced = 0;
  costUsd = 0;
  readonly started = Date.now();

  constructor(
    readonly runId: string,
    readonly evidence: string,
    readonly emit: (event: RunEvent) => void,
    private readonly caller: typeof callModel = callModel
  ) {}

  async ask<T>(input: {
    phase: PhaseId;
    stage: Stage;
    agent: string;
    spec: ModelSpec;
    instructions: string;
    user: string;
    maxTokens: number;
    normalize: (raw: unknown) => T;
  }): Promise<{ value: T | null; callId: number | null; error: string | null }> {
    let user = input.user;

    // One retry, for the one failure that is worth retrying: a reply that was not
    // valid JSON. A provider error is not retried — it would fail the same way.
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string | null = null;
      try {
        const result = await this.caller(input.spec, {
          evidence: this.evidence,
          instructions: input.instructions,
          user,
          maxTokens: input.maxTokens,
        });
        text = result.text;
        this.meter(result);

        let raw: unknown;
        try {
          raw = extractJson<unknown>(result.text);
        } catch (err) {
          const callId = await recordCall({
            runId: this.runId,
            stage: input.stage,
            agent: input.agent,
            spec: input.spec,
            output: null,
            rawText: text,
            error: `unreadable reply: ${(err as Error).message}`,
            usage: result,
          });
          this.emit(this.callEvent(input, false, result.inputTokens + result.outputTokens, result.latencyMs, "reply was not JSON"));
          if (attempt === 0) {
            user = `${input.user}\n\nYour previous reply could not be parsed as JSON. Reply again with only the JSON object described above.`;
            continue;
          }
          this.failed++;
          return { value: null, callId, error: "the model did not return JSON" };
        }

        const value = input.normalize(raw);
        const callId = await recordCall({
          runId: this.runId,
          stage: input.stage,
          agent: input.agent,
          spec: input.spec,
          output: value,
          rawText: null,
          error: null,
          usage: result,
        });
        this.emit(this.callEvent(input, true, result.inputTokens + result.outputTokens, result.latencyMs));
        return { value, callId, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.calls++;
        this.failed++;
        const callId = await recordCall({
          runId: this.runId,
          stage: input.stage,
          agent: input.agent,
          spec: input.spec,
          output: null,
          rawText: text,
          error: message,
          usage: null,
        });
        this.emit(this.callEvent(input, false, 0, 0, message));
        return { value: null, callId, error: message };
      }
    }
    return { value: null, callId: null, error: "no reply" };
  }

  private meter(result: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number | null }) {
    this.calls++;
    this.inputTokens += result.inputTokens;
    this.outputTokens += result.outputTokens;
    this.cachedTokens += result.cachedTokens;
    if (result.costUsd === null) this.unpriced++;
    else {
      this.priced++;
      this.costUsd += result.costUsd;
    }
  }

  private callEvent(
    input: { phase: PhaseId; agent: string; spec: ModelSpec },
    ok: boolean,
    tokens: number,
    ms: number,
    error?: string
  ): RunEvent {
    return { type: "call", phase: input.phase, agent: input.agent, model: input.spec.label, ok, tokens, ms, error };
  }

  cost(): ConsensusReport["cost"] {
    return {
      calls: this.calls,
      failed: this.failed,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cachedTokens,
      costUsd: this.priced > 0 ? this.costUsd : null,
      unpriced: this.unpriced,
      seconds: Math.round((Date.now() - this.started) / 1000),
    };
  }
}

/* ------------------------------------------------------------- the claims */

interface ClaimEntry extends Claim {
  callId: number | null;
  check: Check;
  judge: { verdict: "weak" | "reject"; reason: string } | null;
}

function collectClaims(
  keyPrefix: string,
  items: Array<{ text: string; evidence: string[] }>,
  meta: { agent: string; modelId: string; stage: string; callId: number | null },
  pack: EvidencePack
): ClaimEntry[] {
  return items.map((item, i) => {
    const claim: Claim = {
      key: `${keyPrefix}${i + 1}`,
      text: item.text,
      evidence: item.evidence,
      agent: meta.agent,
      modelId: meta.modelId,
      stage: meta.stage,
    };
    return { ...claim, callId: meta.callId, check: checkClaim(claim, pack), judge: null };
  });
}

const FAILED = new Set(["unsupported", "contradicted"]);

function standing(c: ClaimEntry): boolean {
  return !FAILED.has(c.check.verdict) && c.judge?.verdict !== "reject";
}

/* ------------------------------------------------------------------- mode */

async function autoMode(company: CompanyRow): Promise<Mode> {
  // A held position or an open thesis is a decision already made with money or
  // conviction behind it, so it gets the deeper look.
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM transactions WHERE company_id = $1 AND account_id = $2) AS held,
            EXISTS (SELECT 1 FROM theses WHERE company_id = $1 AND status = 'open') AS thesis`,
    [company.id, ACCOUNT_ID]
  );
  return rows[0].held || rows[0].thesis ? "deep" : "standard";
}

// The scout's feeds are free, so headlines are refreshed before the evidence is
// built unless they were fetched recently.
const HEADLINE_FRESH_HOURS = 12;

async function refreshHeadlines(company: CompanyRow): Promise<string> {
  const { rows } = await pool.query(
    `SELECT max(retrieved_at) AS latest FROM headlines WHERE company_id = $1`,
    [company.id]
  );
  const latest = rows[0].latest as Date | null;
  if (latest && Date.now() - latest.getTime() < HEADLINE_FRESH_HOURS * 3_600_000) {
    return "headlines fetched in the last 12 hours";
  }
  try {
    const result = await scout(company);
    const reachable = result.feeds.filter((f) => !f.error).length;
    return `${result.fetched} headlines from ${reachable} of ${result.feeds.length} feeds, ${result.stored} new`;
  } catch (err) {
    return `headline refresh failed: ${(err as Error).message}`;
  }
}

/* ------------------------------------------------------------------- run */

export async function runConsensus(
  opts: RunOptions,
  emit: (event: RunEvent) => void = () => {}
): Promise<{ runId: string; cached: boolean }> {
  const company = await resolveCompany(opts.ticker);
  await addToWatchlist(company.id, null);
  await reapStaleRuns();

  const mode = opts.mode === "auto" ? await autoMode(company) : opts.mode;
  const spec = modeSpec(mode);
  const focus = opts.focus?.trim() || null;

  const everyModel = availableModels();
  if (everyModel.length === 0) throw new NoCommitteeError();

  const chosen = opts.modelIds?.length ? everyModel.filter((m) => opts.modelIds!.includes(m.id)) : everyModel;
  const records = await stageRecords();
  const analysts = seatAnalysts(chosen.length > 0 ? chosen : everyModel, records, spec.seats);

  const cast = castSeats(mode, analysts, everyModel, records);
  emit({
    type: "plan",
    ticker: company.ticker,
    name: company.name,
    mode,
    phases: planPhases(mode, cast),
    calls: plannedCalls(mode, analysts.length),
  });

  /* ---- evidence */

  emit({ type: "phase", phase: "evidence", status: "running" });
  const newsNote = await refreshHeadlines(company);
  const pack = await buildEvidence(company);
  emit({
    type: "phase",
    phase: "evidence",
    status: "done",
    note: `${pack.items.length} evidence items, ${pack.coverage.present} of ${pack.coverage.expected} inputs present; ${newsNote}`,
  });

  const cacheKey = inputHash({
    evidence: pack.hash,
    mode,
    focus,
    analysts: analysts.map((m) => `${m.id}:${m.model}`),
  });

  if (!opts.force) {
    const cached = await findCachedRun(cacheKey);
    if (cached) {
      emit({ type: "cached", runId: cached });
      return { runId: cached, cached: true };
    }
  }

  if ((await runsToday()) >= DAILY_RUN_BUDGET) throw new CommitteeBudgetError();

  const runId = await createRun({ companyId: company.id, mode, focus, evidence: pack, cacheKey, models: analysts });
  const ctx = new RunContext(runId, renderEvidence(pack), emit, opts.caller);

  try {
    const report = await convene(ctx, { company, pack, mode, focus, cast });
    await finishRun(runId, report);

    if (report.synthesis) {
      await remember({
        companyId: company.id,
        runId,
        modelId: report.synthesisBy?.modelId ?? null,
        baselinePeriod: pack.periodEnd,
        assumptions: report.synthesis.assumptions,
        invalidation: report.synthesis.invalidation,
      });
    }
    await addJournal({
      companyId: company.id,
      kind: "committee",
      title: `${spec.label} on ${company.ticker}: ${report.synthesis?.headline || "no conclusion written"}`,
      detail: `Confidence ${report.confidence.label} (${Math.round(report.confidence.score * 100)}). ${report.cost.calls} model calls across ${report.analysts.length} analyst seats.${focus ? ` Question: ${focus}` : ""}`,
      refId: runId,
    });

    emit({ type: "done", runId });
    return { runId, cached: false };
  } catch (err) {
    await failRun(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/* --------------------------------------------------------------- casting */

interface Cast {
  analysts: ModelSpec[];
  specialists: Array<{ seat: Seat; model: ModelSpec }>;
  bull: ModelSpec | null;
  bear: ModelSpec | null;
  challenger: ModelSpec | null;
  factChecker: ModelSpec | null;
  judge: ModelSpec | null;
  synthesizer: ModelSpec | null;
}

function castSeats(mode: Mode, analysts: ModelSpec[], all: ModelSpec[], records: StageRecord[]): Cast {
  const spec = modeSpec(mode);
  const analystIds = analysts.map((m) => m.id);

  // Specialists rotate through the ranked models, so the specialist views do not
  // all come from one model's habits.
  const ranked = rankForStage("specialist", all, records);
  const specialists = spec.specialists
    ? SPECIALISTS.map((seat, i) => ({ seat, model: ranked[i % ranked.length] }))
    : [];

  const bull = spec.debate ? pickForStage("bull", all, records) : null;
  const bear = spec.debate ? pickForStage("bear", all, records, bull ? [bull.id] : []) : null;

  return {
    analysts,
    specialists,
    bull,
    bear,
    challenger: spec.challenger ? pickForStage("challenger", all, records) : null,
    factChecker: spec.modelFactCheck ? pickForStage("fact_check", all, records) : null,
    // The judge preferably did not also sit as an analyst.
    judge: spec.judge ? pickForStage("judge", all, records, analystIds) : null,
    synthesizer: spec.synthesizer ? pickForStage("synthesizer", all, records) : null,
  };
}

function planPhases(mode: Mode, cast: Cast): PlanPhase[] {
  const seat = (agent: string, model: ModelSpec | null) => (model ? [{ agent, model: model.label }] : []);
  const phases: PlanPhase[] = [
    { id: "evidence", label: "Evidence", seats: [{ agent: "Data engine", model: "code" }] },
    {
      id: "analysis",
      label: "Independent analysis",
      seats: [
        ...cast.analysts.map((m, i) => ({ agent: `Analyst ${letter(i)}`, model: m.label })),
        ...cast.specialists.map((s) => ({ agent: s.seat.name, model: s.model.label })),
      ],
    },
  ];
  if (cast.bull || cast.challenger) {
    phases.push({
      id: "debate",
      label: mode === "committee" ? "Debate" : "Challenge",
      seats: [...seat("Bull", cast.bull), ...seat("Bear", cast.bear), ...seat("Challenger", cast.challenger)],
    });
  }
  phases.push({
    id: "fact_check",
    label: "Fact check",
    seats: [{ agent: "Figure checker", model: "code" }, ...seat("Fact checker", cast.factChecker)],
  });
  if (cast.judge) phases.push({ id: "judge", label: "Judge", seats: seat("Judge", cast.judge) });
  phases.push({
    id: "synthesis",
    label: "Synthesis",
    seats: cast.synthesizer ? seat("Synthesizer", cast.synthesizer) : [{ agent: "Pass-through", model: "code" }],
  });
  return phases;
}

function letter(i: number): string {
  return String.fromCharCode(65 + i);
}

/* ---------------------------------------------------------------- convene */

interface ConveneInput {
  company: CompanyRow;
  pack: EvidencePack;
  mode: Mode;
  focus: string | null;
  cast: Cast;
}

async function convene(ctx: RunContext, input: ConveneInput): Promise<ConsensusReport> {
  const { pack, mode, focus, cast } = input;
  const emit = ctx.emit;
  const degraded: string[] = [];

  /* ---- phase 1: independent analysis, blind, all seats at once */

  emit({ type: "phase", phase: "analysis", status: "running" });

  const analystTask = `Analyse ${pack.ticker}. Work only from the evidence pack.`;
  const [analystResults, specialistResults] = await Promise.all([
    Promise.all(
      cast.analysts.map((model, i) =>
        ctx.ask({
          phase: "analysis",
          stage: "analyst",
          agent: `Analyst ${letter(i)}`,
          spec: model,
          instructions: analystInstructions(ANALYST, focus),
          user: analystTask,
          maxTokens: 3500,
          normalize: (raw) => toAnalystView(raw, ANALYST.dimensions),
        })
      )
    ),
    Promise.all(
      cast.specialists.map(({ seat, model }) =>
        ctx.ask({
          phase: "analysis",
          stage: "specialist",
          agent: seat.name,
          spec: model,
          instructions: analystInstructions(seat, focus),
          user: analystTask,
          maxTokens: 2500,
          normalize: (raw) => toAnalystView(raw, seat.dimensions),
        })
      )
    ),
  ]);

  const analysts = cast.analysts.map((model, i) => ({
    letter: letter(i),
    model,
    ...analystResults[i],
  }));
  const specialists = cast.specialists.map((s, i) => ({ ...s, ...specialistResults[i] }));

  const working = analysts.filter((a) => a.value !== null) as Array<(typeof analysts)[number] & { value: AnalystView }>;
  if (working.length === 0) {
    throw new Error(
      `every analyst seat failed: ${analysts.map((a) => `${a.model.label}: ${a.error}`).join("; ")}`
    );
  }
  for (const a of analysts.filter((x) => x.value === null)) {
    degraded.push(`Analyst ${a.letter} (${a.model.label}) failed and was left out: ${a.error}`);
  }
  for (const s of specialists.filter((x) => x.value === null)) {
    degraded.push(`${s.seat.name} (${s.model.label}) failed and was left out`);
  }

  emit({ type: "phase", phase: "analysis", status: "done", note: `${working.length} of ${analysts.length} analysts answered` });

  let claims: ClaimEntry[] = [
    ...working.flatMap((a) =>
      collectClaims(a.letter, a.value.claims, { agent: `Analyst ${a.letter}`, modelId: a.model.id, stage: "analyst", callId: a.callId }, pack)
    ),
    ...specialists.flatMap((s) =>
      s.value
        ? collectClaims(s.seat.id.slice(0, 3).toUpperCase(), s.value.claims, { agent: s.seat.name, modelId: s.model.id, stage: "specialist", callId: s.callId }, pack)
        : []
    ),
  ];

  const scored: ScoredView[] = [
    ...working.map((a) => ({ seat: `Analyst ${a.letter}`, modelId: a.model.id, dimensions: a.value.dimensions })),
    ...specialists
      .filter((s) => s.value)
      .map((s) => ({ seat: s.seat.name, modelId: s.model.id, dimensions: (s.value as AnalystView).dimensions })),
  ];
  const preliminary = dimensionConsensus(scored);

  /* ---- phase 2: debate and challenge, from what the analysts said */

  let bull: AdvocateView | null = null;
  let bear: AdvocateView | null = null;
  let challenger: ChallengerView | null = null;

  if (cast.bull || cast.challenger) {
    emit({ type: "phase", phase: "debate", status: "running" });
    const views = anonymisedViews(working, specialists, claims);

    const [bullResult, bearResult, challengeResult] = await Promise.all([
      cast.bull
        ? ctx.ask({
            phase: "debate",
            stage: "bull",
            agent: "Bull",
            spec: cast.bull,
            instructions: advocateInstructions("bull"),
            user: JSON.stringify({ focus, committee: views }),
            maxTokens: 1800,
            normalize: toAdvocateView,
          })
        : null,
      cast.bear
        ? ctx.ask({
            phase: "debate",
            stage: "bear",
            agent: "Bear",
            spec: cast.bear,
            instructions: advocateInstructions("bear"),
            user: JSON.stringify({ focus, committee: views }),
            maxTokens: 1800,
            normalize: toAdvocateView,
          })
        : null,
      cast.challenger
        ? ctx.ask({
            phase: "debate",
            stage: "challenger",
            agent: "Challenger",
            spec: cast.challenger,
            instructions: challengerInstructions(),
            user: JSON.stringify({ focus, preliminary_consensus: compactDimensions(preliminary), theses: working.map((a) => a.value.thesis) }),
            maxTokens: 1800,
            normalize: toChallengerView,
          })
        : null,
    ]);

    bull = bullResult?.value ?? null;
    bear = bearResult?.value ?? null;
    challenger = challengeResult?.value ?? null;
    if (cast.bull && !bull) degraded.push("The bull advocate failed; the debate is one-sided");
    if (cast.bear && !bear) degraded.push("The bear advocate failed; the debate is one-sided");
    if (cast.challenger && !challenger) degraded.push("The challenger failed; the conclusion was not stress-tested");

    if (bull && cast.bull) {
      claims.push(...collectClaims("BULL", bull.arguments, { agent: "Bull", modelId: cast.bull.id, stage: "bull", callId: bullResult?.callId ?? null }, pack));
    }
    if (bear && cast.bear) {
      claims.push(...collectClaims("BEAR", bear.arguments, { agent: "Bear", modelId: cast.bear.id, stage: "bear", callId: bearResult?.callId ?? null }, pack));
    }
    emit({ type: "phase", phase: "debate", status: "done" });
  }

  /* ---- phase 3: fact check — code on every figure, a model on the rest */

  emit({ type: "phase", phase: "fact_check", status: "running" });
  if (cast.factChecker) {
    claims = await modelFactCheck(ctx, cast.factChecker, claims, pack, degraded);
  }
  const preJudge = summarizeChecks(claims.map((c) => c.check));
  emit({
    type: "phase",
    phase: "fact_check",
    status: "done",
    note: `${preJudge.verified} verified, ${preJudge.sourced} sourced, ${preJudge.unsupported + preJudge.contradicted} failed, ${preJudge.miscited} miscited`,
  });

  /* ---- phase 4: the judge */

  let judge: JudgeView | null = null;
  if (cast.judge) {
    emit({ type: "phase", phase: "judge", status: "running" });
    const result = await ctx.ask({
      phase: "judge",
      stage: "judge",
      agent: "Judge",
      spec: cast.judge,
      instructions: judgeInstructions(),
      user: JSON.stringify({
        focus,
        committee: anonymisedViews(working, specialists, claims),
        bull: bull && advocateForJudge(bull, claims, "BULL"),
        bear: bear && advocateForJudge(bear, claims, "BEAR"),
        challenger,
        preliminary_dimensions: compactDimensions(preliminary),
        claims_removed_by_fact_check: claims.filter((c) => FAILED.has(c.check.verdict)).length,
      }),
      maxTokens: 3500,
      normalize: toJudgeView,
    });
    judge = result.value;
    if (!judge) degraded.push("The judge failed; dimension ratings are the committee's average and no claims were weighed");

    if (judge) {
      const rulings = new Map(judge.claims.map((c) => [c.id.toUpperCase(), c]));
      claims = claims.map((c) => {
        const ruling = rulings.get(c.key.toUpperCase());
        return ruling ? { ...c, judge: { verdict: ruling.verdict, reason: ruling.reason } } : c;
      });
    }
    emit({ type: "phase", phase: "judge", status: "done", note: judge ? `${judge.claims.length} claims marked weak or rejected` : "no ruling" });
  }

  const dimensions = dimensionConsensus(scored, judge?.dimensions);
  const disagreements = judge?.disagreements.length ? judge.disagreements : codeDisagreements(dimensions, working, specialists);

  /* ---- phase 5: synthesis */

  emit({ type: "phase", phase: "synthesis", status: "running" });
  let synthesis: SynthesisView | null = null;
  let synthesisBy: ConsensusReport["synthesisBy"] = null;
  let unverified: string[] = [];

  if (cast.synthesizer) {
    const result = await synthesize(ctx, cast.synthesizer, {
      focus,
      dimensions,
      claims,
      disagreements,
      judge,
      challenger,
      bull,
      bear,
      working,
      specialists,
      pack,
    });
    if (result.synthesis) {
      synthesis = result.synthesis;
      synthesisBy = { kind: "synthesizer", modelId: cast.synthesizer.id, modelLabel: cast.synthesizer.label };
      unverified = result.unverified;
      claims.push(...result.claims);
    } else {
      degraded.push("The synthesizer failed; the conclusion shown is the best-graded analyst's own view");
    }
  }

  if (!synthesis) {
    const best = bestAnalyst(working, claims, judge);
    synthesis = passThrough(best.value, claims.filter((c) => c.agent === `Analyst ${best.letter}`));
    synthesisBy = { kind: "analyst", modelId: best.model.id, modelLabel: best.model.label };
    unverified = synthesisFigures(synthesis, pack);
  }
  emit({ type: "phase", phase: "synthesis", status: "done", note: unverified.length ? `${unverified.length} figures could not be verified` : "every figure verified" });

  /* ---- grade the seats, then assemble */

  const checks = summarizeChecks(claims.map((c) => c.check));
  const scorecards = gradeAnalysts(working, claims, judge);
  await saveEvaluations(ctx.runId, evaluations(scorecards, working, specialists, claims, cast, synthesisBy, unverified));
  await saveClaims(
    ctx.runId,
    claims.map((c) => ({
      callId: c.callId,
      key: c.key,
      text: c.text,
      evidence: c.evidence,
      check: c.check,
      judge: c.judge?.verdict ?? (judge ? "accept" : null),
    }))
  );

  const confidence = confidenceOf({
    dimensions,
    checks,
    coverage: pack.coverage,
    seats: working.length,
    degraded: [
      ...degraded,
      ...(unverified.length ? [`${unverified.length} figures in the conclusion could not be found in the evidence: ${unverified.join(", ")}`] : []),
    ],
  });

  const summaries = (list: Array<{ letter: string; name: string; model: ModelSpec; value: AnalystView | null; error: string | null }>): SeatSummary[] =>
    list.map((s) => ({
      letter: s.letter,
      name: s.name,
      modelId: s.model.id,
      modelLabel: s.model.label,
      ok: s.value !== null,
      error: s.error,
      summary: s.value?.summary ?? "",
      thesis: s.value?.thesis ?? "",
    }));

  return {
    version: 1,
    ticker: pack.ticker,
    name: pack.name,
    mode,
    focus,
    analysts: summaries(analysts.map((a) => ({ ...a, name: `Analyst ${a.letter}` }))),
    specialists: summaries(specialists.map((s) => ({ letter: s.seat.id, name: s.seat.name, model: s.model, value: s.value, error: s.error }))),
    dimensions,
    synthesis,
    synthesisBy,
    unverifiedFigures: unverified,
    claims: claims.map(toReportClaim),
    debate: {
      bull: bull && cast.bull ? { ...bull, modelLabel: cast.bull.label } : null,
      bear: bear && cast.bear ? { ...bear, modelLabel: cast.bear.label } : null,
    },
    challenger: challenger && cast.challenger ? { ...challenger, modelLabel: cast.challenger.label } : null,
    disagreements,
    criticalUncertainty: synthesis.criticalUncertainty || judge?.criticalUncertainty || null,
    checks,
    confidence,
    scorecards,
    adoptableRules: synthesis.invalidation.filter((r) => r.metric !== null),
    coverage: pack.coverage,
    cost: ctx.cost(),
    degraded,
  };

  function toReportClaim(c: ClaimEntry): ReportClaim {
    return {
      key: c.key,
      text: c.text,
      evidence: c.evidence,
      seat: c.agent,
      modelId: c.modelId,
      stage: c.stage,
      check: c.check,
      judge: c.judge,
    };
  }
}

/* ------------------------------------------------------- phase helpers */

type Working = { letter: string; model: ModelSpec; value: AnalystView; callId: number | null };
type Specialist = { seat: Seat; model: ModelSpec; value: AnalystView | null; callId: number | null; error: string | null };

function anonymisedViews(working: Working[], specialists: Specialist[], claims: ClaimEntry[]) {
  const claimsOf = (agent: string) =>
    claims
      .filter((c) => c.agent === agent && !FAILED.has(c.check.verdict))
      .map((c) => ({ id: c.key, text: c.text, evidence: c.evidence, check: c.check.verdict }));

  return {
    analysts: working.map((a) => ({
      id: `Analyst ${a.letter}`,
      summary: a.value.summary,
      thesis: a.value.thesis,
      dimensions: a.value.dimensions,
      claims: claimsOf(`Analyst ${a.letter}`),
      risks: a.value.risks,
    })),
    specialists: specialists
      .filter((s) => s.value)
      .map((s) => ({
        id: s.seat.name,
        summary: (s.value as AnalystView).summary,
        dimensions: (s.value as AnalystView).dimensions,
        claims: claimsOf(s.seat.name),
        risks: (s.value as AnalystView).risks,
      })),
  };
}

function advocateForJudge(view: AdvocateView, claims: ClaimEntry[], prefix: string) {
  return {
    strongest: view.strongest,
    concession: view.concession,
    arguments: claims
      .filter((c) => c.key.startsWith(prefix) && !FAILED.has(c.check.verdict))
      .map((c) => ({ id: c.key, text: c.text, evidence: c.evidence, check: c.check.verdict })),
  };
}

function compactDimensions(dims: DimensionResult[]) {
  return dims.map((d) => ({
    dimension: d.key,
    mean: d.mean === null ? null : Number(d.mean.toFixed(2)),
    agreement: d.agreement === null ? null : Number(d.agreement.toFixed(2)),
    rating: d.label2,
    votes: d.votes.map((v) => `${v.seat}: ${v.score}`),
  }));
}

const MODEL_CHECK_LIMIT = 40;

async function modelFactCheck(
  ctx: RunContext,
  model: ModelSpec,
  claims: ClaimEntry[],
  pack: EvidencePack,
  degraded: string[]
): Promise<ClaimEntry[]> {
  // Only what code could not settle: claims that cite real evidence but carry no
  // figure. The checker sees just the items each claim cites, quoted in full.
  const pending = claims.filter((c) => c.check.verdict === "sourced").slice(0, MODEL_CHECK_LIMIT);
  if (pending.length === 0) return claims;

  const byId = new Map(pack.items.map((i) => [i.id, i]));
  const user = pending
    .map((c) => {
      const quoted = c.evidence
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((item) => {
          const value = item!.value !== undefined ? ` = ${formatValue(item!.value, item!.unit)}` : "";
          return `    [${item!.id}] ${item!.label}${value}${item!.text ? `: ${item!.text}` : ""}`;
        })
        .join("\n");
      return `${c.key}: ${c.text}\n${quoted}`;
    })
    .join("\n\n");

  const result = await ctx.ask({
    phase: "fact_check",
    stage: "fact_check",
    agent: "Fact checker",
    spec: model,
    instructions: factCheckerInstructions(),
    user,
    maxTokens: 3000,
    normalize: toFactChecks,
  });

  if (!result.value) {
    degraded.push("The model fact checker failed; qualitative claims were not checked beyond their citations");
    return claims;
  }

  const rulings = new Map(result.value.map((r) => [r.id.toUpperCase(), r]));
  return claims.map((c) => {
    const ruling = c.check.verdict === "sourced" ? rulings.get(c.key.toUpperCase()) : undefined;
    if (!ruling) return c;
    const verdict = ruling.verdict === "supported" ? "verified" : ruling.verdict;
    return { ...c, check: { verdict, method: "model", reason: ruling.reason || c.check.reason } };
  });
}

// With no judge to name the disagreements, the contested dimensions are the
// disagreements, stated in the seats' own reasons.
function codeDisagreements(dims: DimensionResult[], working: Working[], specialists: Specialist[]): Disagreement[] {
  const reasonOf = (seat: string, key: DimensionResult["key"]) => {
    const analyst = working.find((a) => `Analyst ${a.letter}` === seat);
    const view = analyst?.value ?? specialists.find((s) => s.seat.name === seat)?.value;
    return view?.dimensions[key]?.reason ?? "";
  };

  return dims
    .filter((d) => d.contested && d.votes.length >= 2)
    .map((d) => {
      const high = d.votes.reduce((a, b) => (b.score > a.score ? b : a));
      const low = d.votes.reduce((a, b) => (b.score < a.score ? b : a));
      return {
        topic: d.label,
        sides: [
          `${high.seat} scored ${high.score > 0 ? "+" : ""}${high.score}: ${reasonOf(high.seat, d.key)}`,
          `${low.seat} scored ${low.score > 0 ? "+" : ""}${low.score}: ${reasonOf(low.seat, d.key)}`,
        ],
        whyItMatters: `The seats are ${d.agreement === null ? "" : `${Math.round(d.agreement * 100)}% `}in agreement on ${d.label.toLowerCase()}.`,
        wouldResolve: "",
      };
    });
}

interface SynthesisInput {
  focus: string | null;
  dimensions: DimensionResult[];
  claims: ClaimEntry[];
  disagreements: Disagreement[];
  judge: JudgeView | null;
  challenger: ChallengerView | null;
  bull: AdvocateView | null;
  bear: AdvocateView | null;
  working: Working[];
  specialists: Specialist[];
  pack: EvidencePack;
}

async function synthesize(
  ctx: RunContext,
  model: ModelSpec,
  input: SynthesisInput
): Promise<{ synthesis: SynthesisView | null; claims: ClaimEntry[]; unverified: string[] }> {
  const { pack } = input;
  const accepted = input.claims.filter((c) => standing(c) && c.judge === null);
  const weak = input.claims.filter((c) => standing(c) && c.judge?.verdict === "weak");
  const views = [...input.working.map((a) => a.value), ...input.specialists.map((s) => s.value).filter((v): v is AnalystView => v !== null)];

  const brief = {
    focus: input.focus,
    dimensions: input.dimensions.map((d) => ({
      dimension: d.label,
      rating: d.label2,
      score: d.resolved === null ? null : Number(d.resolved.toFixed(2)),
      agreement: d.agreement === null ? null : Number(d.agreement.toFixed(2)),
      contested: d.contested,
      note: d.note,
    })),
    accepted_claims: accepted.map((c) => ({ id: c.key, text: c.text, evidence: c.evidence })),
    weak_claims: weak.map((c) => ({ id: c.key, text: c.text, evidence: c.evidence, why: c.judge?.reason })),
    disagreements: input.disagreements,
    critical_uncertainty: input.judge?.criticalUncertainty ?? null,
    challenges: input.challenger,
    bull: input.bull && { strongest: input.bull.strongest, concession: input.bull.concession },
    bear: input.bear && { strongest: input.bear.strongest, concession: input.bear.concession },
    analyst_theses: input.working.map((a) => a.value.thesis),
    risks: dedupe(views.flatMap((v) => v.risks), (r) => r.text).slice(0, 14),
    catalysts: dedupe(views.flatMap((v) => v.catalysts), (c) => c).slice(0, 10),
    proposed_assumptions: dedupe(views.flatMap((v) => v.assumptions), (a) => a.text).slice(0, 10),
  };

  const first = await ctx.ask({
    phase: "synthesis",
    stage: "synthesizer",
    agent: "Synthesizer",
    spec: model,
    instructions: synthesizerInstructions(input.focus),
    user: JSON.stringify(brief),
    maxTokens: 3500,
    normalize: toSynthesisView,
  });
  if (!first.value) return { synthesis: null, claims: [], unverified: [] };

  let synthesis = first.value;
  let callId = first.callId;
  let claims = collectClaims("S", synthesis.claims, { agent: "Synthesizer", modelId: model.id, stage: "synthesizer", callId }, pack);
  let problems = synthesisProblems(synthesis, claims, pack);

  // Communicative dehallucination, ChatDev's term for it: a failed check goes back
  // to the writer with the exact figures that failed, once, rather than being
  // quietly deleted or quietly kept.
  if (problems.length > 0) {
    const revised = await ctx.ask({
      phase: "synthesis",
      stage: "synthesizer",
      agent: "Synthesizer (revision)",
      spec: model,
      instructions: synthesizerInstructions(input.focus),
      user: `${JSON.stringify(brief)}\n\nYOUR DRAFT:\n${JSON.stringify(synthesis)}\n\nThe fact checker could not find these in the evidence pack:\n${problems
        .map((p) => `- ${p}`)
        .join("\n")}\nRewrite the whole JSON object. Correct each figure to one that appears in the evidence, or remove it.`,
      maxTokens: 3500,
      normalize: toSynthesisView,
    });
    if (revised.value) {
      synthesis = revised.value;
      callId = revised.callId;
      claims = collectClaims("S", synthesis.claims, { agent: "Synthesizer", modelId: model.id, stage: "synthesizer", callId }, pack);
      problems = synthesisProblems(synthesis, claims, pack);
    }
  }

  // Synthesizer claims that still fail are dropped from the conclusion, but kept
  // in the claim ledger with the verdict that removed them.
  synthesis = { ...synthesis, claims: synthesis.claims.filter((_, i) => standing(claims[i])) };
  return { synthesis, claims, unverified: synthesisFigures(synthesis, pack) };
}

function synthesisProblems(synthesis: SynthesisView, claims: ClaimEntry[], pack: EvidencePack): string[] {
  return [
    ...claims.filter((c) => FAILED.has(c.check.verdict)).map((c) => `"${c.text}" — ${c.check.reason}`),
    ...synthesisFigures(synthesis, pack).map((f) => `the figure ${f} in your prose`),
  ];
}

function synthesisFigures(s: SynthesisView, pack: EvidencePack): string[] {
  const prose = [
    s.headline,
    s.thesis,
    s.answer ?? "",
    s.cases.bull,
    s.cases.base,
    s.cases.bear,
    s.primaryDisagreement,
    s.criticalUncertainty,
    ...s.risks.map((r) => r.text),
    ...s.catalysts,
  ].join("\n");
  return [...new Set(unsupportedFigures(prose, pack))];
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item).toLowerCase().replace(/\W+/g, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Fast mode, or a failed synthesizer: the conclusion is one analyst's view,
// passed through with its failed claims removed and nothing added.
function passThrough(view: AnalystView, own: ClaimEntry[]): SynthesisView {
  const kept = new Set(own.filter(standing).map((c) => c.text));
  return {
    headline: firstSentence(view.summary),
    thesis: view.thesis,
    answer: null,
    cases: { bull: view.bull.join(" "), base: view.summary, bear: view.bear.join(" ") },
    claims: view.claims.filter((c) => kept.has(c.text)),
    risks: view.risks,
    catalysts: view.catalysts,
    primaryDisagreement: "",
    criticalUncertainty: "",
    assumptions: view.assumptions,
    invalidation: [],
    monitor: [],
  };
}

function firstSentence(text: string): string {
  const match = text.match(/^(.{20,160}?[.!?])(\s|$)/);
  return (match ? match[1] : text.slice(0, 120)).trim();
}

/* ------------------------------------------------------------- grading */

function gradeAnalysts(working: Working[], claims: ClaimEntry[], judge: JudgeView | null): ModelScorecard[] {
  return working.map((a) => {
    const own = claims.filter((c) => c.agent === `Analyst ${a.letter}`);
    const stats = summarizeChecks(own.map((c) => c.check));
    const grades = judge?.grades[a.letter] ?? {};
    const parts = [
      stats.accuracy,
      stats.evidenceRate,
      ...GRADE_CRITERIA.map((k) => (grades[k] === undefined ? null : grades[k] / 10)),
    ].filter((v): v is number => v !== null);

    return {
      letter: a.letter,
      modelId: a.model.id,
      modelLabel: a.model.label,
      claims: own.length,
      verified: stats.verified,
      failed: stats.unsupported + stats.contradicted,
      accuracy: stats.accuracy,
      evidenceRate: stats.evidenceRate,
      grades,
      overall: parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null,
    };
  });
}

function bestAnalyst(working: Working[], claims: ClaimEntry[], judge: JudgeView | null): Working {
  const cards = gradeAnalysts(working, claims, judge);
  let best = 0;
  cards.forEach((card, i) => {
    if ((card.overall ?? 0) > (cards[best].overall ?? 0)) best = i;
  });
  return working[best];
}

function evaluations(
  cards: ModelScorecard[],
  working: Working[],
  specialists: Specialist[],
  claims: ClaimEntry[],
  cast: Cast,
  synthesisBy: ConsensusReport["synthesisBy"],
  unverified: string[]
): EvaluationRow[] {
  const rows: EvaluationRow[] = [];
  const mean = (values: Array<number | null>) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length ? present.reduce((s, v) => s + v, 0) / present.length : null;
  };

  for (const card of cards) {
    const scores: Record<string, number> = {};
    if (card.accuracy !== null) scores.accuracy = card.accuracy;
    if (card.evidenceRate !== null) scores.evidence = card.evidenceRate;
    for (const [k, v] of Object.entries(card.grades)) scores[k] = v / 10;
    rows.push({
      callId: working.find((a) => a.letter === card.letter)?.callId ?? null,
      modelId: card.modelId,
      stage: "analyst",
      scores,
      overall: card.overall,
    });
  }

  const byAgent = (agent: string, stage: string, modelId: string, callId: number | null) => {
    const stats = summarizeChecks(claims.filter((c) => c.agent === agent).map((c) => c.check));
    if (stats.total === 0) return;
    const scores: Record<string, number> = {};
    if (stats.accuracy !== null) scores.accuracy = stats.accuracy;
    if (stats.evidenceRate !== null) scores.evidence = stats.evidenceRate;
    rows.push({ callId, modelId, stage, scores, overall: mean([stats.accuracy, stats.evidenceRate]) });
  };

  for (const s of specialists) if (s.value) byAgent(s.seat.name, "specialist", s.model.id, s.callId);
  if (cast.bull) byAgent("Bull", "bull", cast.bull.id, null);
  if (cast.bear) byAgent("Bear", "bear", cast.bear.id, null);

  if (synthesisBy?.kind === "synthesizer") {
    const own = summarizeChecks(claims.filter((c) => c.agent === "Synthesizer").map((c) => c.check));
    // A conclusion that still carries a figure the evidence does not contain is
    // the worst thing a synthesizer can do, so each one costs a quarter.
    const clean = Math.max(0, 1 - unverified.length * 0.25);
    rows.push({
      callId: null,
      modelId: synthesisBy.modelId,
      stage: "synthesizer",
      scores: { ...(own.accuracy !== null ? { accuracy: own.accuracy } : {}), figures: clean },
      overall: mean([own.accuracy, clean]),
    });
  }
  return rows;
}
