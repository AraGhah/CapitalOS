import { NextResponse, type NextRequest } from "next/server";

/* ---------------------------------------------------------------------------
   The front door. Everything behind it reads a brokerage ledger and spends
   model credits, so three things are checked before any route runs:

   1. Host. Only the loopback names (plus CAPITALOS_ALLOWED_HOSTS) are served,
      which is what stops a DNS-rebinding page from talking to the desk as if
      it were same-origin.
   2. A token, when CAPITALOS_TOKEN is set. Open /?token=<value> once and it is
      kept in an httpOnly cookie; scripts can send it as a bearer token.
   3. Cross-site writes. A browser always sends Origin (or Sec-Fetch-Site) on a
      cross-site POST, and a page on another site must not be able to place
      trades, write the ledger or convene a committee. A write with a body must
      also be declared JSON, which a cross-site page cannot do without a
      preflight the desk never answers.
--------------------------------------------------------------------------- */

const TOKEN_COOKIE = "capitalos_token";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

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

// Length is not secret; the comparison of the characters is done in full.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function deny(req: NextRequest, status: number, message: string) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: message }, { status });
  }
  return new NextResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function hasBody(req: NextRequest): boolean {
  const length = req.headers.get("content-length");
  return (length !== null && length !== "0") || req.headers.has("transfer-encoding");
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!allowedHosts().includes(hostnameOf(host))) {
    return deny(req, 421, `host "${host}" is not served; add it to CAPITALOS_ALLOWED_HOSTS to allow it`);
  }

  const token = process.env.CAPITALOS_TOKEN?.trim();
  if (token) {
    const offered = req.nextUrl.searchParams.get("token");
    if (offered !== null && safeEqual(offered, token)) {
      const clean = req.nextUrl.clone();
      clean.searchParams.delete("token");
      const res = NextResponse.redirect(clean);
      res.cookies.set(TOKEN_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: req.nextUrl.protocol === "https:",
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    }

    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const presented = req.cookies.get(TOKEN_COOKIE)?.value ?? bearer ?? "";
    if (!safeEqual(presented, token)) {
      return deny(req, 401, "this desk needs its access token: open /?token=<CAPITALOS_TOKEN> once");
    }
  }

  if (UNSAFE.has(req.method)) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");

    if (origin !== null) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost !== host.toLowerCase()) return deny(req, 403, "cross-site requests are refused");
    } else if (site !== null && site !== "same-origin" && site !== "none") {
      return deny(req, 403, "cross-site requests are refused");
    }

    if (hasBody(req) && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return deny(req, 415, "send the body as application/json");
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
