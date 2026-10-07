import { route } from "@/lib/http/route";
import { parseJson } from "@/lib/http/errors";
import { AutopilotRun } from "@/lib/http/schemas";
import { startJob } from "@/lib/jobs/start";

export const dynamic = "force-dynamic";

// One pass of the loop on demand, the same one the scheduler enqueues. It runs
// in the worker; convening committees is off unless the request asks for it.
export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, AutopilotRun);
  return startJob(actor, "autopilot", { convene: body.convene === true }, { dedupeKey: "autopilot" });
});
