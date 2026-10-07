import { NextRequest } from "next/server";
import { pool } from "../../lib/db";
import { createUser } from "../../lib/auth/users";
import { createSession, ensureAccount } from "../../lib/auth/sessions";
import { SESSION_COOKIE } from "../../lib/auth/cookie";
import type { Actor } from "../../lib/actor";

export const PASSWORD = "correct horse battery staple";

export interface TestUser extends Actor {
  email: string;
  cookie: string;
}

let n = 0;
export async function signedInUser(email = `user${++n}@example.com`): Promise<TestUser> {
  const user = await createUser(email, PASSWORD, null);
  const account = await ensureAccount(user.id);
  const { cookie } = await createSession(user.id);
  return { userId: user.id, accountId: account.id, email, cookie };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;

export async function call(
  handler: Handler,
  opts: {
    method?: string;
    path?: string;
    cookie?: string;
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: unknown; res: Response }> {
  const headers: Record<string, string> = { host: "localhost:3000", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost:3000${opts.path ?? "/api/test"}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, res };
}

export async function count(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}
