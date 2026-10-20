import { route } from "@/lib/http/route";
import { benchmarkSummary } from "@/lib/sentiment/benchmark";

export const dynamic = "force-dynamic";

// How well the headline tagger agrees with hand-labelled headlines kept in the
// repository, beside the old word list it replaced. Computed from fixed sets, so
// it needs no database and calls no model.
export const GET = route(async () => {
  return Response.json(benchmarkSummary(), { headers: { "Cache-Control": "no-store" } });
});
