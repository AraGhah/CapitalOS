import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { errorFields, log } from "../log";
import { reportError } from "../observability";
import { listActiveActors } from "../auth/users";
import {
  appendEvent,
  claim,
  claimScheduleSlot,
  enqueue,
  fail,
  heartbeatWorker,
  reapExpired,
  removeWorker,
  renewLease,
  succeed,
  type Job,
} from "./queue";
import { isRetryable, JOB_KINDS, maxAttemptsFor, runHandler, type JobKind } from "./handlers";

/* ---------------------------------------------------------------------------
   The worker: claims jobs, runs them, keeps their leases alive, and on
   SIGTERM stops claiming and lets in-flight jobs finish before it exits (a
   job still running when the drain times out simply loses its lease and is
   picked up again by the next worker).

   It also runs the scheduler: each scheduled task claims its time slot in
   schedule_slots first, so with any number of workers up a slot runs once.
--------------------------------------------------------------------------- */

export interface WorkerOptions {
  id?: string;
  kinds?: JobKind[];
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  schedule?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs one claimed job to its end. Exported so tests can drive the queue
// deterministically without a polling loop.
export async function processJob(job: Job, workerId: string, leaseMs: number): Promise<void> {
  const started = Date.now();
  const jobLog = log.child({ jobId: job.id, kind: job.kind, attempt: job.attempts, userId: job.userId });
  jobLog.info("job started");

  // Events are written in order: each waits for the previous one.
  let chain = Promise.resolve();
  const emit = (event: unknown) => {
    chain = chain.then(() => appendEvent(job.id, event)).catch((err) => jobLog.warn(errorFields(err), "event not stored"));
  };

  let leaseLost = false;
  const renew = setInterval(() => {
    renewLease(job.id, workerId, leaseMs)
      .then((ok) => {
        if (!ok && !leaseLost) {
          leaseLost = true;
          jobLog.warn("lease lost; another worker may now own this job");
        }
      })
      .catch((err) => jobLog.warn(errorFields(err), "lease renewal failed"));
  }, Math.max(1_000, leaseMs / 3));

  try {
    const result = await runHandler(job, emit);
    await chain;
    if (!leaseLost) {
      await succeed(job.id, workerId, result);
      await appendEvent(job.id, { type: "job", status: "succeeded", result });
    }
    jobLog.info({ ms: Date.now() - started }, "job succeeded");
  } catch (err) {
    await chain;
    const retryable = isRetryable(err);
    const message = err instanceof Error ? err.message : String(err);
    if (retryable) reportError(err, { jobId: job.id, kind: job.kind });
    if (!leaseLost) {
      const status = await fail(job.id, workerId, message, { retryable });
      // A 4xx refusal is told as it is; an unexpected error is described generically.
      await appendEvent(job.id, {
        type: "job",
        status,
        error: retryable ? "the job failed on the desk; details are in the server log" : message,
        willRetry: status === "queued",
      });
      jobLog.warn({ ms: Date.now() - started, status, ...errorFields(err) }, "job failed");
    }
  } finally {
    clearInterval(renew);
  }
}

// One scheduler tick: the slots that are due now, each claimed exactly once.
export async function scheduleTick(now = new Date()): Promise<string[]> {
  const c = config();
  const enqueued: string[] = [];
  const minutes = Math.floor(now.getTime() / 60_000);

  const autopilotSlot = Math.floor(minutes / c.AUTOPILOT_CRON_MINUTES);
  for (const actor of await listActiveActors()) {
    if (await claimScheduleSlot(`autopilot:${actor.userId}`, String(autopilotSlot))) {
      await enqueue({
        kind: "autopilot",
        userId: actor.userId,
        payload: { convene: c.AUTOPILOT_CONVENE },
        dedupeKey: `autopilot:${actor.userId}`,
        maxAttempts: maxAttemptsFor("autopilot"),
      });
      enqueued.push(`autopilot:${actor.email}`);
    }
  }

  const hour = now.toISOString().slice(0, 13);
  if (await claimScheduleSlot("maintenance.recheck", hour)) {
    await enqueue({ kind: "maintenance.recheck", userId: null, dedupeKey: "recheck", maxAttempts: maxAttemptsFor("maintenance.recheck") });
    enqueued.push("maintenance.recheck");
  }
  const day = now.toISOString().slice(0, 10);
  // After the US close (22:00 UTC is 17:00 or 18:00 in New York).
  if (now.getUTCHours() >= 22 && (await claimScheduleSlot("ingest.prices", day))) {
    await enqueue({ kind: "ingest.prices", userId: null, dedupeKey: "prices", maxAttempts: maxAttemptsFor("ingest.prices") });
    enqueued.push("ingest.prices");
  }
  // The Bank of Canada publishes around 16:30 Eastern.
  if (now.getUTCHours() >= 21 && (await claimScheduleSlot("ingest.fx", day))) {
    await enqueue({ kind: "ingest.fx", userId: null, dedupeKey: "fx", maxAttempts: maxAttemptsFor("ingest.fx") });
    enqueued.push("ingest.fx");
  }
  if (await claimScheduleSlot("maintenance.retention", day)) {
    await enqueue({ kind: "maintenance.retention", userId: null, dedupeKey: "retention", maxAttempts: maxAttemptsFor("maintenance.retention") });
    enqueued.push("maintenance.retention");
  }
  return enqueued;
}

export async function runWorker(opts: WorkerOptions = {}, signal?: AbortSignal): Promise<void> {
  const id = opts.id ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const kinds = opts.kinds ?? JOB_KINDS;
  const concurrency = opts.concurrency ?? 2;
  const leaseMs = opts.leaseMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const inFlight = new Set<Promise<void>>();

  log.info({ workerId: id, kinds, concurrency }, "worker started");
  await heartbeatWorker(id, kinds, hostname());

  let lastBeat = Date.now();
  let lastReap = 0;
  let lastTick = 0;

  while (!signal?.aborted) {
    try {
      const now = Date.now();
      if (now - lastBeat > 15_000) {
        await heartbeatWorker(id, kinds, hostname());
        lastBeat = now;
      }
      if (now - lastReap > 30_000) {
        const reaped = await reapExpired();
        if (reaped) log.warn({ reaped }, "requeued jobs whose worker stopped responding");
        lastReap = now;
      }
      if (opts.schedule !== false && now - lastTick > 60_000) {
        const due = await scheduleTick(new Date(now));
        if (due.length) log.info({ due }, "scheduled jobs enqueued");
        lastTick = now;
      }

      if (inFlight.size < concurrency) {
        const job = await claim(id, kinds, leaseMs);
        if (job) {
          const p = processJob(job, id, leaseMs).finally(() => inFlight.delete(p));
          inFlight.add(p);
          continue;
        }
      }
    } catch (err) {
      log.error(errorFields(err), "worker loop error");
    }
    await sleep(pollMs);
  }

  log.info({ inFlight: inFlight.size }, "worker draining");
  const drain = Promise.all(inFlight);
  await Promise.race([drain, sleep(5 * 60_000)]);
  await removeWorker(id).catch(() => undefined);
  log.info("worker stopped");
}
