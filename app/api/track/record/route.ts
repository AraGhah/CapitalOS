import { route } from "@/lib/http/route";
import { parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { readTrackRecord } from "@/lib/track/data";

export const dynamic = "force-dynamic";

// How your recorded decisions have turned out against the S&P 500, from stored
// closes; ?ticker= narrows it to one stock. No model is asked.
export const GET = route(async (req, { actor }) => {
  const raw = req.nextUrl.searchParams.get("ticker");
  const ticker = raw ? parseWith(Ticker, raw) : undefined;
  return Response.json(await readTrackRecord(actor.userId, { ticker }), { headers: { "Cache-Control": "no-store" } });
});
