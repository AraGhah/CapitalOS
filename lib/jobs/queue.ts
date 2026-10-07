import { pool, withTransaction, type Db } from "../db";

/* ---------------------------------------------------------------------------
   A Postgres-backed job queue.

   enqueue  → a row in `jobs`, deduplicated while one with the same key is pending
   claim    → FOR UPDATE SKIP LOCKED: many workers, each job to exactly one
   lease    → a worker renews locked_until while it works; a lapsed lease means
              the worker died, and reapExpired puts the job back
   finish   → succeeded, or failed with a retry after exponential backoff, or
              dead (the dead-letter state) once its attempts are spent

   Delivery is at-least-once, so every handler is written to be safe to run
   again: committee and pipeline runs are keyed on their evidence and served
   from cache on a retry, alerts are deduplicated, and so on.
--------------------------------------------------------------------------- */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead";

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: string;
  userId: string | null;
  payload: P;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toJob(r: Record<string, unknown>): Job {
  const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
  return {
    id: r.id as string,
    kind: r.kind as string,
    userId: (r.user_id as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as JobStatus,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    runAt: iso(r.run_at) as string,
    result: r.result ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export interface EnqueueInput {
  kind: string;
  userId: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  maxAttempts?: number;
  priority?: number;
  runAt?: Date;
}

// Returns the new job, or the pending one that already has this dedupe key.
export async function enqueue(input: EnqueueInput, db: Db = pool): Promise<{ job: Job; existing: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO jobs (kind, user_id, payload, dedupe_key, max_attempts, priority, run_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
     DO NOTHING
     RETURNING *`,
    [
      input.kind,
      input.userId,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
      input.maxAttempts ?? 3,
      input.priority ?? 0,
      input.runAt ?? null,
    ]
  );
  if (rows[0]) return { job: toJob(rows[0]), existing: false };

  const { rows: pending } = await db.query(
    `SELECT * FROM jobs WHERE kind = $1 AND dedupe_key = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [input.kind, input.dedupeKey]
  );
  if (!pending[0]) {
    // It finished between the insert and the lookup; enqueue a fresh one.
    return enqueue(input, db);
  }
  return { job: toJob(pending[0]), existing: true };
}

export async function claim(workerId: string, kinds: string[], leaseMs: number): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $3),
                     attempts = attempts + 1, started_at = COALESCE(started_at, now())
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now() AND kind = ANY($2)
       ORDER BY priority DESC, run_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, kinds, leaseMs / 1000]
  );
  return rows[0] ? toJob(rows[0]) : null;
}

// False when the lease was lost (reaped after a stall); the worker must stop
// writing results for a job another worker may now own.
export async function renewLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET locked_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, leaseMs / 1000]
  );
  return (rowCount ?? 0) > 0;
}

export async function succeed(jobId: string, workerId: string, result: unknown): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'succeeded', result = $3, error = NULL, finished_at = now(),
                     locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2`,
    [jobId, workerId, JSON.stringify(result ?? null)]
  );
}

// Seconds before attempt n+1: 30, 120, 480… capped at an hour, with jitter so
// a burst of failures does not retry in lockstep.
export function backoffSeconds(attempts: number, random = Math.random): number {
  const base = Math.min(3600, 30 * 4 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

// A retryable failure with attempts left goes back to the queue after a
// backoff; anything else is final. A failure the handler marks as not
// retryable (bad input, a budget refusal) is "failed"; a job that ran out of
// attempts is "dead", the dead-letter state an operator should look at.
export async function fail(
  jobId: string,
  workerId: string,
  error: string,
  opts: { retryable: boolean }
): Promise<JobStatus> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT attempts, max_attempts FROM jobs WHERE id = $1 AND locked_by = $2 FOR UPDATE`,
      [jobId, workerId]
    );
    if (!rows[0]) return "dead"; // the lease was lost; whoever owns it now decides
    const { attempts, max_attempts: max } = rows[0] as { attempts: number; max_attempts: number };
    const retry = opts.retryable && attempts < max;
    const status: JobStatus = retry ? "queued" : opts.retryable ? "dead" : "failed";
    await client.query(
      `UPDATE jobs SET status = $2,
              run_at = CASE WHEN $3 THEN now() + make_interval(secs => $4) ELSE run_at END,
              finished_at = CASE WHEN $3 THEN NULL ELSE now() END,
              error = $5, locked_by = NULL, locked_until = NULL
       WHERE id = $1`,
      [jobId, status, retry, backoffSeconds(attempts), error.slice(0, 4000)]
    );
    return status;
  });
}

// Jobs whose worker stopped renewing its lease. Back to the queue if they have
// attempts left, otherwise dead — never left "running".
export async function reapExpired(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'dead' END,
       finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
       error = COALESCE(error, 'the worker running this job stopped responding'),
       locked_by = NULL, locked_until = NULL
     WHERE status = 'running' AND locked_until < now()`
  );
  return rowCount ?? 0;
}

export async function cancel(userId: string, jobId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND user_id = $2 AND status = 'queued'`,
    [jobId, userId]
  );
  return (rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------- reading */

export async function getJob(userId: string, jobId: string): Promise<Job | null> {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1 AND user_id = $2`, [jobId, userId]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function getJobById(jobId: string): Promise<Job | null> {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function appendEvent(jobId: string, event: unknown): Promise<void> {
  await pool.query(`INSERT INTO job_events (job_id, event) VALUES ($1, $2)`, [jobId, JSON.stringify(event)]);
}

export async function eventsAfter(jobId: string, afterId: number, limit = 200): Promise<Array<{ id: number; event: unknown }>> {
  const { rows } = await pool.query(
    `SELECT id, event FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [jobId, afterId, limit]
  );
  return rows.map((r) => ({ id: Number(r.id), event: r.event }));
}

export async function listJobs(userId: string, limit = 20): Promise<Job[]> {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [
    userId,
    limit,
  ]);
  return rows.map(toJob);
}

export function isFinished(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "dead";
}

/* --------------------------------------------------------------- workers */

export async function heartbeatWorker(id: string, kinds: string[], host: string): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, kinds, host) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET seen_at = now(), kinds = EXCLUDED.kinds`,
    [id, kinds, host]
  );
}

export async function liveWorkers(withinSeconds = 60): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM workers WHERE seen_at > now() - make_interval(secs => $1)`,
    [withinSeconds]
  );
  return rows[0].n;
}

export async function removeWorker(id: string): Promise<void> {
  await pool.query(`DELETE FROM workers WHERE id = $1`, [id]);
}

// The first caller for (name, slot) gets true; everyone after gets false.
export async function claimScheduleSlot(name: string, slot: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO schedule_slots (name, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [name, slot]
  );
  return (rowCount ?? 0) > 0;
}
