import { route } from "@/lib/http/route";
import { parseWith } from "@/lib/http/errors";
import { Ticker } from "@/lib/http/schemas";
import { listDecisions } from "@/lib/decision/store";

export const dynamic = "force-dynamic";

// The decisions you have recorded, newest first; ?ticker= narrows to one stock.
export const GET = route(async (req, { actor }) => {
  const raw = req.nextUrl.searchParams.get("ticker");
  const ticker = raw ? parseWith(Ticker, raw) : undefined;
  return Response.json({ decisions: await listDecisions(actor.userId, { ticker, limit: 50 }) });
});
