import type { NextRequest } from "next/server";
import { fetchChart } from "@/lib/quote";

export const dynamic = "force-dynamic";

// The price card asks for this directly, so a Yahoo outage costs the card and
// nothing else on the page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const range = new URL(req.url).searchParams.get("range") ?? "1mo";

  try {
    return Response.json(await fetchChart(ticker, range), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "quote unavailable" },
      { status: 502 }
    );
  }
}
