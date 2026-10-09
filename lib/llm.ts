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
function apiUrl(): string {
  return `${config().ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1/messages`;
}
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
  // the model identifier the API reports having used, which can differ from
  // the one requested (an alias resolves to a dated snapshot)
  model: string | null;
}

interface AnthropicResponse {
  model?: string;
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

type Usage = NonNullable<AnthropicResponse["usage"]>;

interface Prepared {
  apiKey: string;
  maxTokens: number;
  body: Record<string, unknown>;
  spec: ModelSpec;
  meta: {
    userId: string;
    purpose: string;
    stage: string;
    agent: string;
    modelId: string;
    provider: string;
    model: string;
  };
}

async function prepare(opts: CallOptions): Promise<Prepared> {
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
  return {
    apiKey,
    maxTokens,
    body: { model: modelName(), max_tokens: maxTokens, system, messages: opts.messages, tools },
    spec,
    meta: {
      userId: opts.meter.userId,
      purpose: opts.meter.purpose,
      stage: opts.meter.stage,
      agent: opts.meter.purpose,
      modelId: spec.id,
      provider: "anthropic",
      model: modelName(),
    },
  };
}

function post(p: Prepared, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetchWithRetry(apiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": VERSION,
    },
    body: JSON.stringify({ ...p.body, ...extra }),
    signal: AbortSignal.timeout(120_000),
  });
}

// Meters a finished call and turns the message into a Reply.
async function settle(
  p: Prepared,
  started: number,
  message: { model: string | null; content: AnthropicResponse["content"]; stopReason: string | null; usage: Usage }
): Promise<Reply> {
  const usage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cachedTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  const cost = costOf(p.spec, usage);
  await recordModelCall({
    ...p.meta,
    ...usage,
    latencyMs: Date.now() - started,
    costUsd: cost.usd,
    costEstimated: cost.estimated,
    error: message.stopReason === "max_tokens" ? `reply truncated at ${p.maxTokens} tokens` : null,
  });
  if (!Array.isArray(message.content)) throw new Error("model request returned no content");

  return {
    text: message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
    toolUses: message.content.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        block.type === "tool_use"
    ),
    stopReason: message.stopReason,
    raw: message.content,
    model: message.model,
  };
}

export async function complete(opts: CallOptions): Promise<Reply> {
  const p = await prepare(opts);
  const started = Date.now();

  let res: Response;
  try {
    // Every process shares one per-minute allowance for the provider, and this
    // process runs at most LLM_CONCURRENCY calls at once.
    res = await gated("anthropic", () => post(p));
  } catch (err) {
    await recordModelCall({ ...p.meta, error: (err as Error).message, latencyMs: Date.now() - started });
    throw err;
  }

  const body = await readJson<AnthropicResponse>(res);
  if (!res.ok || !body) {
    const message = `model request failed: ${res.status} ${body?.error?.message ?? res.statusText}`.trim();
    await recordModelCall({ ...p.meta, error: message, latencyMs: Date.now() - started });
    throw new Error(message);
  }

  return settle(p, started, {
    model: body.model ?? null,
    content: body.content,
    stopReason: body.stop_reason,
    usage: body.usage ?? {},
  });
}

// The same call, streamed: text reaches onText as the model writes it. The
// Reply is the one complete() would have returned, so the copilot's tool loop
// does not care which it used. The stream is read inside the concurrency gate,
// so a long answer holds its slot until it has finished.
export async function completeStreaming(opts: CallOptions, onText: (delta: string) => void): Promise<Reply> {
  const p = await prepare(opts);
  const started = Date.now();

  let message: StreamedMessage;
  try {
    message = await gated("anthropic", async () => {
      const res = await post(p, { stream: true });
      if (!res.ok || !res.body) {
        const body = await readJson<AnthropicResponse>(res);
        throw new Error(`model request failed: ${res.status} ${body?.error?.message ?? res.statusText}`.trim());
      }
      return readMessageStream(res.body, onText);
    });
  } catch (err) {
    await recordModelCall({ ...p.meta, error: (err as Error).message, latencyMs: Date.now() - started });
    throw err;
  }

  return settle(p, started, message);
}

/* ------------------------------------------------------------------ stream */

export interface StreamedMessage {
  model: string | null;
  content: AnthropicResponse["content"];
  stopReason: string | null;
  usage: Usage;
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { model?: string; usage?: Usage };
  content_block?: Record<string, unknown>;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: Usage;
  error?: { message?: string };
}

// Reads the Messages API's server-sent events back into the message a
// non-streaming call returns: text blocks joined from their deltas, tool
// inputs parsed from their JSON fragments, usage from the start and end
// events. A listener that throws does not stop the read.
export async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  onText: (delta: string) => void = () => undefined
): Promise<StreamedMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks: Array<Record<string, unknown>> = [];
  const json: string[] = [];
  const out: StreamedMessage = { model: null, content: [], stopReason: null, usage: {} };
  let started = false;
  let stopped = false;
  let buffer = "";

  const handle = (event: StreamEvent) => {
    const i = event.index ?? -1;
    switch (event.type) {
      case "message_start":
        started = true;
        out.model = event.message?.model ?? null;
        out.usage = { ...event.message?.usage };
        break;
      case "content_block_start": {
        const block = { ...event.content_block };
        if (block.type === "tool_use") json[i] = "";
        if (block.type === "text" && typeof block.text !== "string") block.text = "";
        blocks[i] = block;
        break;
      }
      case "content_block_delta": {
        const block = blocks[i];
        if (!block || !event.delta) break;
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          block.text = `${block.text ?? ""}${event.delta.text}`;
          try {
            onText(event.delta.text);
          } catch {
            // the listener's problem, not the reply's
          }
        } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
          json[i] = (json[i] ?? "") + event.delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[i];
        if (block?.type === "tool_use") {
          const text = json[i]?.trim();
          try {
            block.input = text ? JSON.parse(text) : {};
          } catch {
            block.input = {};
          }
        }
        break;
      }
      case "message_delta":
        if (event.delta && "stop_reason" in event.delta) out.stopReason = event.delta.stop_reason ?? null;
        if (event.usage) out.usage = { ...out.usage, ...event.usage };
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error":
        throw new Error(`model stream failed: ${event.error?.message ?? "unknown error"}`);
    }
  };

  // Events are separated by a blank line; only their data lines matter.
  const drain = (final: boolean) => {
    buffer = buffer.replace(/\r\n?/g, "\n");
    for (;;) {
      const at = buffer.indexOf("\n\n");
      if (at === -1 && !(final && buffer.trim())) return;
      const raw = at === -1 ? buffer : buffer.slice(0, at);
      buffer = at === -1 ? "" : buffer.slice(at + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        continue;
      }
      handle(event);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (!started) throw new Error("model stream ended before the message began");
  if (!stopped && out.stopReason === null) throw new Error("model stream ended before the message finished");
  out.content = blocks.filter(Boolean) as AnthropicResponse["content"];
  return out;
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
