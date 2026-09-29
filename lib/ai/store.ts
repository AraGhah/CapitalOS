import { pool } from "../db";
import type { EvidencePack } from "./evidence";
import type { ModelSpec } from "./models";
import type { ModelResult } from "./providers";
import type { Mode } from "./modes";
import type { ConsensusReport, RunSummary } from "./report";
import type { Check } from "./factcheck";

/* ------------------------------------------------------------------- runs */

export async function createRun(input: {
  companyId: string;
  mode: Mode;
  focus: string | null;
  evidence: EvidencePack;
  cacheKey: string;
  models: ModelSpec[];
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO consensus_runs (company_id, mode, focus, evidence_hash, cache_key, evidence, models)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.companyId,
      input.mode,
      input.focus,
      input.evidence.hash,
      input.cacheKey,
      JSON.stringify(input.evidence),
      JSON.stringify(input.models.map((m) => ({ id: m.id, label: m.label, model: m.model, provider: m.provider }))),
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

export async function failRun(runId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE consensus_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
    [runId, error.slice(0, 2000)]
  );
}

export async function findCachedRun(cacheKey: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM consensus_runs WHERE cache_key = $1 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [cacheKey]
  );
  return rows[0]?.id ?? null;
}

// Counted from the ledger itself, like the desk's dossier budget: a run that was
// started counts, whether or not it finished.
export async function runsToday(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM consensus_runs WHERE created_at >= date_trunc('day', now())`
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
  stage: string;
  agent: string;
  spec: ModelSpec;
  output: unknown;
  rawText: string | null;
  error: string | null;
  usage: Omit<ModelResult, "text"> | null;
}

export async function recordCall(call: CallRecord): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO model_calls (run_id, stage, agent, model_id, provider, model, output, raw_text, error,
                              input_tokens, output_tokens, cached_tokens, latency_ms, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      call.runId,
      call.stage,
      call.agent,
      call.spec.id,
      call.spec.provider,
      call.spec.model,
      call.output === null || call.output === undefined ? null : JSON.stringify(call.output),
      call.rawText,
      call.error,
      call.usage?.inputTokens ?? 0,
      call.usage?.outputTokens ?? 0,
      call.usage?.cachedTokens ?? 0,
      call.usage?.latencyMs ?? 0,
      call.usage?.costUsd ?? null,
    ]
  );
  return Number(rows[0].id);
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

export async function listRuns(opts: { companyId?: string; limit?: number } = {}): Promise<RunSummary[]> {
  try {
    const { rows } = await pool.query(
      `${SELECT_SUMMARY}
       WHERE ($1::uuid IS NULL OR r.company_id = $1)
       ORDER BY r.created_at DESC LIMIT $2`,
      [opts.companyId ?? null, opts.limit ?? 20]
    );
    return rows.map(toSummary);
  } catch {
    // not migrated yet — the pages say so rather than failing
    return [];
  }
}

export interface StoredCall {
  id: number;
  stage: string;
  agent: string;
  modelId: string;
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

export async function getRun(id: string): Promise<StoredRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const { rows } = await pool.query(`${SELECT_SUMMARY} WHERE r.id = $1`, [id]);
  if (rows.length === 0) return null;
  const { rows: ev } = await pool.query(`SELECT evidence FROM consensus_runs WHERE id = $1`, [id]);

  const { rows: calls } = await pool.query(
    `SELECT id, stage, agent, model_id, model, error, input_tokens, output_tokens, cached_tokens,
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

export async function getCompanyForRun(runId: string): Promise<{ companyId: string; ticker: string } | null> {
  const { rows } = await pool.query(
    `SELECT r.company_id, c.ticker FROM consensus_runs r JOIN companies c ON c.id = r.company_id WHERE r.id = $1`,
    [runId]
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
  try {
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
  } catch {
    return [];
  }
}

export async function spendToday(): Promise<{ runs: number; costUsd: number | null; tokens: number }> {
  try {
    const { rows } = await pool.query(
      `SELECT count(DISTINCT r.id)::int AS runs,
              CASE WHEN count(m.cost_usd) = 0 THEN NULL ELSE sum(m.cost_usd)::float END AS cost,
              COALESCE(sum(m.input_tokens + m.output_tokens + m.cached_tokens), 0)::bigint AS tokens
       FROM consensus_runs r LEFT JOIN model_calls m ON m.run_id = r.id
       WHERE r.created_at >= date_trunc('day', now())`
    );
    return { runs: rows[0].runs, costUsd: rows[0].cost, tokens: Number(rows[0].tokens) };
  } catch {
    return { runs: 0, costUsd: null, tokens: 0 };
  }
}
