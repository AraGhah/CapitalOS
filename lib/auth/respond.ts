import { NextResponse } from "next/server";
import { config } from "../config";
import { cookieIsSecure, SESSION_COOKIE } from "./cookie";
import { createSession } from "./sessions";

// Signs a person in: a new server-side session and its cookie.
export async function signedIn(
  req: Request,
  userId: string,
  body: Record<string, unknown>,
  meta: { ip: string | null; requestId: string }
): Promise<NextResponse> {
  const { cookie, expiresAt } = await createSession(userId, {
    userAgent: req.headers.get("user-agent"),
    ip: meta.ip,
  });
  const res = NextResponse.json(body, { headers: { "x-request-id": meta.requestId } });
  res.cookies.set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    // Lax, not Strict, so following a link to the desk from elsewhere arrives
    // signed in; cross-site writes are refused by the proxy's Origin check.
    sameSite: "lax",
    secure: cookieIsSecure(new URL(req.url).protocol) || config().TRUST_PROXY,
    path: "/",
    expires: expiresAt,
  });
  return res;
}

export function signedOut(requestId: string): NextResponse {
  const res = NextResponse.json({ ok: true }, { headers: { "x-request-id": requestId } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
