import { route } from "@/lib/http/route";
import { notFound, parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { findCompany } from "@/lib/company";
import { earningsRead } from "@/lib/earnings/data";

export const dynamic = "force-dynamic";

// The latest quarter's earnings surprise, the stock's reaction to it and the
// drift since: the figures the research page and the committee's evidence
// read, without convening a committee.
export const GET = route<{ ticker: string }>(async (_req, { params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  const company = await findCompany(ticker);
  if (!company) throw notFound(`the desk has no company "${ticker}" — research it first to add it`);
  return Response.json(await earningsRead(company), { headers: { "Cache-Control": "no-store" } });
});
