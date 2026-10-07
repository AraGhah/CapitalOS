import { publicRoute } from "@/lib/http/route";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { revokeSession } from "@/lib/auth/sessions";
import { signedOut } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

export const POST = publicRoute(async (req, { requestId }) => {
  await revokeSession(req.cookies.get(SESSION_COOKIE)?.value);
  return signedOut(requestId);
});
