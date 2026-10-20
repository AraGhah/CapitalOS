import { route } from "@/lib/http/route";
import { sentimentStudy } from "@/lib/sentiment/data";

export const dynamic = "force-dynamic";

// Whether the labels on the desk's headlines lined up with what the stocks
// then did, from stored prices only; no outside feed and no model is asked.
export const GET = route(async () => {
  return Response.json(await sentimentStudy(), { headers: { "Cache-Control": "no-store" } });
});
