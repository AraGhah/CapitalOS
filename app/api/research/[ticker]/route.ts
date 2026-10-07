import { route } from "@/lib/http/route";
import { notFound, parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { getLatestDossier } from "@/lib/dossier";
import { findCompany } from "@/lib/company";
import { startJob } from "@/lib/jobs/start";

export const dynamic = "force-dynamic";

export const GET = route<{ ticker: string }>(async (_req, { params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  // A read does not create rows: an unknown ticker is a 404, not a new company.
  const company = await findCompany(ticker);
  if (!company) throw notFound(`the desk has no company "${ticker}"`);
  return Response.json({ company, dossier: await getLatestDossier(company.id) });
});

// The pipeline runs as a job; its events — Scout handing off to Analyst
// handing off to Strategist — are followed at /api/jobs/<id>/events. A second
// request for the same ticker while one is pending joins that one.
export const POST = route<{ ticker: string }>(async (req, { actor, params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  const force = req.nextUrl.searchParams.get("force") === "1";
  const watch = req.nextUrl.searchParams.get("watch") !== "0";
  return startJob(actor, "research", { ticker, force, watch }, { dedupeKey: `research:${ticker}` });
});
