import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { Actor } from "../actor";
import { SESSION_COOKIE } from "../auth/cookie";
import { resolveSession, type SessionUser } from "../auth/sessions";
import { errorFields, log } from "../log";
import { reportError } from "../observability";
import { HttpError, statusOf, unauthorized } from "./errors";

/* ---------------------------------------------------------------------------
   Every API route goes through here. It gives the request an id (taken from
   the proxy, so one id follows the request through every log line), resolves
   the signed-in person, turns known errors into their status, turns unknown
   ones into a 500 that says nothing internal, and logs one line per request.
--------------------------------------------------------------------------- */

export interface RouteContext<P> {
  actor: Actor;
  user: SessionUser;
  params: P;
  requestId: string;
  ip: string | null;
}

export interface PublicRouteContext<P> {
  params: P;
  requestId: string;
  ip: string | null;
  user: SessionUser | null;
}

type Params = Record<string, string | string[]>;

export function requestIdOf(req: Request): string {
  const given = req.headers.get("x-request-id");
  return given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID();
}

export function clientIp(req: Request): string | null {
  // The proxy overwrites x-forwarded-for with what it saw; behind a trusted
  // load balancer the left-most entry is the client.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 64) || null;
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

function cookieOf(req: NextRequest): string | undefined {
  return req.cookies.get(SESSION_COOKIE)?.value;
}

export function errorResponse(err: unknown, requestId: string): Response {
  const status = statusOf(err);
  if (status === null) {
    reportError(err, { requestId });
    return Response.json(
      { error: "something went wrong on the desk; the request id is in the logs", code: "internal", requestId },
      { status: 500, headers: { "x-request-id": requestId } }
    );
  }
  const body: Record<string, unknown> = {
    error: (err as Error).message,
    code: err instanceof HttpError ? err.code : undefined,
    requestId,
  };
  if (err instanceof HttpError && err.details) body.details = err.details;
  return Response.json(body, { status, headers: { "x-request-id": requestId } });
}

function finish(res: Response, requestId: string): Response {
  if (!res.headers.has("x-request-id")) {
    try {
      res.headers.set("x-request-id", requestId);
    } catch {
      // immutable headers (a proxied fetch response); the id is in the log line
    }
  }
  return res;
}

export function route<P extends Params = Params>(
  handler: (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const requestId = requestIdOf(req);
    const started = Date.now();
    const ip = clientIp(req);
    let userId: string | null = null;
    let status = 500;
    try {
      const user = await resolveSession(cookieOf(req));
      if (!user) throw unauthorized();
      userId = user.userId;
      const params = (await segment?.params) ?? ({} as P);
      const actor: Actor = { userId: user.userId, accountId: user.accountId, requestId, ip };
      const res = finish(await handler(req, { actor, user, params, requestId, ip }), requestId);
      status = res.status;
      return res;
    } catch (err) {
      const res = errorResponse(err, requestId);
      status = res.status;
      if (status >= 500) log.error({ requestId, userId, path: req.nextUrl.pathname, ...errorFields(err) }, "request failed");
      return res;
    } finally {
      log.info(
        { requestId, userId, method: req.method, path: req.nextUrl.pathname, status, ms: Date.now() - started },
        "request"
      );
    }
  };
}

// For the few routes a signed-out visitor may call (sign-in, health checks).
export function publicRoute<P extends Params = Params>(
  handler: (req: NextRequest, ctx: PublicRouteContext<P>) => Promise<Response>
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const requestId = requestIdOf(req);
    const started = Date.now();
    const ip = clientIp(req);
    let status = 500;
    try {
      const user = await resolveSession(cookieOf(req)).catch(() => null);
      const params = (await segment?.params) ?? ({} as P);
      const res = finish(await handler(req, { params, requestId, ip, user }), requestId);
      status = res.status;
      return res;
    } catch (err) {
      const res = errorResponse(err, requestId);
      status = res.status;
      if (status >= 500) log.error({ requestId, path: req.nextUrl.pathname, ...errorFields(err) }, "request failed");
      return res;
    } finally {
      log.info({ requestId, method: req.method, path: req.nextUrl.pathname, status, ms: Date.now() - started }, "request");
    }
  };
}
