import { route } from "@/lib/http/route";
import { HttpError, parseWith } from "@/lib/http/errors";
import { QuoteRange, Ticker } from "@/lib/http/schemas";
import { fetchChart } from "@/lib/quote";

export const dynamic = "force-dynamic";

// The price card asks for this directly, so a market-data outage costs the
// card and nothing else on the page.
export const GET = route<{ ticker: string }>(async (req, { params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  const range = QuoteRange.parse(req.nextUrl.searchParams.get("range") ?? "1mo");
  try {
    return Response.json(await fetchChart(ticker, range), { headers: { "Cache-Control": "no-store" } });
  } catch {
    throw new HttpError(502, `no quote for ${ticker} right now`, "upstream_unavailable");
  }
});
