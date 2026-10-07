import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { GET as getRunRoute } from "../../app/api/consensus/[id]/route";
import { GET as listTxns, POST as postTxn } from "../../app/api/transactions/route";
import { POST as voidTxn } from "../../app/api/transactions/[id]/void/route";
import { GET as listWatch } from "../../app/api/watchlist/route";
import { PATCH as patchAlert } from "../../app/api/alerts/route";
import { GET as listJournalRoute } from "../../app/api/journal/route";
import { addToWatchlist } from "../../lib/company";
import { addJournal } from "../../lib/ai/journal";
import { call, signedInUser } from "./helpers";
import { company } from "./db";

// Every per-person table: a second person must never see or change the first
// person's rows through the API, whatever ids they guess.
describe("tenant isolation (SEC-01)", () => {
  it("does not show one person's ledger to another, or let them void it", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const acme = await company("ACME");
    const { rows } = await pool.query(
      `INSERT INTO transactions (account_id, company_id, side, qty, price, fees, executed_at, created_by)
       VALUES ($1, $2, 'buy', 10, 100, 0, now(), $3) RETURNING id`,
      [alice.accountId, acme, alice.userId]
    );

    const bobView = await call(listTxns, { cookie: bob.cookie });
    expect(bobView.body).toEqual([]);
    const aliceView = await call(listTxns, { cookie: alice.cookie });
    expect(aliceView.body).toHaveLength(1);

    const attempt = await call(voidTxn, { cookie: bob.cookie, params: { id: rows[0].id }, body: { reason: "mine now" } });
    expect(attempt.status).toBe(404);
  });

  it("answers another person's committee run as not found, not forbidden", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const acme = await company("ACME");
    const { rows } = await pool.query(
      `INSERT INTO consensus_runs (user_id, company_id, mode, evidence_hash, cache_key, evidence, status)
       VALUES ($1, $2, 'fast', 'h', 'k', '{}'::jsonb, 'done') RETURNING id`,
      [alice.userId, acme]
    );
    expect((await call(getRunRoute, { cookie: bob.cookie, params: { id: rows[0].id } })).status).toBe(404);
    expect((await call(getRunRoute, { cookie: alice.cookie, params: { id: rows[0].id } })).status).toBe(200);
  });

  it("keeps watchlists, journals and alerts apart", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const acme = await company("ACME");
    await addToWatchlist(alice.userId, acme, "mine");
    await addJournal({ userId: alice.userId, companyId: acme, kind: "note", title: "private" });
    const { rows } = await pool.query(
      `INSERT INTO alerts (user_id, kind, severity, title, dedupe_key) VALUES ($1, 'x', 'info', 't', 'k') RETURNING id`,
      [alice.userId]
    );

    expect((await call(listWatch, { cookie: bob.cookie })).body).toEqual([]);
    expect((await call(listJournalRoute, { cookie: bob.cookie })).body).toEqual({ entries: [] });
    const patched = await call(patchAlert, {
      method: "PATCH",
      cookie: bob.cookie,
      body: { id: rows[0].id, status: "dismissed" },
    });
    expect(patched.status).toBe(404);
    const { rows: still } = await pool.query(`SELECT status FROM alerts WHERE id = $1`, [rows[0].id]);
    expect(still[0].status).toBe("new");
  });

  it("refuses every API call without a session", async () => {
    expect((await call(listTxns)).status).toBe(401);
    expect((await call(postTxn, { body: { ticker: "ACME" } })).status).toBe(401);
  });

  it("validates input before touching anything", async () => {
    const alice = await signedInUser();
    const res = await call(postTxn, {
      cookie: alice.cookie,
      body: { ticker: "acme!", side: "hold", qty: "1e999", price: "abc", executedAt: "yesterday" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_input");
  });
});
