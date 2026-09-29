import type { NextRequest } from "next/server";
import { getRun } from "@/lib/ai/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return Response.json({ error: "no such run" }, { status: 404 });
  return Response.json(run);
}
