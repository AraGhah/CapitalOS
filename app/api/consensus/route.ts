import { route } from "@/lib/http/route";
import { parseJson } from "@/lib/http/errors";
import { ConsensusStart } from "@/lib/http/schemas";
import { listRuns } from "@/lib/ai/store";
import { findCompany } from "@/lib/company";
import { startJob } from "@/lib/jobs/start";

export const dynamic = "force-dynamic";

export const GET = route(async (req, { actor }) => {
  const ticker = req.nextUrl.searchParams.get("ticker");
  const company = ticker ? await findCompany(ticker) : null;
  if (ticker && !company) return Response.json({ runs: [] });
  return Response.json({ runs: await listRuns(actor.userId, { companyId: company?.id, limit: 30 }) });
});

// A committee is a dozen or more model calls over several minutes, so it runs
// as a job in the worker. The answer is the job's id; the page follows its
// events (the plan, each phase, each seat answering) at /api/jobs/<id>/events.
export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, ConsensusStart);
  return startJob(actor, "committee", {
    ticker: body.ticker,
    mode: body.mode,
    focus: body.focus ?? null,
    modelIds: body.modelIds,
    force: body.force === true,
  });
});
