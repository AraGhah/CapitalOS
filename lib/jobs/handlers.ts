import { z } from "zod";
import type { Actor } from "../actor";
import { ensureAccount } from "../auth/sessions";
import { runConsensus } from "../ai/committee";
import { runDeskPipeline } from "../pipeline";
import { runCycle } from "../autopilot/cycle";
import { checkOpenTheses } from "../theses";
import { checkMemory } from "../ai/memory";
import { runRetention } from "../retention";
import { ensureBenchmark, refreshPrices, trackedForPrices } from "../market/ingest";
import { refreshFx } from "../fx";
import { pool } from "../db";
import type { Job } from "./queue";

/* ---------------------------------------------------------------------------
   What each kind of job does. A handler gets the job, the person it runs for
   and an emit function whose events the page follows live; what it returns is
   stored as the job's result.

   A thrown error with a 4xx status (a spent budget, an unknown ticker, a
   refused order) is final — retrying cannot change the answer. Anything else
   is retried with backoff until the job's attempts are spent.
--------------------------------------------------------------------------- */

export interface JobContext {
  job: Job;
  actor: Pick<Actor, "userId" | "accountId"> | null;
  emit: (event: unknown) => void;
}

interface HandlerSpec<P> {
  payload: z.ZodType<P>;
  // How many times the queue may run it. Paid, non-idempotent work runs once:
  // a person can re-run a committee; the queue should not do it for them.
  maxAttempts: number;
  run: (ctx: JobContext, payload: P) => Promise<unknown>;
}

function needsActor(ctx: JobContext): Pick<Actor, "userId" | "accountId"> {
  if (!ctx.actor) throw Object.assign(new Error("this job needs a user"), { status: 400 });
  return ctx.actor;
}

const committee: HandlerSpec<{
  ticker: string;
  mode: "auto" | "fast" | "standard" | "deep" | "committee";
  focus?: string | null;
  modelIds?: string[];
  force?: boolean;
}> = {
  payload: z.object({
    ticker: z.string(),
    mode: z.enum(["auto", "fast", "standard", "deep", "committee"]),
    focus: z.string().nullable().optional(),
    modelIds: z.array(z.string()).optional(),
    force: z.boolean().optional(),
  }),
  maxAttempts: 1,
  run: async (ctx, p) =>
    runConsensus(
      { actor: needsActor(ctx), ticker: p.ticker, mode: p.mode, focus: p.focus ?? null, modelIds: p.modelIds, force: p.force },
      ctx.emit
    ),
};

const research: HandlerSpec<{ ticker: string; force?: boolean; watch?: boolean }> = {
  payload: z.object({ ticker: z.string(), force: z.boolean().optional(), watch: z.boolean().optional() }),
  // A retry after a feed outage hits the dossier cache if the first attempt
  // got as far as saving one.
  maxAttempts: 2,
  run: async (ctx, p) => {
    const out = await runDeskPipeline(needsActor(ctx), p.ticker, { force: p.force, watch: p.watch, onEvent: ctx.emit });
    return { ticker: out.ticker, cached: out.cached, dossierId: out.dossier.id };
  },
};

const autopilot: HandlerSpec<{ convene?: boolean }> = {
  payload: z.object({ convene: z.boolean().optional() }),
  maxAttempts: 1,
  run: async (ctx, p) => runCycle(needsActor(ctx), { convene: p.convene === true }),
};

// Nightly and hourly upkeep across everyone's data.
const recheck: HandlerSpec<Record<string, never>> = {
  payload: z.object({}).strict(),
  maxAttempts: 3,
  run: async () => {
    const theses = await checkOpenTheses(null);
    const memory = await checkMemory(null);
    return { theses: theses.checked, invalidated: theses.invalidated.length, memorySettled: memory.settled.length };
  },
};

const retention: HandlerSpec<Record<string, never>> = {
  payload: z.object({}).strict(),
  maxAttempts: 3,
  run: async () => runRetention(),
};

// Every evening: bars, splits and dividends for everything anyone tracks.
const prices: HandlerSpec<Record<string, never>> = {
  payload: z.object({}).strict(),
  maxAttempts: 3,
  run: async (ctx) => {
    await ensureBenchmark();
    const results = [];
    const errors: string[] = [];
    for (const t of await trackedForPrices()) {
      try {
        results.push(await refreshPrices(t.id, t.ticker));
      } catch (err) {
        errors.push(`${t.ticker}: ${(err as Error).message}`);
      }
      ctx.emit({ type: "progress", ticker: t.ticker });
    }
    return { refreshed: results.length, errors };
  },
};

// Every currency any account, listing, trade or cash movement uses, from the
// earliest date any of them needs.
const fx: HandlerSpec<Record<string, never>> = {
  payload: z.object({}).strict(),
  maxAttempts: 3,
  run: async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT ccy FROM (
         SELECT base_currency AS ccy FROM accounts
         UNION SELECT currency FROM companies
         UNION SELECT currency FROM transactions
         UNION SELECT currency FROM cash_movements
       ) c WHERE ccy <> 'CAD'`
    );
    const { rows: first } = await pool.query(
      `SELECT least((SELECT min(executed_at) FROM transactions), (SELECT min(occurred_at) FROM cash_movements))::date AS d`
    );
    const since = first[0].d ? (first[0].d as Date).toISOString().slice(0, 10) : new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const currencies = rows.map((r) => r.ccy as string);
    await refreshFx(currencies, since);
    return { currencies, since };
  },
};

export const HANDLERS = {
  committee,
  research,
  autopilot,
  "maintenance.recheck": recheck,
  "maintenance.retention": retention,
  "ingest.prices": prices,
  "ingest.fx": fx,
} as const;

export type JobKind = keyof typeof HANDLERS;
export const JOB_KINDS = Object.keys(HANDLERS) as JobKind[];

export function maxAttemptsFor(kind: JobKind): number {
  return HANDLERS[kind].maxAttempts;
}

export async function runHandler(job: Job, emit: (event: unknown) => void): Promise<unknown> {
  const spec = HANDLERS[job.kind as JobKind] as HandlerSpec<unknown> | undefined;
  if (!spec) throw Object.assign(new Error(`no handler for job kind "${job.kind}"`), { status: 400 });
  const parsed = spec.payload.safeParse(job.payload);
  if (!parsed.success) throw Object.assign(new Error(`bad payload: ${parsed.error.message}`), { status: 400 });

  let actor: JobContext["actor"] = null;
  if (job.userId) {
    const account = await ensureAccount(job.userId);
    actor = { userId: job.userId, accountId: account.id };
  }
  return spec.run({ job, actor, emit }, parsed.data);
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return !(typeof status === "number" && status >= 400 && status < 500);
}
