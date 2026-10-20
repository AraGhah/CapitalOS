import { route } from "@/lib/http/route";
import { HttpError, parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { technicalRead } from "@/lib/technical-read";

export const dynamic = "force-dynamic";

// Indicators computed by code from the ticker's daily bars: the same figures
// the committee reads, without convening one.
export const GET = route<{ ticker: string }>(async (_req, { params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  try {
    return Response.json(await technicalRead(ticker), { headers: { "Cache-Control": "no-store" } });
  } catch {
    throw new HttpError(502, `no price history for ${ticker} right now`, "upstream_unavailable");
  }
});
