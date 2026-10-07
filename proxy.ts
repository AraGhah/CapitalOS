import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionCookie } from "./lib/auth/cookie";

/* ---------------------------------------------------------------------------
   The front door. Cheap checks only — no database — before any route runs:

   1. A request id, passed on to the route and returned to the client, so one
      id follows a request through every log line.
   2. Host. Only the loopback names plus CAPITALOS_ALLOWED_HOSTS are served,
      which stops a DNS-rebinding page from talking to the desk as if it were
      same-origin.
   3. A session. Every page and API route except sign-in and health checks
      needs a correctly signed session cookie; a forged or missing one is sent
      to /login (pages) or answered 401 (API). Whether the session is still
      valid — not expired, not revoked — is checked by the route itself against
      the sessions table.
   4. Cross-site writes. A browser always sends Origin (or Sec-Fetch-Site) on a
      cross-site POST, and a page on another site must not be able to place
      orders, write the ledger or convene a committee. A write with a body must
      also be declared JSON, which a cross-site form cannot do without a
      preflight the desk never answers.
--------------------------------------------------------------------------- */

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

// Reachable without a session.
const PUBLIC_PATHS = [
  /^\/login$/,
  /^\/api\/auth\/(login|claim|signup|status)$/,
  /^\/api\/(health|ready)$/,
  /^\/api\/metrics$/, // bearer METRICS_TOKEN, checked by the route
  /^\/api\/webhooks\//, // authenticated by the provider's signature instead
  /^\/api\/integrations\/questrade\/callback$/, // OAuth redirect; validated by its state
];

function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function allowedHosts(): string[] {
  const extra = (process.env.CAPITALOS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...LOOPBACK, ...extra];
}

/* --------------------------------------------------------- security headers */

// A fresh nonce per request: Next.js adds it to its own scripts when it sees
// it in the request's CSP, and the layout adds it to the one inline script.
// Inline style attributes are allowed — React and the charts render them, and
// a nonce cannot cover an attribute — but no inline script runs without the
// nonce, nothing loads from another origin, and no other site can frame the
// desk (clickjacking a "convene committee" button).
function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function secure(res: NextResponse, nonce: string | null, https: boolean): NextResponse {
  if (nonce) res.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (https) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return res;
}

function isHttps(req: NextRequest): boolean {
  return (
    req.nextUrl.protocol === "https:" ||
    (["1", "true", "yes", "on"].includes((process.env.TRUST_PROXY ?? "").toLowerCase()) &&
      req.headers.get("x-forwarded-proto") === "https")
  );
}

function deny(req: NextRequest, status: number, message: string, requestId: string) {
  const headers = { "x-request-id": requestId };
  const res = req.nextUrl.pathname.startsWith("/api/")
    ? NextResponse.json({ error: message, requestId }, { status, headers })
    : new NextResponse(message, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  return secure(res, null, isHttps(req));
}

function hasBody(req: NextRequest): boolean {
  const length = req.headers.get("content-length");
  return (length !== null && length !== "0") || req.headers.has("transfer-encoding");
}

export function proxy(req: NextRequest) {
  const given = req.headers.get("x-request-id");
  const requestId = given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID();
  const path = req.nextUrl.pathname;

  const host = req.headers.get("host") ?? "";
  if (!allowedHosts().includes(hostnameOf(host))) {
    return deny(req, 421, `host "${host}" is not served; add it to CAPITALOS_ALLOWED_HOSTS to allow it`, requestId);
  }

  if (UNSAFE.has(req.method) && !path.startsWith("/api/webhooks/")) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");

    if (origin !== null) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost !== host.toLowerCase()) return deny(req, 403, "cross-site requests are refused", requestId);
    } else if (site !== null && site !== "same-origin" && site !== "none") {
      return deny(req, 403, "cross-site requests are refused", requestId);
    }

    if (hasBody(req) && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return deny(req, 415, "send the body as application/json", requestId);
    }
  }

  const isPublic = PUBLIC_PATHS.some((p) => p.test(path));
  if (!isPublic) {
    let signed = false;
    try {
      signed = verifySessionCookie(req.cookies.get(SESSION_COOKIE)?.value) !== null;
    } catch {
      // no SESSION_SECRET in production: nobody gets in until it is set
      signed = false;
    }
    if (!signed) {
      if (path.startsWith("/api/")) return deny(req, 401, "sign in to use the desk", requestId);
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
      const res = NextResponse.redirect(login);
      res.headers.set("x-request-id", requestId);
      return secure(res, null, isHttps(req));
    }
  }

  const nonce = Buffer.from(randomUUID()).toString("base64");
  const page = !path.startsWith("/api/");
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  // The layout needs the path to tell the sign-in page from everything else.
  headers.set("x-pathname", path);
  if (page) {
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  }
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  return secure(res, page ? nonce : null, isHttps(req));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
