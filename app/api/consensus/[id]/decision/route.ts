import { route } from "@/lib/http/route";
import { decideForRun } from "@/lib/decision/data";
import { recordDecision } from "@/lib/decision/store";
import { limitUser } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// What to do about this committee's stock, for you, today: a five-tier rating,
// an action, a plan and a size. Computed from the finished report, your
// checklist, profile and portfolio; no model is called and nothing is written.
export const GET = route<{ id: string }>(async (_req, { actor, params }) => {
  const { decision, hash } = await decideForRun(actor, params.id);
  return Response.json({ decision, hash });
});

// Records the decision as it stands, with the inputs it came from. The same
// inputs are recorded once.
export const POST = route<{ id: string }>(async (_req, { actor, params }) => {
  await limitUser(actor.userId, "record-decision", 30);
  const gathered = await decideForRun(actor, params.id);
  const saved = await recordDecision(actor, gathered);
  return Response.json({ ...saved, decision: gathered.decision }, { status: saved.duplicate ? 200 : 201 });
});
