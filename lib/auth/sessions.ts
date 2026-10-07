import { pool, type Db } from "../db";
import { config } from "../config";
import { hashToken, newSessionToken, signSessionCookie, verifySessionCookie } from "./cookie";

/* ---------------------------------------------------------------------------
   Server-side sessions. The table holds only the token's hash; expiry slides
   forward while the session is used, and a session can be revoked (sign-out,
   password change) without waiting for it to expire.
--------------------------------------------------------------------------- */

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  accountId: string;
  baseCurrency: string;
  expiresAt: Date;
}

function lifetimeMs(): number {
  return config().SESSION_DAYS * 86_400_000;
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  db: Db = pool
): Promise<{ cookie: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + lifetimeMs());
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null]
  );
  return { cookie: signSessionCookie(token), expiresAt };
}

// The person behind a cookie, or null if the cookie is forged, expired,
// revoked or belongs to a disabled user. A session used after half its life is
// extended, so an active person is not signed out mid-week.
export async function resolveSession(cookie: string | undefined | null): Promise<SessionUser | null> {
  const token = verifySessionCookie(cookie);
  if (!token) return null;
  const id = hashToken(token);

  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.expires_at, s.created_at, u.email, u.display_name,
            a.id AS account_id, a.base_currency
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN LATERAL (
       SELECT id, base_currency FROM accounts WHERE user_id = u.id ORDER BY created_at, id LIMIT 1
     ) a ON true
     WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;

  let accountId = row.account_id as string | null;
  let baseCurrency = (row.base_currency as string | null) ?? "USD";
  if (!accountId) {
    const created = await ensureAccount(row.user_id);
    accountId = created.id;
    baseCurrency = created.baseCurrency;
  }

  let expiresAt = row.expires_at as Date;
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining < lifetimeMs() / 2) {
    expiresAt = new Date(Date.now() + lifetimeMs());
    await pool.query(`UPDATE sessions SET expires_at = $2, last_seen_at = now() WHERE id = $1`, [id, expiresAt]);
  }

  return {
    sessionId: id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    accountId,
    baseCurrency,
    expiresAt,
  };
}

export async function ensureAccount(userId: string, db: Db = pool): Promise<{ id: string; baseCurrency: string }> {
  const { rows } = await db.query(
    `SELECT id, base_currency FROM accounts WHERE user_id = $1 ORDER BY created_at, id LIMIT 1`,
    [userId]
  );
  if (rows[0]) return { id: rows[0].id, baseCurrency: rows[0].base_currency };
  const { rows: made } = await db.query(
    `INSERT INTO accounts (user_id, name) VALUES ($1, 'Main') RETURNING id, base_currency`,
    [userId]
  );
  return { id: made[0].id, baseCurrency: made[0].base_currency };
}

export async function revokeSession(cookie: string | undefined | null): Promise<void> {
  const token = verifySessionCookie(cookie);
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [hashToken(token)]);
}

export async function revokeAllSessions(userId: string, db: Db = pool, exceptSessionId?: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)`,
    [userId, exceptSessionId ?? null]
  );
}
