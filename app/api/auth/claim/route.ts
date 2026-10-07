import { z } from "zod";
import { publicRoute } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { claimLegacyOwner } from "@/lib/auth/users";
import { signedIn } from "@/lib/auth/respond";
import { isLoopbackHost, setupCodeMatches } from "@/lib/auth/setup-code";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  setupCode: z.string().max(64).optional(),
});

// The desk that existed before accounts did is claimed by setting its owner's
// e-mail and password. From the machine itself that is enough; from anywhere
// else it also takes the setup code only the operator can print.
export const POST = publicRoute(async (req, { ip, requestId }) => {
  const { email, password, setupCode } = await parseJson(req, Body);
  if (!isLoopbackHost(req.headers.get("host")) && !setupCodeMatches(setupCode)) {
    throw new HttpError(403, "claiming this desk from another machine needs the setup code (npm run user -- setup-code)");
  }
  const user = await claimLegacyOwner(email, password, { ip, requestId });
  return signedIn(req, user.id, { user: { email: user.email, displayName: user.displayName } }, { ip, requestId });
});
