import type { NextRequest } from "next/server";
import { PaperError, paperPortfolio, placeOrder } from "@/lib/paper";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await paperPortfolio());
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
  const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
  if (!ticker || !side) return Response.json({ error: "an order needs a ticker and a side" }, { status: 400 });

  const dollars = typeof body.dollars === "number" ? body.dollars : undefined;
  const qty = typeof body.qty === "number" ? body.qty : undefined;
  const runId = typeof body.runId === "string" && /^[0-9a-f-]{36}$/i.test(body.runId) ? body.runId : null;

  try {
    const trade = await placeOrder({
      ticker,
      side,
      dollars,
      qty,
      runId,
      rationale: typeof body.rationale === "string" ? body.rationale : null,
    });
    return Response.json(trade, { status: 201 });
  } catch (err) {
    const status = err instanceof PaperError ? 422 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "the order failed" }, { status });
  }
}
