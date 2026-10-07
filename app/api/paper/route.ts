import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { PaperOrder } from "@/lib/http/schemas";
import { PaperError, paperPortfolio, placeOrder } from "@/lib/paper";
import { limitUser } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { actor }) => Response.json(await paperPortfolio(actor.userId)));

export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, PaperOrder);
  await limitUser(actor.userId, "paper-order", 30);
  try {
    const trade = await placeOrder({
      userId: actor.userId,
      ticker: body.ticker,
      side: body.side,
      dollars: body.dollars,
      qty: body.qty,
      runId: body.runId ?? null,
      rationale: body.rationale ?? null,
    });
    return Response.json(trade, { status: 201 });
  } catch (err) {
    if (err instanceof PaperError) throw new HttpError(422, err.message);
    throw err;
  }
});
