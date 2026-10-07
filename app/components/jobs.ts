import { request } from "@/app/components/request";

/* ---------------------------------------------------------------------------
   Long work runs as a job on the server. Starting one answers 202 with its id;
   its progress events arrive over server-sent events, and EventSource
   reconnects on its own, resuming from the last event it saw.
--------------------------------------------------------------------------- */

export interface JobOutcome {
  status: "succeeded" | "failed" | "dead" | "cancelled" | string;
  result?: unknown;
  error?: string | null;
}

export async function startAndFollow(
  url: string,
  init: RequestInit,
  onEvent: (event: Record<string, unknown>) => void,
  onNotice?: (message: string) => void
): Promise<JobOutcome> {
  const res = await request(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.jobId) throw new Error(body.error ?? `the desk refused the request (${res.status})`);
  if (body.warning) onNotice?.(body.warning);
  if (body.alreadyQueued) onNotice?.("Already running — following the run in progress.");
  return followJob(body.jobId as string, onEvent);
}

export function followJob(jobId: string, onEvent: (event: Record<string, unknown>) => void): Promise<JobOutcome> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    let outcome: JobOutcome | null = null;

    source.onmessage = (message) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === "job") {
        outcome = { status: String(event.status), result: event.result, error: (event.error as string) ?? null };
        if (event.willRetry) onEvent({ type: "retrying" });
        return;
      }
      onEvent(event);
    };

    source.addEventListener("end", (message) => {
      source.close();
      if (outcome) return resolve(outcome);
      try {
        const end = JSON.parse((message as MessageEvent).data);
        resolve({ status: end.status, error: end.error });
      } catch {
        resolve({ status: "dead" });
      }
    });

    source.onerror = () => {
      // CONNECTING means EventSource is retrying by itself; CLOSED is final.
      if (source.readyState === EventSource.CLOSED) {
        reject(new Error("lost the connection to the desk"));
      }
    };
  });
}
