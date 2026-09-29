import type { NextRequest } from "next/server";
import { marketOverview } from "@/lib/market/overview";
import { writeBrief } from "@/lib/market/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    const brief = await writeBrief(await marketOverview(), force);
    return Response.json(brief);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "the brief could not be written" }, { status: 503 });
  }
}
