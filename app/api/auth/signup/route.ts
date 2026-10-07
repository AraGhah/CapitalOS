import { z } from "zod";
import { publicRoute } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { config } from "@/lib/config";
import { createUser } from "@/lib/auth/users";
import { signedIn } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  displayName: z.string().trim().max(80).optional(),
});

// Off unless ALLOW_SIGNUP is set: a personal desk does not take strangers.
export const POST = publicRoute(async (req, { ip, requestId }) => {
  if (!config().ALLOW_SIGNUP) throw new HttpError(403, "sign-up is closed on this desk");
  const { email, password, displayName } = await parseJson(req, Body);
  const user = await createUser(email, password, displayName ?? null, { ip, requestId });
  return signedIn(req, user.id, { user: { email: user.email, displayName: user.displayName } }, { ip, requestId });
});
