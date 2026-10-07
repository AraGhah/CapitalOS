import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { LEGACY_OWNER_ID } from "../../lib/actor";
import { authenticate, AuthError, claimLegacyOwner, setPassword } from "../../lib/auth/users";
import { resolveSession, revokeSession } from "../../lib/auth/sessions";
import { signSessionCookie } from "../../lib/auth/cookie";
import { POST as login } from "../../app/api/auth/login/route";
import { POST as claim } from "../../app/api/auth/claim/route";
import { GET as me } from "../../app/api/auth/me/route";
import { call, PASSWORD, signedInUser } from "./helpers";

describe("sign-in", () => {
  it("signs in with the right password and sets an httpOnly session cookie", async () => {
    const u = await signedInUser("alice@example.com");
    const res = await call(login, { body: { email: "ALICE@example.com", password: PASSWORD } });
    expect(res.status).toBe(200);
    const setCookie = res.res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/capitalos_session=/);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(u.userId).toBeTruthy();
  });

  it("gives the same answer for an unknown address and a wrong password", async () => {
    await signedInUser("bob@example.com");
    const wrong = await call(login, { body: { email: "bob@example.com", password: "not the password" } });
    const unknown = await call(login, { body: { email: "nobody@example.com", password: "not the password" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((wrong.body as { error: string }).error).toBe((unknown.body as { error: string }).error);
  });

  it("throttles guessing after ten failures on one address", async () => {
    await signedInUser("carol@example.com");
    for (let i = 0; i < 10; i++) {
      await expect(authenticate("carol@example.com", "wrong", "10.0.0.1")).rejects.toBeInstanceOf(AuthError);
    }
    await expect(authenticate("carol@example.com", PASSWORD, "10.0.0.1")).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a forged cookie, an expired session and a revoked one", async () => {
    const u = await signedInUser();
    expect(await resolveSession(u.cookie)).not.toBeNull();
    expect(await resolveSession(u.cookie.replace(/.$/, "x"))).toBeNull();
    expect(await resolveSession(signSessionCookie("a".repeat(43), "some-other-secret-0123456789abcdef"))).toBeNull();

    await revokeSession(u.cookie);
    expect(await resolveSession(u.cookie)).toBeNull();
    expect((await call(me, { cookie: u.cookie })).status).toBe(401);

    const v = await signedInUser();
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [v.userId]);
    expect(await resolveSession(v.cookie)).toBeNull();
  });

  it("ends every session when the password changes", async () => {
    const u = await signedInUser();
    await setPassword(u.userId, "a brand new long password");
    expect(await resolveSession(u.cookie)).toBeNull();
  });

  it("refuses a disabled user", async () => {
    const u = await signedInUser();
    await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [u.userId]);
    expect(await resolveSession(u.cookie)).toBeNull();
    await expect(authenticate(u.email, PASSWORD, null)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("claiming the pre-account desk", () => {
  it("claims once from the server itself and never again", async () => {
    const first = await call(claim, { body: { email: "owner@example.com", password: PASSWORD } });
    expect(first.status).toBe(200);
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [LEGACY_OWNER_ID]);
    expect(rows[0].email).toBe("owner@example.com");
    await expect(claimLegacyOwner("thief@example.com", PASSWORD)).rejects.toMatchObject({ status: 409 });
  });

  it("needs the setup code from another host", async () => {
    const remote = await call(claim, {
      body: { email: "owner@example.com", password: PASSWORD },
      headers: { host: "desk.example.com" },
    });
    expect(remote.status).toBe(403);
  });
});
