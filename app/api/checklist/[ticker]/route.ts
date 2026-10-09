import { route } from "@/lib/http/route";
import { parseWith } from "@/lib/http/errors";
import { PositionSize, Ticker } from "@/lib/http/schemas";
import { buildChecklist } from "@/lib/checklist-data";

export const dynamic = "force-dynamic";

// The pre-investment checklist for one company, against the person's profile.
// ?size= tries a different position size without saving it.
export const GET = route<{ ticker: string }>(async (req, { actor, params }) => {
  const ticker = parseWith(Ticker, params.ticker);
  const rawSize = req.nextUrl.searchParams.get("size");
  const positionSize = rawSize === null || rawSize === "" ? undefined : parseWith(PositionSize, rawSize);
  return Response.json(await buildChecklist(actor, ticker, { positionSize }));
});
