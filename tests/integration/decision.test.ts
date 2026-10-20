import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getDecisionRoute, POST as postDecisionRoute } from "../../app/api/consensus/[id]/decision/route";
import { GET as listDecisionsRoute } from "../../app/api/decisions/route";
import { DIMENSIONS } from "../../lib/ai/roster";
import { listJournal } from "../../lib/ai/journal";
import { createRun, finishRun } from "../../lib/ai/store";
import type { ConsensusReport } from "../../lib/ai/report";
import { pool } from "../../lib/db";
import { decideForRun } from "../../lib/decision/data";
import { getDecision, listDecisions, recordDecision } from "../../lib/decision/store";
import { recordTransaction } from "../../lib/ledger";
import { saveProfile } from "../../lib/profile";
import { call, count, signedInUser, type TestUser } from "./helpers";
import { company } from "./db";

beforeEach(() => {
  // no market-data provider: the desk's own stored bars are what the decision reads
  vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 260 daily bars ending today, drifting up with a wobble.
async function seedPrices(companyId: string) {
  const day = 86_400_000;
  for (let i = 259; i >= 0; i--) {
    const close = 100 + (259 - i) * 0.3 + Math.sin(i / 6) * 2;
    const date = new Date(Date.now() - i * day).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO prices_daily (company_id, date, open, high, low, close, volume) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, date, close - 0.2, close + 1, close - 1, close, 1_000_000 + i * 1000]
    );
  }
}

function reportFor(ticker: string, score: number): ConsensusReport {
  return {
    version: 1,
    ticker,
    name: `${ticker} Inc`,
    mode: "standard",
    focus: null,
    analysts: [],
    specialists: [],
    dimensions: DIMENSIONS.map((d) => ({
      key: d.key,
      label: d.label,
      votes: [],
      mean: score,
      agreement: 1,
      resolved: score,
      rating: score >= 1.25 ? "strong" : "mixed",
      label2: "x",
      contested: false,
      note: null,
    })),
    synthesis: null,
    synthesisBy: null,
    unverifiedFigures: [],
    claims: [],
    debate: { bull: null, bear: null },
    challenger: null,
    disagreements: [],
    criticalUncertainty: null,
    checks: { total: 0, verified: 0, sourced: 0, miscited: 0, unsupported: 0, contradicted: 0, unsourced: 0, accuracy: null, evidenceRate: null },
    confidence: { score: 0.8, label: "High", reasons: [], parts: { agreement: 1, accuracy: 1, evidence: 1, coverage: 1 } },
    scorecards: [],
    adoptableRules: [],
    coverage: { inputs: [], present: 0, expected: 0 },
    cost: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, unpriced: 0, seconds: 0 },
    degraded: [],
  };
}

async function finishedRun(user: TestUser, ticker: string, score = 2): Promise<{ runId: string; companyId: string }> {
  const companyId = await company(ticker);
  const runId = await createRun({
    userId: user.userId,
    companyId,
    mode: "standard",
    focus: null,
    cacheKey: `test-${ticker}-${score}-${Math.random()}`,
    models: [],
    evidence: {
      ticker,
      name: `${ticker} Inc`,
      sector: "Technology",
      industry: null,
      generatedAt: new Date().toISOString(),
      periodEnd: null,
      items: [],
      coverage: { inputs: [], present: 0, expected: 0 },
      hash: `hash-${ticker}`,
    },
  });
  await finishRun(runId, reportFor(ticker, score));
  return { runId, companyId };
}

describe("deciding on a finished committee", () => {
  it("rates, plans and sizes it from the report, the person's profile and the stored prices", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });

    const { decision, input, hash } = await decideForRun(u, runId);

    expect(decision.rating.final).toBe("buy");
    expect(decision.action).toBe("buy");
    expect(decision.plan.entry?.price).toBeGreaterThan(0);
    expect(decision.plan.stop?.price).toBeLessThan(decision.plan.entry!.price);
    // the checklist has unanswered questions, so the size is halved from the 8% cap (8,000) at most
    expect(decision.checklist?.level).toBe("incomplete");
    expect(decision.sizing.capital).toBe(100_000);
    expect(decision.sizing.multipliers.map((m) => m.name)).toContain("checklist");
    expect(decision.sizing.targetValue).toBeLessThanOrEqual(4_000 + 1e-6);
    expect(decision.sizing.shares).toBeGreaterThan(0);
    expect(decision.currency).toEqual({ listing: "USD", base: "USD", fxToBase: 1 });
    expect(input.portfolio).toMatchObject({ heldQty: 0, heldValue: 0 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("will not buy for a person whose own answers say they are not ready", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    // money needed within three years fails the checklist's horizon question, which is about the person
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium", horizonYears: 1, objective: "house" });

    const { decision } = await decideForRun(u, runId);

    expect(decision.rating.final).toBe("buy");
    expect(decision.checklist?.level).toBe("not_ready");
    expect(decision.action).toBe("avoid");
    expect(decision.blockers.length).toBeGreaterThan(0);
    expect(decision.sizing.shares).toBe(0);
  });

  it("is the same decision, with the same digest, when nothing has changed", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000 });

    const a = await decideForRun(u, runId);
    const b = await decideForRun(u, runId);
    expect(b.hash).toBe(a.hash);
    expect(b.decision).toEqual(a.decision);
  });

  it("is a 404 for someone else's run, and a 409 for one that has not finished", async () => {
    const owner = await signedInUser();
    const other = await signedInUser();
    const { runId } = await finishedRun(owner, "DCSN");
    await expect(decideForRun(other, runId)).rejects.toMatchObject({ status: 404 });

    const companyId = await company("RUNN");
    const running = await createRun({
      userId: owner.userId,
      companyId,
      mode: "fast",
      focus: null,
      cacheKey: "running",
      models: [],
      evidence: { ticker: "RUNN", name: "RUNN Inc", sector: null, industry: null, generatedAt: "", periodEnd: null, items: [], coverage: { inputs: [], present: 0, expected: 0 }, hash: "h" },
    });
    await expect(decideForRun(owner, running)).rejects.toMatchObject({ status: 409 });
  });
});

describe("the risk debate on a real portfolio", () => {
  // The same seeded closes for every company, so a holding moves exactly with the stock under review, and a
  // different sector, so only the risk debate (not the sector cap) can see that the two behave as one bet.
  async function holdingCorrelatedWith(u: TestUser, ticker: string, shares: number) {
    const heldId = await company(ticker, { sector: "Energy" });
    await seedPrices(heldId);
    await recordTransaction(u, {
      companyId: heldId,
      ticker,
      side: "buy",
      qty: new Decimal(shares),
      price: new Decimal(100),
      fees: new Decimal(0),
      executedAt: new Date(Date.now() - 200 * 86_400_000),
    });
  }

  it("reads the holdings' prices, argues the purchase against them, and the seats split on the overlap", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DBTE");
    await seedPrices(companyId);
    // about 71,000 of a stock that moves exactly with DBTE, and 100,000 set aside: capital about 171,000
    await holdingCorrelatedWith(u, "HELD", 400);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });

    const { decision, input } = await decideForRun(u, runId);

    expect(input.book?.status).toBe("measured");
    const debate = decision.riskDebate;
    expect(debate).not.toBeNull();
    expect(debate?.measured).toBe(true);
    expect(debate?.window?.sessions).toBeGreaterThan(200);
    expect(debate?.deciding).toBe("neutral");
    // HELD is about 41% of capital and moves with the stock (correlation 1): the conservative and neutral
    // seats' bars (25%, 35%) leave no room, the aggressive seat's (50%) does
    expect(debate?.seats.map((s) => s.stance)).toEqual(["reject", "reject", "approve"]);
    const overlap = debate?.seats[1].tests.find((t) => t.key === "overlap");
    expect(overlap?.status).toBe("over");
    expect(overlap?.note).toContain("HELD (1.00) moves with it");
    // the person's seat is the neutral one, so the purchase is turned away, and the reason is stated
    expect(decision.action).toBe("avoid");
    expect(decision.blockers.join(" ")).toContain("the neutral risk seat");
    expect(decision.plan.side).toBe("none");
    expect(decision.sizing.shares).toBe(0);
  });

  it("is a purchase for someone whose tolerance matches the aggressive seat", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DBTE");
    await seedPrices(companyId);
    await holdingCorrelatedWith(u, "HELD", 400);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "high" });

    const { decision } = await decideForRun(u, runId);

    expect(decision.riskDebate?.deciding).toBe("aggressive");
    expect(decision.riskDebate?.stance).toBe("approve");
    expect(decision.action).toBe("buy");
    expect(decision.sizing.shares).toBeGreaterThan(0);
  });

  it("keeps the arguments with the recorded decision, and the returns they were made on", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DBTE");
    await seedPrices(companyId);
    await holdingCorrelatedWith(u, "HELD", 400);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });

    const gathered = await decideForRun(u, runId);
    const saved = await recordDecision(u, gathered);
    const stored = await getDecision(u.userId, saved.id);

    expect(stored?.decision.riskDebate?.seats).toHaveLength(3);
    expect(stored?.decision).toEqual(JSON.parse(JSON.stringify(gathered.decision)));
    expect(stored?.input.book).toMatchObject({ status: "measured", others: [{ ticker: "HELD" }] });
  });

  it("prices in a stock with no price history instead of passing it", async () => {
    const u = await signedInUser();
    const { runId } = await finishedRun(u, "NOBR");
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });

    const { decision, input } = await decideForRun(u, runId);

    expect(input.book).toEqual({ status: "unmeasured", reason: "no price history could be loaded for NOBR" });
    // with no price there is no plan to size, so there is nothing to debate; the gap is still on the record
    expect(decision.action).toBe("watch");
    expect(decision.riskDebate).toBeNull();
  });

  it("does not read the portfolio's prices for a decision that is not a purchase", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DBTE", -2);
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000 });

    const { decision, input } = await decideForRun(u, runId);

    expect(decision.rating.final).toBe("sell");
    expect(input.book).toBeNull();
    expect(decision.riskDebate).toBeNull();
  });
});

describe("recording a decision", () => {
  it("keeps the decision with its inputs and price, once per set of inputs", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });

    const gathered = await decideForRun(u, runId);
    const first = await recordDecision(u, gathered);
    const again = await recordDecision(u, await decideForRun(u, runId));
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(await count("decisions")).toBe(1);

    const [row] = await listDecisions(u.userId, { ticker: "dcsn" });
    expect(row).toMatchObject({ id: first.id, ticker: "DCSN", runId, rating: "buy", action: "buy" });
    expect(row.refPrice).toBeCloseTo(gathered.decision.plan.reference as number, 6);
    expect(row.headline).toBe(gathered.decision.headline);

    const stored = await getDecision(u.userId, first.id);
    expect(stored?.decision).toEqual(JSON.parse(JSON.stringify(gathered.decision)));
    expect(stored?.input.runId).toBe(runId);

    const journal = await listJournal(u.userId, { companyId });
    expect(journal.map((j) => j.kind)).toContain("decision");
    const { rows: audits } = await pool.query(`SELECT user_id FROM audit_log WHERE action = 'decision.record'`);
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(u.userId);
  });

  it("records a new row when the inputs change", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });
    await recordDecision(u, await decideForRun(u, runId));

    await saveProfile(u, { riskTolerance: "low" });
    const second = await recordDecision(u, await decideForRun(u, runId));

    expect(second.duplicate).toBe(false);
    expect(await count("decisions")).toBe(2);
    expect((await listDecisions(u.userId)).length).toBe(2);
  });

  it("keeps one person's decisions from another", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { runId, companyId } = await finishedRun(a, "DCSN");
    await seedPrices(companyId);
    await saveProfile(a, { investableAmount: 100_000 });
    const saved = await recordDecision(a, await decideForRun(a, runId));

    expect(await listDecisions(b.userId)).toEqual([]);
    expect(await getDecision(b.userId, saved.id)).toBeNull();
    expect(await getDecision(a.userId, "not-a-uuid")).toBeNull();
  });

  it("survives the deletion of the committee run it came from", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000 });
    await recordDecision(u, await decideForRun(u, runId));

    await pool.query(`DELETE FROM consensus_runs WHERE id = $1`, [runId]);

    const [row] = await listDecisions(u.userId);
    expect(row.runId).toBeNull();
    expect(row.ticker).toBe("DCSN");
  });
});

describe("the decision routes", () => {
  it("computes on GET without writing, records on POST, and lists what was recorded", async () => {
    const u = await signedInUser();
    const { runId, companyId } = await finishedRun(u, "DCSN");
    await seedPrices(companyId);
    await saveProfile(u, { investableAmount: 100_000, riskTolerance: "medium" });
    const path = `/api/consensus/${runId}/decision`;

    const got = await call(getDecisionRoute, { cookie: u.cookie, params: { id: runId }, path });
    expect(got.status).toBe(200);
    expect((got.body as { decision: { action: string } }).decision.action).toBe("buy");
    expect(await count("decisions")).toBe(0);

    const first = await call(postDecisionRoute, { method: "POST", cookie: u.cookie, params: { id: runId }, path });
    expect(first.status).toBe(201);
    expect(await count("decisions")).toBe(1);

    const second = await call(postDecisionRoute, { method: "POST", cookie: u.cookie, params: { id: runId }, path });
    expect(second.status).toBe(200);
    expect((second.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(await count("decisions")).toBe(1);

    const list = await call(listDecisionsRoute, { cookie: u.cookie, path: "/api/decisions?ticker=DCSN" });
    expect(list.status).toBe(200);
    expect((list.body as { decisions: unknown[] }).decisions).toHaveLength(1);
    const none = await call(listDecisionsRoute, { cookie: u.cookie, path: "/api/decisions?ticker=ZZZZ" });
    expect((none.body as { decisions: unknown[] }).decisions).toEqual([]);
  });

  it("answers 404 for a run that is not yours, and 401 without signing in", async () => {
    const owner = await signedInUser();
    const other = await signedInUser();
    const { runId } = await finishedRun(owner, "DCSN");
    const path = `/api/consensus/${runId}/decision`;

    expect((await call(getDecisionRoute, { cookie: other.cookie, params: { id: runId }, path })).status).toBe(404);
    expect((await call(postDecisionRoute, { method: "POST", cookie: other.cookie, params: { id: runId }, path })).status).toBe(404);
    expect((await call(getDecisionRoute, { params: { id: runId }, path })).status).toBe(401);
    expect((await call(listDecisionsRoute, { path: "/api/decisions" })).status).toBe(401);
  });
});
