import { createHash } from "node:crypto";
import { LOCKS, pool, withLock } from "./db";
import { config } from "./config";
import { fetchWithRetry, readJson } from "./http";
import { gated } from "./ai/gate";
import { assertWithinSpend, recordModelCall } from "./ai/metering";
import { costOf, specForModel, type ModelSpec } from "./ai/models";

// The model client. Same shape as embeddings.ts: the hosted model is used when a
// key is present, and its absence is reported rather than papered over with
// something that only looks like model output.

// The same default as the "claude-opus" entry in models.json, so the desk and
// the committee use one model unless ANTHROPIC_MODEL says otherwise.
export function modelName(): string {
  return config().ANTHROPIC_MODEL;
}
const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export function hasModel(): boolean {
  return Boolean(config().ANTHROPIC_API_KEY);
}

export class NoModelError extends Error {
  constructor() {
    super("no ANTHROPIC_API_KEY configured");
    this.name = "NoModelError";
  }
}

/* ----------------------------------------------------------------------- types */

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type Message =
  | { role: "user"; content: string | unknown[] }
  | { role: "assistant"; content: string | unknown[] };

export interface Reply {
  text: string;
  toolUses: ToolUse[];
  stopReason: string | null;
  raw: unknown[];
}

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

// Who a call is for and why: every call is metered against a person's daily
// spend and written to model_calls.
export interface Meter {
  userId: string;
  purpose: string;
  stage: string;
}

export interface CallOptions {
  system?: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  meter: Meter;
}

export class TruncatedReplyError extends Error {
  constructor(maxTokens: number) {
    super(`the model's reply hit its ${maxTokens}-token limit and was cut off`);
    this.name = "TruncatedReplyError";
  }
}

// The pricing spec for the desk's own model, or a stand-in that makes costOf
// charge the fallback rate (never zero).
function deskSpec(): ModelSpec {
  return (
    specForModel("anthropic", modelName()) ?? {
      id: modelName(),
      provider: "anthropic",
      providerConfig: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
      model: modelName(),
      label: modelName(),
      tier: "frontier",
      priceIn: null,
      priceOut: null,
      priceCacheRead: null,
      priceCacheWrite: null,
    }
  );
}

export async function complete(opts: CallOptions): Promise<Reply> {
  const apiKey = config().ANTHROPIC_API_KEY;
  if (!apiKey) throw new NoModelError();
  await assertWithinSpend(opts.meter.userId);

  const maxTokens = opts.maxTokens ?? 2048;
  // The system prompt and the tool list are identical on every turn of the
  // copilot's loop, so they are marked cacheable: after the first call they
  // are billed at the cache-read rate.
  const system = opts.system ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] : undefined;
  const tools = opts.tools?.map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));

  const spec = deskSpec();
  const meta = {
    userId: opts.meter.userId,
    purpose: opts.meter.purpose,
    stage: opts.meter.stage,
    agent: opts.meter.purpose,
    modelId: spec.id,
    provider: "anthropic",
    model: modelName(),
  };
  const started = Date.now();

  let res: Response;
  try {
    // Every process shares one per-minute allowance for the provider, and this
    // process runs at most LLM_CONCURRENCY calls at once.
    res = await gated("anthropic", () =>
      fetchWithRetry(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": VERSION,
        },
        body: JSON.stringify({ model: modelName(), max_tokens: maxTokens, system, messages: opts.messages, tools }),
        signal: AbortSignal.timeout(120_000),
      })
    );
  } catch (err) {
    await recordModelCall({ ...meta, error: (err as Error).message, latencyMs: Date.now() - started });
    throw err;
  }

  const body = await readJson<AnthropicResponse>(res);
  if (!res.ok || !body) {
    const message = `model request failed: ${res.status} ${body?.error?.message ?? res.statusText}`.trim();
    await recordModelCall({ ...meta, error: message, latencyMs: Date.now() - started });
    throw new Error(message);
  }

  const usage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    cachedTokens: body.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
  };
  const cost = costOf(spec, usage);
  await recordModelCall({
    ...meta,
    ...usage,
    latencyMs: Date.now() - started,
    costUsd: cost.usd,
    costEstimated: cost.estimated,
    error: body.stop_reason === "max_tokens" ? `reply truncated at ${maxTokens} tokens` : null,
  });
  if (!Array.isArray(body.content)) throw new Error("model request returned no content");

  return {
    text: body.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
    toolUses: body.content.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        block.type === "tool_use"
    ),
    stopReason: body.stop_reason,
    raw: body.content,
  };
}

/* ----------------------------------------------------------------------- JSON */

// Models wrap JSON in prose or a fence often enough that it is worth digging the
// object out rather than failing the whole run over a stray backtick.
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
    if (start === -1 || end <= start) {
      throw new Error(`model did not return JSON: ${candidate.slice(0, 160)}`);
    }
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  }
}

// A reply cut off by its token limit is half a JSON document; it is refused
// here rather than handed to the brace-slicing fallback in extractJson, which
// could otherwise "recover" a prefix of it.
export async function completeJson<T>(opts: CallOptions): Promise<T> {
  const reply = await complete(opts);
  if (reply.stopReason === "max_tokens") throw new TruncatedReplyError(opts.maxTokens ?? 2048);
  return extractJson<T>(reply.text);
}

/* ---------------------------------------------------------------- input hash */

// The cache key from the build guide: a digest of the exact inputs, so an
// unchanged company is never re-analysed and never re-billed.
export function inputHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/* --------------------------------------------------------------- day budget */

// A hard ceiling per person that stops the job rather than overspending
// quietly. Counted from the dossiers each person asked for.
export async function budgetRemaining(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS spent FROM dossiers
     WHERE requested_by = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  return Math.max(0, config().DAILY_DOSSIER_BUDGET - rows[0].spent);
}

// A reservation outlives a strategist call comfortably; one older than this
// belongs to a run that crashed before releasing it.
const RESERVATION_MINUTES = 15;

// Claims one slot of the day's dossier budget before the strategist is called,
// counting finished dossiers and slots other runs hold but have not used yet.
// Returns a release function, to be called once the dossier is saved (or the
// run fails); throws BudgetExhaustedError when no slot is left.
export async function reserveDossier(userId: string): Promise<() => Promise<void>> {
  const limit = config().DAILY_DOSSIER_BUDGET;
  const id = await withLock(LOCKS.dossierBudget(userId), async (client) => {
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM dossiers
                WHERE requested_by = $1 AND created_at >= date_trunc('day', now()))::int
            + (SELECT count(*) FROM budget_reservations
               WHERE user_id = $1 AND kind = 'dossier' AND created_at > now() - make_interval(mins => $2))::int AS used`,
      [userId, RESERVATION_MINUTES]
    );
    if (rows[0].used >= limit) throw new BudgetExhaustedError();
    const { rows: made } = await client.query(
      `INSERT INTO budget_reservations (user_id, kind) VALUES ($1, 'dossier') RETURNING id`,
      [userId]
    );
    return made[0].id as string;
  });
  return async () => {
    await pool.query(`DELETE FROM budget_reservations WHERE id = $1`, [id]).catch(() => undefined);
  };
}

export class BudgetExhaustedError extends Error {
  readonly status = 429;
  constructor() {
    super(`the daily budget of ${config().DAILY_DOSSIER_BUDGET} pipeline runs is used up (DAILY_DOSSIER_BUDGET)`);
    this.name = "BudgetExhaustedError";
  }
}
