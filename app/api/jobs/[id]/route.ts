import { route } from "@/lib/http/route";
import { notFound } from "@/lib/http/errors";
import { isUuid } from "@/lib/ids";
import { cancel, getJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { actor, params }) => {
  const job = isUuid(params.id) ? await getJob(actor.userId, params.id) : null;
  if (!job) throw notFound("no such job");
  return Response.json(job);
});

// Only a job that has not started can be cancelled; a running committee is
// already paying for its calls.
export const DELETE = route<{ id: string }>(async (_req, { actor, params }) => {
  if (!isUuid(params.id) || !(await cancel(actor.userId, params.id))) {
    throw notFound("no queued job with that id");
  }
  return Response.json({ ok: true });
});
