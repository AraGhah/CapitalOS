import type { Actor } from "../actor";
import { enqueue, liveWorkers } from "./queue";
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
