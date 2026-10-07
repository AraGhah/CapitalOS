import { pool, type Db } from "../db";
import { config } from "../config";

/* ---------------------------------------------------------------------------
   Spend, in dollars, per person per day.

   Every model call — committee seats, the copilot, headline tagging, the
   strategist, the market brief — is a row in model_calls with its cost. Before
   a call is made the day's total is checked against DAILY_SPEND_USD_LIMIT.

   The check is made before each call and the cost recorded after it, so calls
   already in flight when the limit is crossed still finish: the overshoot is
   bounded by LLM_CONCURRENCY calls' worth, which is the price of not holding a
   lock across a two-minute model call.
--------------------------------------------------------------------------- */

export class SpendLimitError extends Error {
  readonly status = 429;
  constructor(spent: number, limit: number) {
    super(
      `today's model spend is $${spent.toFixed(2)}, at the daily limit of $${limit.toFixed(2)} (DAILY_SPEND_USD_LIMIT); it resets at midnight UTC`
    );
    this.name = "SpendLimitError";
  }
}

export async function spentToday(userId: string, db: Db = pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(cost_usd), 0)::float AS usd FROM model_calls
     WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  return rows[0].usd;
}

export async function assertWithinSpend(userId: string): Promise<void> {
  const limit = config().DAILY_SPEND_USD_LIMIT;
  const spent = await spentToday(userId);
  if (spent >= limit) throw new SpendLimitError(spent, limit);
}

export interface CallRow {
  userId: string | null;
  runId?: string | null;
  purpose: string;
  stage: string;
  agent: string;
  modelId: string;
  provider: string;
  model: string;
  output?: unknown;
  rawText?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  costUsd?: number | null;
  costEstimated?: boolean;
}

export async function recordModelCall(call: CallRow, db: Db = pool): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO model_calls (run_id, user_id, purpose, stage, agent, model_id, provider, model, output, raw_text, error,
                              input_tokens, output_tokens, cached_tokens, cache_write_tokens, latency_ms, cost_usd, cost_estimated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
    [
      call.runId ?? null,
      call.userId,
      call.purpose,
      call.stage,
      call.agent,
      call.modelId,
      call.provider,
      call.model,
      call.output === null || call.output === undefined ? null : JSON.stringify(call.output),
      call.rawText ?? null,
      call.error ?? null,
      call.inputTokens ?? 0,
      call.outputTokens ?? 0,
      call.cachedTokens ?? 0,
      call.cacheWriteTokens ?? 0,
      call.latencyMs ?? 0,
      call.costUsd ?? null,
      call.costEstimated ?? false,
    ]
  );
  return Number(rows[0].id);
}
