import { z } from "zod";
import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { authenticate, setPassword } from "@/lib/auth/users";
import { signedIn } from "@/lib/auth/respond";

export const dynamic = "force-dynamic";

const Body = z.object({
  current: z.string().min(1).max(256),
  next: z.string().min(1).max(256),
});

// Changing the password ends every session, this one included, and opens a
// fresh one for the person making the change.
export const POST = route(async (req, { user, ip, requestId }) => {
  const { current, next } = await parseJson(req, Body);
  await authenticate(user.email, current, ip).catch(() => {
    throw new HttpError(403, "the current password is not right");
  });
  await setPassword(user.userId, next, { ip, requestId });
  return signedIn(req, user.userId, { ok: true }, { ip, requestId });
});
