import { route } from "@/lib/http/route";
import { planCheckData } from "@/lib/track/data";

export const dynamic = "force-dynamic";

// How the plan's stop and reward levels would have fared on the stored history
// of the stocks the desk follows. Stored closes only; no model, no outside feed.
export const GET = route(async () => {
  return Response.json(await planCheckData(), { headers: { "Cache-Control": "no-store" } });
});
