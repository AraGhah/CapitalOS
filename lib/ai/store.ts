import { pool, type Db } from "../db";
import { isUuid } from "../ids";
import type { EvidencePack } from "./evidence";
import type { ModelSpec } from "./models";
import type { ModelResult } from "./providers";
import type { Mode } from "./modes";
import type { ConsensusReport, RunSummary } from "./report";
import type { Check } from "./factcheck";
import { recordModelCall } from "./metering";

/* ------------------------------------------------------------------- runs */

export async function createRun(
  input: {
    userId: string;
    companyId: string;
    mode: Mode;
    focus: string | null;
    evidence: EvidencePack;
    cacheKey: string;
    models: ModelSpec[];
  },
  db: Db = pool
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO consensus_runs (company_id, mode, focus, evidence_hash, cache_key, evidence, models, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      input.companyId,
      input.mode,
      input.focus,
      input.evidence.hash,
      input.cacheKey,
      JSON.stringify(input.evidence),
      JSON.stringify(input.models.map((m) => ({ id: m.id, label: m.label, model: m.model, provider: m.provider }))),
      input.userId,
    ]
  );
  return rows[0].id;
}

export async function finishRun(runId: string, report: ConsensusReport): Promise<void> {
  await pool.query(
    `UPDATE consensus_runs
     SET status = 'done', finished_at = now(), report = $2, confidence = $3,
         input_tokens = $4, output_tokens = $5, cached_tokens = $6, cost_usd = $7
     WHERE id = $1`,
    [
      runId,
      JSON.stringify(report),
      report.confidence.score,
      report.cost.inputTokens,
      report.cost.outputTokens,
      report.cost.cachedTokens,
      report.cost.costUsd,
    ]
  );
}

// Only a run still marked running can fail: a finished run whose bookkeeping
// afterwards hit an error keeps the report it paid for.
export async function failRun(runId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE consensus_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'running'`,
    [runId, error.slice(0, 2000)]
  );
}

export async function findCachedRun(userId: string, cacheKey: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM consensus_runs WHERE user_id = $1 AND cache_key = $2 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, cacheKey]
  );
  return rows[0]?.id ?? null;
}

// Counted from the ledger itself, like the desk's dossier budget: a run that was
// started counts, whether or not it finished.
export async function runsToday(userId: string, db: Db = pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM consensus_runs WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  return rows[0].n;
}

// A run the server was killed during never gets its status written. Anything
// still "running" after this long is marked failed rather than left spinning.
export async function reapStaleRuns(): Promise<void> {
  await pool.query(
    `UPDATE consensus_runs SET status = 'failed', finished_at = now(),
            error = 'the run stopped before it finished (server restarted or timed out)'
     WHERE status = 'running' AND created_at < now() - interval '30 minutes'`
  );
}

/* ------------------------------------------------------------------ calls */

export interface CallRecord {
  runId: string;
  userId: string;
  stage: string;
  agent: string;
  spec: ModelSpec;
  output: unknown;
  rawText: string | null;
  error: string | null;
  usage: Omit<ModelResult, "text"> | null;
}

export async function recordCall(call: CallRecord): Promise<number> {
  return recordModelCall({
    runId: call.runId,
    userId: call.userId,
    purpose: "committee",
    stage: call.stage,
    agent: call.agent,
    modelId: call.spec.id,
    provider: call.spec.provider,
    model: call.spec.model,
    output: call.output,
    rawText: call.rawText,
    error: call.error,
    inputTokens: call.usage?.inputTokens,
    outputTokens: call.usage?.outputTokens,
    cachedTokens: call.usage?.cachedTokens,
    cacheWriteTokens: call.usage?.cacheWriteTokens,
    latencyMs: call.usage?.latencyMs,
    costUsd: call.usage?.costUsd ?? null,
    costEstimated: call.usage?.costEstimated,
  });
}

export interface ClaimRow {
  callId: number | null;
  key: string;
  text: string;
  evidence: string[];
  check: Check;
  judge: "accept" | "weak" | "reject" | null;
}

export async function saveClaims(runId: string, claims: ClaimRow[]): Promise<void> {
  if (claims.length === 0) return;
  await pool.query(
    `INSERT INTO claim_checks (run_id, call_id, claim_key, claim, evidence_ids, verdict, method, reason, judge)
     SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[], $5::jsonb[], $6::text[], $7::text[], $8::text[], $9::text[])`,
    [
      runId,
      claims.map((c) => c.callId),
      claims.map((c) => c.key),
      claims.map((c) => c.text),
      claims.map((c) => JSON.stringify(c.evidence)),
      claims.map((c) => c.check.verdict),
      claims.map((c) => c.check.method),
      claims.map((c) => c.check.reason),
      claims.map((c) => c.judge),
    ]
  );
}

export interface EvaluationRow {
  callId: number | null;
  modelId: string;
  stage: string;
  scores: Record<string, number>;
  overall: number | null;
}

export async function saveEvaluations(runId: string, rows: EvaluationRow[]): Promise<void> {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO model_evaluations (run_id, call_id, model_id, stage, scores, overall)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, row.callId, row.modelId, row.stage, JSON.stringify(row.scores), row.overall]
    );
  }
}

/* ------------------------------------------------------------------ reads */

function toSummary(r: Record<string, unknown>): RunSummary {
  const report = r.report as ConsensusReport | null;
  return {
    id: r.id as string,
    ticker: r.ticker as string,
    name: r.name as string,
    mode: r.mode as Mode,
    focus: (r.focus as string | null) ?? null,
    status: r.status as RunSummary["status"],
    createdAt: (r.created_at as Date).toISOString(),
    confidence: r.confidence === null ? null : Number(r.confidence),
    headline: report?.synthesis?.headline || null,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    error: (r.error as string | null) ?? null,
  };
}

const SELECT_SUMMARY = `
  SELECT r.id, c.ticker, c.name, r.mode, r.focus, r.status, r.created_at, r.confidence,
         r.report, r.cost_usd, r.error
  FROM consensus_runs r JOIN companies c ON c.id = r.company_id`;

export async function listRuns(userId: string, opts: { companyId?: string; limit?: number } = {}): Promise<RunSummary[]> {
  const { rows } = await pool.query(
    `${SELECT_SUMMARY}
     WHERE r.user_id = $1 AND ($2::uuid IS NULL OR r.company_id = $2)
     ORDER BY r.created_at DESC LIMIT $3`,
    [userId, opts.companyId ?? null, opts.limit ?? 20]
  );
  return rows.map(toSummary);
}

export interface StoredCall {
  id: number;
  stage: string;
  agent: string;
  modelId: string;
  provider: string;
  model: string;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  costUsd: number | null;
}

export interface StoredRun {
  summary: RunSummary;
  report: ConsensusReport | null;
  evidence: EvidencePack;
  calls: StoredCall[];
}

// Another person's run is reported as not found, never as forbidden: the id
// alone must not confirm that a run exists.
export async function getRun(userId: string, id: string): Promise<StoredRun | null> {
  if (!isUuid(id)) return null;

  const { rows } = await pool.query(`${SELECT_SUMMARY} WHERE r.id = $1 AND r.user_id = $2`, [id, userId]);
  if (rows.length === 0) return null;
  const { rows: ev } = await pool.query(`SELECT evidence FROM consensus_runs WHERE id = $1`, [id]);

  const { rows: calls } = await pool.query(
    `SELECT id, stage, agent, model_id, provider, model, error, input_tokens, output_tokens, cached_tokens,
            latency_ms, cost_usd
     FROM model_calls WHERE run_id = $1 ORDER BY id`,
    [id]
  );

  return {
    summary: toSummary(rows[0]),
    report: (rows[0].report as ConsensusReport | null) ?? null,
    evidence: ev[0].evidence as EvidencePack,
    calls: calls.map((c) => ({
      id: Number(c.id),
      stage: c.stage,
      agent: c.agent,
      modelId: c.model_id,
      provider: c.provider,
      model: c.model,
      error: c.error,
      inputTokens: c.input_tokens,
      outputTokens: c.output_tokens,
      cachedTokens: c.cached_tokens,
      latencyMs: c.latency_ms,
      costUsd: c.cost_usd === null ? null : Number(c.cost_usd),
    })),
  };
}

export async function getCompanyForRun(userId: string, runId: string): Promise<{ companyId: string; ticker: string } | null> {
  if (!isUuid(runId)) return null;
  const { rows } = await pool.query(
    `SELECT r.company_id, c.ticker FROM consensus_runs r JOIN companies c ON c.id = r.company_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [runId, userId]
  );
  return rows[0] ? { companyId: rows[0].company_id, ticker: rows[0].ticker } : null;
}

/* ------------------------------------------------------------ performance */

export interface ModelPerformance {
  modelId: string;
  stage: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  avgLatencyMs: number;
  costUsd: number | null;
  graded: number;
  overall: number | null;
  criteria: Record<string, number>;
}

// The AI Performance page: every model, every stage, from the ledger and the
// evaluations — so "which model is better at risk analysis" is a query, not a
// feeling.
export async function modelPerformance(): Promise<ModelPerformance[]> {
  const { rows } = await pool.query(
    `WITH calls AS (
       SELECT model_id, stage,
              count(*)::int AS calls,
              count(*) FILTER (WHERE error IS NOT NULL)::int AS failures,
              sum(input_tokens)::bigint AS input_tokens,
              sum(output_tokens)::bigint AS output_tokens,
              sum(cached_tokens)::bigint AS cached_tokens,
              avg(latency_ms)::float AS latency,
              CASE WHEN count(cost_usd) = 0 THEN NULL ELSE sum(cost_usd)::float END AS cost
       FROM model_calls GROUP BY model_id, stage
     ),
     grades AS (
       SELECT model_id, stage, count(*)::int AS graded, avg(overall)::float AS overall
       FROM model_evaluations GROUP BY model_id, stage
     ),
     criteria AS (
       SELECT model_id, stage, jsonb_object_agg(key, avg) AS criteria
       FROM (
         SELECT e.model_id, e.stage, kv.key, avg((kv.value)::text::float) AS avg
         FROM model_evaluations e, jsonb_each(e.scores) kv
         GROUP BY e.model_id, e.stage, kv.key
       ) per_key
       GROUP BY model_id, stage
     )
     SELECT c.*, g.graded, g.overall, k.criteria
     FROM calls c
     LEFT JOIN grades g ON g.model_id = c.model_id AND g.stage = c.stage
     LEFT JOIN criteria k ON k.model_id = c.model_id AND k.stage = c.stage
     ORDER BY c.model_id, c.stage`
  );

  return rows.map((r) => {
    const criteria: Record<string, number> = {};
    for (const [k, v] of Object.entries((r.criteria as Record<string, number | null>) ?? {})) {
      if (k && typeof v === "number") criteria[k] = v;
    }
    return {
      modelId: r.model_id,
      stage: r.stage,
      calls: r.calls,
      failures: r.failures,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedTokens: Number(r.cached_tokens),
      avgLatencyMs: r.latency,
      costUsd: r.cost,
      graded: r.graded ?? 0,
      overall: r.overall,
      criteria,
    };
  });
}

export async function spendToday(userId: string): Promise<{ runs: number; costUsd: number | null; tokens: number }> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT r.id)::int AS runs,
            CASE WHEN count(m.cost_usd) = 0 THEN NULL ELSE sum(m.cost_usd)::float END AS cost,
            COALESCE(sum(m.input_tokens + m.output_tokens + m.cached_tokens), 0)::bigint AS tokens
     FROM consensus_runs r LEFT JOIN model_calls m ON m.run_id = r.id
     WHERE r.user_id = $1 AND r.created_at >= date_trunc('day', now())`,
    [userId]
  );
  return { runs: rows[0].runs, costUsd: rows[0].cost, tokens: Number(rows[0].tokens) };
}
