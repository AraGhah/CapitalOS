import { route } from "@/lib/http/route";
import { notFound } from "@/lib/http/errors";
import { getRun } from "@/lib/ai/store";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { actor, params }) => {
  const run = await getRun(actor.userId, params.id);
  if (!run) throw notFound("no such run");
  return Response.json(run);
});
