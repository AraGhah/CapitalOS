import { createHash } from "node:crypto";
import { LOCKS, pool, withLock } from "./db";
import { fetchWithRetry, readJson } from "./http";

// The model client. Same shape as embeddings.ts: the hosted model is used when a
// key is present, and its absence is reported rather than papered over with
// something that only looks like model output.

// The same default as the "claude-opus" entry in models.json, so the desk and
// the committee use one model unless ANTHROPIC_MODEL says otherwise.
export const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5-5";
const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export function hasModel(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export class NoModelError extends Error {
  constructor() {
    super("no ANTHROPIC_API_KEY configured");
    this.name = "NoModelError";
  }
}

/* ------------------------------------------------------------------ rate limit */

// Roughly fifteen requests a minute, enforced here rather than hoped for. Calls
// queue instead of racing, so a pipeline fanning out over many headlines cannot
// trip the account limit. Exported so the consensus engine's Anthropic calls
// queue on the same clock as the desk's, rather than each keeping its own.
const MIN_GAP_MS = 4_000;
let nextSlot = 0;

export async function takeSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
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
  error?: { message?: string };
}

export interface CallOptions {
  system?: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
}

export async function complete(opts: CallOptions): Promise<Reply> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new NoModelError();

  await takeSlot();

  const res = await fetchWithRetry(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 2048,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = await readJson<AnthropicResponse>(res);
  if (!res.ok || !body) {
    throw new Error(`model request failed: ${res.status} ${body?.error?.message ?? res.statusText}`.trim());
  }
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

export async function completeJson<T>(opts: CallOptions): Promise<T> {
  const reply = await complete(opts);
  return extractJson<T>(reply.text);
}

/* ---------------------------------------------------------------- input hash */

// The cache key from the build guide: a digest of the exact inputs, so an
// unchanged company is never re-analysed and never re-billed.
export function inputHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/* --------------------------------------------------------------- day budget */

// A hard ceiling that stops the job rather than overspending quietly. Counted
// from the dossiers table, which is the only thing that writes model output.
const DAILY_DOSSIER_BUDGET = Number(process.env.DAILY_DOSSIER_BUDGET ?? 40);

export async function budgetRemaining(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS spent FROM dossiers WHERE created_at >= date_trunc('day', now())`
  );
  return Math.max(0, DAILY_DOSSIER_BUDGET - rows[0].spent);
}

// A reservation outlives a strategist call comfortably; one older than this
// belongs to a run that crashed before releasing it.
const RESERVATION_MINUTES = 15;

// Claims one slot of the day's dossier budget before the strategist is called,
// counting finished dossiers and slots other runs hold but have not used yet.
// Returns a release function, to be called once the dossier is saved (or the
// run fails); throws BudgetExhaustedError when no slot is left.
export async function reserveDossier(): Promise<() => Promise<void>> {
  try {
    const id = await withLock(LOCKS.dossierBudget, async () => {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM dossiers WHERE created_at >= date_trunc('day', now()))::int
              + (SELECT count(*) FROM budget_reservations
                 WHERE kind = 'dossier' AND created_at > now() - make_interval(mins => $1))::int AS used`,
        [RESERVATION_MINUTES]
      );
      if (rows[0].used >= DAILY_DOSSIER_BUDGET) throw new BudgetExhaustedError();
      const { rows: made } = await pool.query(
        `INSERT INTO budget_reservations (kind) VALUES ('dossier') RETURNING id`
      );
      return made[0].id as string;
    });
    return async () => {
      await pool.query(`DELETE FROM budget_reservations WHERE id = $1`, [id]).catch(() => undefined);
    };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err;
    // No reservations table (hardening migration not run): the plain check.
    if ((await budgetRemaining()) <= 0) throw new BudgetExhaustedError();
    return async () => {};
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super(`daily budget of ${DAILY_DOSSIER_BUDGET} pipeline runs is used up`);
    this.name = "BudgetExhaustedError";
  }
}
