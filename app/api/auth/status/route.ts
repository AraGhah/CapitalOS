import { publicRoute } from "@/lib/http/route";
import { config } from "@/lib/config";
import { legacyOwnerUnclaimed } from "@/lib/auth/users";
import { isLoopbackHost } from "@/lib/auth/setup-code";

export const dynamic = "force-dynamic";

// What the sign-in page should offer.
export const GET = publicRoute(async (req, { user }) => {
  return Response.json({
    signedIn: Boolean(user),
    signup: config().ALLOW_SIGNUP,
    claimable: await legacyOwnerUnclaimed(),
    claimNeedsCode: !isLoopbackHost(req.headers.get("host")),
  });
});
