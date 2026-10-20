import { route } from "@/lib/http/route";
import { notFound, parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { findCompany } from "@/lib/company";
import { lensRead } from "@/lib/personas/data";

export const dynamic = "force-dynamic";

// Eight investors' published tests run on the company's own figures: the same
// result the research page shows, without a model.
export const GET = route<{ ticker: string }>(async (_req, { params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  const company = await findCompany(ticker);
  if (!company) throw notFound(`the desk has no company "${ticker}" — research it first to add it`);
  return Response.json(await lensRead(company), { headers: { "Cache-Control": "no-store" } });
});
