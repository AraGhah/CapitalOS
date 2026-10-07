import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* ---------------------------------------------------------------------------
   The session cookie, with no database access, so the proxy can use it.

   The cookie is `<token>.<hmac>`: a random 256-bit token and its HMAC under
   SESSION_SECRET. The proxy checks the HMAC — a forged or truncated cookie
   is turned away before any route runs — and the route then looks the
   token's SHA-256 up in `sessions`, which is the check that can be revoked.
--------------------------------------------------------------------------- */

export const SESSION_COOKIE = "capitalos_session";

const DEV_SECRET = "capitalos-development-only-secret-do-not-use-in-production";

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET (32+ characters) is required in production");
  }
  return DEV_SECRET;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mac(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

export function signSessionCookie(token: string, secret = sessionSecret()): string {
  return `${token}.${mac(token, secret)}`;
}

// The token inside a well-formed, correctly signed cookie; null for anything else.
export function verifySessionCookie(value: string | undefined | null, secret = sessionSecret()): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(token, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return token;
}

export function cookieIsSecure(requestProtocol: string | null | undefined): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (["1", "true", "yes", "on"].includes((process.env.TRUST_PROXY ?? "").toLowerCase())) return true;
  return requestProtocol === "https:" || requestProtocol === "https";
}
