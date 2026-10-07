import type { Actor } from "../actor";
import { HttpError } from "../http/errors";
import { enqueue, getJob, isFinished, liveWorkers, type Job } from "./queue";
import { maxAttemptsFor, type JobKind } from "./handlers";
import { limitUser } from "../ratelimit";

// Enqueues a job for a person and answers 202 with where to follow it.
export async function startJob(
  actor: Pick<Actor, "userId">,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string } = {}
): Promise<Response> {
  await limitUser(actor.userId, "start-job", 20);
  const { job, existing } = await enqueue({
    kind,
    userId: actor.userId,
    payload,
    dedupeKey: opts.dedupeKey ? `${actor.userId}:${opts.dedupeKey}` : null,
    maxAttempts: maxAttemptsFor(kind),
  });
  const workers = await liveWorkers();
  return Response.json(
    {
      jobId: job.id,
      status: job.status,
      alreadyQueued: existing,
      events: `/api/jobs/${job.id}/events`,
      // Said up front, so a page does not wait forever on a queue nobody reads.
      warning: workers === 0 ? "no worker is running; start one with `npm run worker`" : undefined,
    },
    { status: 202 }
  );
}

// For the copilot, which needs the answer to talk about: enqueue, then wait
// for the worker to finish it, up to a limit.
export async function runJobAndWait(
  actor: Pick<Actor, "userId">,
  kind: JobKind,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Job> {
  if ((await liveWorkers()) === 0) {
    throw new HttpError(503, "no worker is running to take this job; start one with `npm run worker`");
  }
  const { job } = await enqueue({ kind, userId: actor.userId, payload, maxAttempts: maxAttemptsFor(kind) });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await getJob(actor.userId, job.id);
    if (!current) throw new Error("the job disappeared");
    if (isFinished(current.status) || Date.now() > deadline) return current;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
