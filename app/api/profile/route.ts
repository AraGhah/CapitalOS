import { route } from "@/lib/http/route";
import { parseJson } from "@/lib/http/errors";
import { ProfilePatch } from "@/lib/http/schemas";
import { getProfile, saveProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

// The investor profile the pre-investment checklist reads: finances, goal,
// horizon, risk capacity, account and broker.
export const GET = route(async (_req, { actor }) => Response.json(await getProfile(actor.userId)));

export const PATCH = route(async (req, { actor }) => {
  const patch = await parseJson(req, ProfilePatch);
  return Response.json(await saveProfile(actor, patch));
});
