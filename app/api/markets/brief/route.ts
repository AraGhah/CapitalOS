import { route } from "@/lib/http/route";
import { HttpError } from "@/lib/http/errors";
import { marketOverview } from "@/lib/market/overview";
import { writeBrief } from "@/lib/market/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = route(async (req, { actor }) => {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    return Response.json(await writeBrief(actor, await marketOverview(), force));
  } catch (err) {
    if (err instanceof Error && (err as { status?: number }).status === undefined && !("code" in err)) {
      throw new HttpError(503, err.message, "brief_unavailable");
    }
    throw err;
  }
});
