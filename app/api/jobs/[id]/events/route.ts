import { route } from "@/lib/http/route";
import { notFound } from "@/lib/http/errors";
import { isUuid } from "@/lib/ids";
import { eventsAfter, getJob, isFinished } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const POLL_MS = 500;
const KEEPALIVE_MS = 15_000;

/* ---------------------------------------------------------------------------
   A job's progress as server-sent events. Each stored event is sent with its
   id, so a browser that reconnects (EventSource does on its own) resumes
   from Last-Event-ID instead of replaying or missing anything. The stream
   ends once the job is finished and every event has been sent.
--------------------------------------------------------------------------- */
export const GET = route<{ id: string }>(async (req, { actor, params }) => {
  const job = isUuid(params.id) ? await getJob(actor.userId, params.id) : null;
  if (!job) throw notFound("no such job");

  const resumeFrom = Number(req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let after = Number.isFinite(resumeFrom) ? resumeFrom : 0;
      let lastWrite = Date.now();
      const write = (text: string) => {
        controller.enqueue(encoder.encode(text));
        lastWrite = Date.now();
      };

      try {
        write(`retry: 3000\n\n`);
        while (!req.signal.aborted) {
          const events = await eventsAfter(job.id, after);
          for (const e of events) {
            write(`id: ${e.id}\ndata: ${JSON.stringify(e.event)}\n\n`);
            after = e.id;
          }
          if (events.length === 0) {
            const current = await getJob(actor.userId, job.id);
            if (!current || isFinished(current.status)) {
              // The terminal event is stored by the worker; send the state too,
              // in case the job ended without one (cancelled, reaped as dead).
              write(`event: end\ndata: ${JSON.stringify({ status: current?.status ?? "dead", error: current?.error ?? null })}\n\n`);
              break;
            }
            if (Date.now() - lastWrite > KEEPALIVE_MS) write(`: keep-alive\n\n`);
            await new Promise((r) => setTimeout(r, POLL_MS));
          }
        }
      } catch {
        // client went away mid-write
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
