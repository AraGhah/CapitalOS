import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Actor } from "../actor";
import { SESSION_COOKIE } from "./cookie";
import { resolveSession, type SessionUser } from "./sessions";

/* ---------------------------------------------------------------------------
   The signed-in person, for server components. The proxy has already turned
   away requests without a well-signed cookie; this is the authoritative check
   (expired, revoked and disabled sessions fail here).
--------------------------------------------------------------------------- */

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

// For pages: the actor, or a redirect to sign in.
export async function requirePageActor(): Promise<{ actor: Actor; user: SessionUser }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const h = await headers();
  return {
    user,
    actor: {
      userId: user.userId,
      accountId: user.accountId,
      requestId: h.get("x-request-id"),
      ip: h.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    },
  };
}
