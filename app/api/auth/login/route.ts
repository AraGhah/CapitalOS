import { z } from "zod";
import { publicRoute } from "@/lib/http/route";
import { parseJson } from "@/lib/http/errors";
import { authenticate } from "@/lib/auth/users";
import { signedIn } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

export const POST = publicRoute(async (req, { ip, requestId }) => {
  const { email, password } = await parseJson(req, LoginBody);
  const user = await authenticate(email, password, ip);
  return signedIn(req, user.id, { user: { email: user.email, displayName: user.displayName } }, { ip, requestId });
});
