import type { NextRequest } from "next/server";
import { analyzeRisk, basisFrom } from "@/lib/risk/engine";

export const dynamic = "force-dynamic";

// ?basket=NVDA:30,AMD:20 for a what-if basket, ?source=watchlist for the
// watchlist at equal weight, nothing for the open positions.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const report = await analyzeRisk(basisFrom({ basket: params.get("basket"), source: params.get("source") }));
  return Response.json(report);
}
