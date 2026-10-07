import { pool, withTransaction } from "../db";
import { audit, type AuditContext } from "../audit";
import { LEGACY_OWNER_ID } from "../actor";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "./password";
import { ensureAccount, revokeAllSessions } from "./sessions";

/* ---------------------------------------------------------------------------
   Accounts of people: sign-up, sign-in with throttling, password changes, and
   claiming the desk that existed before sign-in did.
--------------------------------------------------------------------------- */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number = 401
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Guessing is limited per address and per network address. Counted from the
// attempts table, so the limit holds across every server process.
const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 50;

async function throttled(email: string, ip: string | null): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM login_attempts
          WHERE lower(email) = $1 AND NOT success AND at > now() - make_interval(mins => $3))::int AS by_email,
       (SELECT count(*) FROM login_attempts
          WHERE $2::text IS NOT NULL AND ip = $2 AND NOT success AND at > now() - make_interval(mins => $3))::int AS by_ip`,
    [email, ip, WINDOW_MINUTES]
  );
  return rows[0].by_email >= MAX_FAILURES_PER_EMAIL || rows[0].by_ip >= MAX_FAILURES_PER_IP;
}

async function recordAttempt(email: string, ip: string | null, success: boolean): Promise<void> {
  await pool.query(`INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)`, [email, ip, success]);
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}

export async function authenticate(rawEmail: string, password: string, ip: string | null): Promise<PublicUser> {
  const email = normaliseEmail(rawEmail);
  if (await throttled(email, ip)) {
    throw new AuthError(`too many failed sign-ins; wait ${WINDOW_MINUTES} minutes and try again`, 429);
  }

  const { rows } = await pool.query(
    `SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = $1 AND disabled_at IS NULL`,
    [email]
  );
  const user = rows[0];
  const ok = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
  await recordAttempt(email, ip, ok);
  // One message for an unknown address and a wrong password.
  if (!ok) throw new AuthError("that e-mail and password do not match");
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export async function createUser(
  rawEmail: string,
  password: string,
  displayName: string | null,
  ctx: Omit<AuditContext, "userId"> = {}
): Promise<PublicUser> {
  const email = normaliseEmail(rawEmail);
  if (!EMAIL.test(email)) throw new AuthError("that is not an e-mail address", 400);
  const problem = passwordProblem(password);
  if (problem) throw new AuthError(problem, 400);
  const hash = await hashPassword(password);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id, email, display_name`,
      [email, hash, displayName?.trim().slice(0, 80) || null]
    );
    if (!rows[0]) throw new AuthError("an account with that e-mail already exists", 409);
    await ensureAccount(rows[0].id, client);
    await audit(client, { ...ctx, userId: rows[0].id }, { action: "user.create", entity: "user", entityId: rows[0].id });
    return { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name };
  });
}

export async function setPassword(userId: string, password: string, ctx: Omit<AuditContext, "userId"> = {}): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new AuthError(problem, 400);
  const hash = await hashPassword(password);
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
    if (!rowCount) throw new AuthError("no such user", 404);
    // A new password ends every existing session.
    await revokeAllSessions(userId, client);
    await audit(client, { ...ctx, userId }, { action: "user.password", entity: "user", entityId: userId });
  });
}

// The desk that existed before sign-in belongs to a legacy owner with no
// password. Until someone claims it, the sign-in page offers to; claiming sets
// the owner's address and password in one step. Once claimed it is an
// ordinary account.
export async function legacyOwnerUnclaimed(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT password_hash IS NULL AS open FROM users WHERE id = $1`, [LEGACY_OWNER_ID]);
  return rows[0]?.open === true;
}

export async function claimLegacyOwner(
  rawEmail: string,
  password: string,
  ctx: Omit<AuditContext, "userId"> = {}
): Promise<PublicUser> {
  const email = normaliseEmail(rawEmail);
  if (!EMAIL.test(email)) throw new AuthError("that is not an e-mail address", 400);
  const problem = passwordProblem(password);
  if (problem) throw new AuthError(problem, 400);
  const hash = await hashPassword(password);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE users SET email = $2, password_hash = $3
       WHERE id = $1 AND password_hash IS NULL
       RETURNING id, email, display_name`,
      [LEGACY_OWNER_ID, email, hash]
    ).catch((err) => {
      if ((err as { code?: string }).code === "23505") throw new AuthError("an account with that e-mail already exists", 409);
      throw err;
    });
    if (!rows[0]) throw new AuthError("this desk has already been claimed; sign in instead", 409);
    await audit(client, { ...ctx, userId: LEGACY_OWNER_ID }, { action: "user.claim", entity: "user", entityId: LEGACY_OWNER_ID });
    return { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name };
  });
}

export async function findUserByEmail(rawEmail: string): Promise<PublicUser | null> {
  const { rows } = await pool.query(`SELECT id, email, display_name FROM users WHERE lower(email) = $1`, [
    normaliseEmail(rawEmail),
  ]);
  return rows[0] ? { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name } : null;
}

// Every person whose desk the scheduled jobs look after, with the account
// their writes land in. Disabled people are left alone.
export async function listActiveActors(): Promise<Array<{ userId: string; accountId: string; email: string }>> {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.email, a.id AS account_id
     FROM users u
     JOIN LATERAL (SELECT id FROM accounts WHERE user_id = u.id ORDER BY created_at, id LIMIT 1) a ON true
     WHERE u.disabled_at IS NULL
     ORDER BY u.created_at`
  );
  return rows.map((r) => ({ userId: r.user_id, accountId: r.account_id, email: r.email }));
}
