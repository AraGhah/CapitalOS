import { route } from "@/lib/http/route";
import { analyzeRisk, basisFrom } from "@/lib/risk/engine";

export const dynamic = "force-dynamic";

// ?basket=NVDA:30,AMD:20 for a what-if basket, ?source=watchlist for the
// watchlist at equal weight, nothing for the open positions.
export const GET = route(async (req, { actor }) => {
  const params = req.nextUrl.searchParams;
  const basket = params.get("basket");
  return Response.json(
    await analyzeRisk(actor, basisFrom({ basket: basket ? basket.slice(0, 1000) : null, source: params.get("source") }))
  );
});
