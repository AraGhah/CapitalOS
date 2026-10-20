import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPlan } from "../../app/api/track/plan/route";
import { GET as getRecord } from "../../app/api/track/record/route";
import { PlanCheckPanel, StockTrackPanel, TrackRecordPanel } from "../../app/components/TrackPanels";
import { buildEvidence } from "../../lib/ai/evidence";
import { listJournal } from "../../lib/ai/journal";
import { findCompany } from "../../lib/company";
import { resetConfig } from "../../lib/config";
import { BENCHMARK_TICKER } from "../../lib/constants";
import { pool } from "../../lib/db";
import { claim, getJobById, enqueue } from "../../lib/jobs/queue";
import { processJob } from "../../lib/jobs/worker";
import { measuredHistory, planCheckData, readTrackRecord, recordedCalls, settleDecisions } from "../../lib/track/data";
import { company } from "./db";
import { call, count, signedInUser, type TestUser } from "./helpers";

// Settling reads stored decisions and stored closes. An outside feed being asked is a failure.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SIGNAL_FEEDS;
  resetConfig();
});

// Consecutive weekdays from Monday 2026-01-05.
function weekdays(n: number): string[] {
  const out: string[] = [];
  let t = Date.parse("2026-01-05T00:00:00Z");
  while (out.length < n) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}
const DATES = weekdays(70);

async function seedBars(companyId: string, closes: number[], dates = DATES) {
  for (let i = 0; i < closes.length; i++) {
    await pool.query(`INSERT INTO prices_daily (company_id, date, open, high, low, close, volume) VALUES ($1, $2, $3, $3, $3, $3, 1000000)`, [companyId, dates[i], closes[i]]);
  }
}

// The stock climbs 1 a session from 100; the market stands still at 400.
const climbing = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);
const still = (n: number) => Array(n).fill(400);

const PLAN = { side: "enter", entry: { price: 100, kind: "market", note: "" }, stop: { price: 95 }, riskPerShare: 5, levels: [{ multiple: 1.5, price: 107.5 }, { multiple: 2, price: 110 }, { multiple: 3, price: 115 }] };

let n = 0;
async function decide(u: TestUser, companyId: string, over: { rating?: string; asOf?: string | null; plan?: unknown; createdAt?: string } = {}): Promise<string> {
  const rating = over.rating ?? "buy";
  const { rows } = await pool.query(
    `INSERT INTO decisions (user_id, company_id, rating, action, ref_price, price_as_of, inputs_hash, inputs, decision, created_at)
     VALUES ($1, $2, $3, $4, 100, $5, $6, '{}', $7, COALESCE($8::timestamptz, now())) RETURNING id`,
    [
      u.userId,
      companyId,
      rating,
      rating === "buy" ? "buy" : "hold",
      over.asOf === undefined ? DATES[0] : over.asOf,
      String(++n).padStart(64, "0"),
      JSON.stringify({
        headline: `${rating} on the figures`,
        plan: over.plan === undefined ? PLAN : over.plan,
        rating: { contributions: [{ label: "Growth", resolved: 2 }], steps: [] },
        blockers: [],
      }),
      over.createdAt ?? null,
    ]
  );
  return rows[0].id;
}

const outcomesOf = async (decisionId: string) =>
  (await pool.query(`SELECT horizon, verdict, reason, alpha, stock_return, market_return, entry_date, exit_date, path FROM decision_outcomes WHERE decision_id = $1 ORDER BY horizon`, [decisionId])).rows;

/* ------------------------------------------------------------------ settling */

describe("settleDecisions", () => {
  it("writes an outcome per horizon from the stored closes, against the S&P 500", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    const id = await decide(u, a);

    const report = await settleDecisions(u.userId);
    expect(report).toMatchObject({ considered: 1, written: 3, excluded: 0, waiting: 0 });
    expect(report.settled.map((s) => [s.ticker, s.horizon, s.verdict])).toEqual([["AAA", 5, "right"], ["AAA", 20, "right"], ["AAA", 60, "right"]]);

    const rows = await outcomesOf(id);
    expect(rows.map((r) => r.horizon)).toEqual([5, 20, 60]);
    expect(Number(rows[0].stock_return)).toBeCloseTo(0.05, 10);
    expect(Number(rows[0].market_return)).toBeCloseTo(0, 10);
    expect(Number(rows[0].alpha)).toBeCloseTo(0.05, 10);
    expect(rows[1].exit_date.toISOString().slice(0, 10)).toBe(DATES[20]);
    // the plan's stop is 95, the stock only climbed: every level on the way was touched
    expect(rows[1].path).toMatchObject({ filled: true, stopped: false, reached: [1.5, 2, 3] });
  });

  it("writes each outcome once: a second run changes nothing", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);

    await settleDecisions(null);
    const again = await settleDecisions(null);
    expect(again).toMatchObject({ considered: 0, written: 0 });
    expect(await count("decision_outcomes")).toBe(3);
  });

  it("writes each outcome once even when two runs race, and the journal hears of it once", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);

    const [x, y] = await Promise.all([settleDecisions(null), settleDecisions(null)]);
    expect(x.written + y.written).toBe(3);
    expect(await count("decision_outcomes")).toBe(3);
    expect((await listJournal(u.userId, { limit: 50 })).filter((e) => e.kind === "decision-settled")).toHaveLength(1);
  });

  it("waits for a horizon that has not closed, and writes it on a later run", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(10));
    await seedBars(await company(BENCHMARK_TICKER), still(10));
    await decide(u, a);

    const first = await settleDecisions(u.userId);
    expect(first).toMatchObject({ considered: 1, written: 1, waiting: 2 });
    expect(first.settled.map((s) => s.horizon)).toEqual([5]);

    // fifty more sessions arrive
    await seedBars(a, climbing(70).slice(10), DATES.slice(10));
    await seedBars((await findCompany(BENCHMARK_TICKER))!.id, still(70).slice(10), DATES.slice(10));
    const second = await settleDecisions(u.userId);
    expect(second).toMatchObject({ considered: 1, written: 2, waiting: 0 });
    expect(second.settled.map((s) => s.horizon)).toEqual([20, 60]);
    expect(await count("decision_outcomes")).toBe(3);
  });

  it("waits while the S&P 500 has no stored prices", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await decide(u, a);
    expect(await settleDecisions(u.userId)).toMatchObject({ considered: 1, written: 0, waiting: 3 });
    expect(await count("decision_outcomes")).toBe(0);
  });

  it("records a window with a split in it as not measurable, with the reason, and does not retry it", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await pool.query(`INSERT INTO splits (company_id, date, ratio) VALUES ($1, $2, 2)`, [a, DATES[3]]);
    const id = await decide(u, a);

    const report = await settleDecisions(u.userId);
    expect(report).toMatchObject({ written: 3, excluded: 3 });
    const rows = await outcomesOf(id);
    expect(rows.every((r) => r.verdict === "excluded" && r.alpha === null && /split/.test(r.reason))).toBe(true);
    expect(await settleDecisions(u.userId)).toMatchObject({ considered: 0, written: 0 });
  });

  it("records a decision with no price date as not measurable", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    const id = await decide(u, a, { asOf: null });
    await settleDecisions(u.userId);
    expect((await outcomesOf(id)).map((r) => r.verdict)).toEqual(["excluded", "excluded", "excluded"]);
  });

  it("grades by direction: a Sell on a stock that beat the market was wrong, and a Hold makes no call", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    const sell = await decide(u, a, { rating: "sell", plan: { side: "exit" } });
    const hold = await decide(u, a, { rating: "hold", plan: { side: "none" } });
    await settleDecisions(u.userId);
    expect((await outcomesOf(sell)).map((r) => r.verdict)).toEqual(["wrong", "wrong", "wrong"]);
    expect((await outcomesOf(hold)).map((r) => r.verdict)).toEqual(["no_claim", "no_claim", "no_claim"]);
    // neither had an entry plan to walk
    expect((await outcomesOf(sell))[0].path).toBeNull();
  });

  it("writes one journal line per measured decision, at the 20-session horizon", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    const id = await decide(u, a);
    await settleDecisions(u.userId);
    await settleDecisions(u.userId);

    const lines = (await listJournal(u.userId, { limit: 50 })).filter((e) => e.kind === "decision-settled");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ refId: id });
    expect(lines[0].title).toBe("AAA: the Buy call was right after 20 sessions");
    expect(lines[0].detail).toContain("After 20 sessions the stock was +20.0% and the S&P 500 +0.0%");
  });

  it("writes no journal line for a decision that could not be measured", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a, { asOf: null });
    await settleDecisions(u.userId);
    expect((await listJournal(u.userId, { limit: 50 })).filter((e) => e.kind === "decision-settled")).toEqual([]);
  });

  it("settles one person's decisions only when given them, and everyone's otherwise", async () => {
    const [u, v] = [await signedInUser(), await signedInUser()];
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await decide(v, a);

    expect((await settleDecisions(u.userId)).settled.every((s) => s.userId === u.userId)).toBe(true);
    expect(await count("decision_outcomes")).toBe(3);
    expect((await settleDecisions(null)).written).toBe(3);
    expect(await count("decision_outcomes")).toBe(6);
  });
});

describe("the decision_outcomes table", () => {
  async function settled() {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    const id = await decide(u, a);
    await settleDecisions(u.userId);
    return { u, a, id };
  }

  it("refuses to change an outcome once it is written", async () => {
    const { id } = await settled();
    await expect(pool.query(`UPDATE decision_outcomes SET verdict = 'wrong' WHERE decision_id = $1`, [id])).rejects.toThrow("is not updated");
    await expect(pool.query(`UPDATE decision_outcomes SET alpha = 0.5 WHERE decision_id = $1`, [id])).rejects.toThrow("is not updated");
    expect((await outcomesOf(id)).map((r) => r.verdict)).toEqual(["right", "right", "right"]);
  });

  it("refuses an excluded outcome with no reason, or a measured one with no figures", async () => {
    const { u, a, id } = await settled();
    const insert = (horizon: number, verdict: string, reason: string | null, alpha: number | null) =>
      pool.query(
        `INSERT INTO decision_outcomes (decision_id, horizon, user_id, company_id, verdict, reason, entry_date, exit_date, alpha) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
        [id, horizon, u.userId, a, verdict, reason, alpha === null ? null : DATES[0], alpha]
      );
    await expect(insert(1, "excluded", null, null)).rejects.toThrow();
    await expect(insert(2, "right", "why", 0.1)).rejects.toThrow();
    await expect(insert(3, "right", null, null)).rejects.toThrow();
    await expect(insert(4, "maybe", null, 0.1)).rejects.toThrow();
    // a well-formed row is accepted (7 is not one of the settled horizons)
    await expect(insert(7, "right", null, 0.1)).resolves.toBeDefined();
    // and a horizon is written once
    await expect(insert(7, "wrong", null, -0.1)).rejects.toThrow();
  });

  it("goes with the decision when the decision is deleted", async () => {
    const { id } = await settled();
    await pool.query(`DELETE FROM decisions WHERE id = $1`, [id]);
    expect(await count("decision_outcomes")).toBe(0);
  });
});

/* ------------------------------------------------------------------ the record */

describe("recordedCalls and readTrackRecord", () => {
  it("returns a person's decisions newest first with their outcomes, and nobody else's", async () => {
    const [u, v] = [await signedInUser(), await signedInUser()];
    const a = await company("AAA");
    const b = await company("BBB");
    await seedBars(a, climbing(70));
    await seedBars(b, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a, { createdAt: "2026-03-01T00:00:00Z" });
    await decide(u, b, { rating: "sell", plan: { side: "exit" }, createdAt: "2026-03-02T00:00:00Z" });
    await decide(v, a);
    await settleDecisions(null);

    const calls = await recordedCalls(u.userId);
    expect(calls.map((c) => [c.ticker, c.rating, c.outcomes.length])).toEqual([["BBB", "sell", 3], ["AAA", "buy", 3]]);
    expect(calls[1]).toMatchObject({ asOf: DATES[0], refPrice: 100, headline: "buy on the figures" });
    expect(calls[1].decision.rating?.contributions?.[0]).toMatchObject({ label: "Growth", resolved: 2 });
    expect(calls[1].outcomes[0]).toMatchObject({ horizon: 5, verdict: "right", entryDate: DATES[0], exitDate: DATES[5] });
    expect(calls[1].outcomes[0].path).toMatchObject({ filled: true });

    expect((await recordedCalls(u.userId, { ticker: "aaa" })).map((c) => c.ticker)).toEqual(["AAA"]);
    expect((await recordedCalls(u.userId, { companyId: b })).map((c) => c.ticker)).toEqual(["BBB"]);
    expect(await recordedCalls(u.userId, { limit: 1 })).toHaveLength(1);
    expect(await recordedCalls((await signedInUser()).userId)).toEqual([]);
  });

  it("totals the whole record, including decisions still waiting", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    // drawn before the stored prices begin: they will never reach back to it
    await decide(u, a, { asOf: "2025-12-01" });
    // drawn after the stored prices end: still waiting for its first horizon
    await decide(u, a, { asOf: DATES[69] });
    await settleDecisions(u.userId);

    const record = await readTrackRecord(u.userId);
    expect(record).toMatchObject({ decisions: 3, withOutcome: 2, awaiting: 1, excluded: 3 });
    expect(record.horizons[1].bullish).toMatchObject({ n: 1, right: 1 });
    expect(record.plan[1]).toMatchObject({ entries: 1, filled: 1, stopped: 0 });
    expect(record.calls).toHaveLength(3);
  });

  it("returns only the measured decisions on a company, for the committee's evidence", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await decide(u, a, { asOf: null });
    await settleDecisions(u.userId);
    const history = await measuredHistory(u.userId, a);
    expect(history).toHaveLength(1);
    expect(history[0].asOf).toBe(DATES[0]);
  });
});

/* ------------------------------------------------------------------ the routes */

describe("GET /api/track/record", () => {
  it("returns the signed-in person's record, uncached", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await settleDecisions(u.userId);

    const res = await call(getRecord, { cookie: u.cookie, path: "/api/track/record" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as { decisions: number; horizons: Array<{ horizon: number }>; calls: Array<{ ticker: string; reflection: string[] }> };
    expect(body.decisions).toBe(1);
    expect(body.horizons.map((h) => h.horizon)).toEqual([5, 20, 60]);
    expect(body.calls[0].ticker).toBe("AAA");
    expect(body.calls[0].reflection[0]).toContain("Buy, drawn from the 2026-01-05 close of 100.00");
  });

  it("narrows to one stock with ?ticker=, and refuses a malformed one", async () => {
    const u = await signedInUser();
    const [a, b] = [await company("AAA"), await company("BBB")];
    await decide(u, a);
    await decide(u, b);
    const one = await call(getRecord, { cookie: u.cookie, path: "/api/track/record?ticker=bbb" });
    expect((one.body as { calls: Array<{ ticker: string }> }).calls.map((c) => c.ticker)).toEqual(["BBB"]);
    expect((await call(getRecord, { cookie: u.cookie, path: "/api/track/record?ticker=not%20a%20ticker!" })).status).toBe(400);
  });

  it("does not show one person another's decisions", async () => {
    const [u, v] = [await signedInUser(), await signedInUser()];
    await decide(u, await company("AAA"));
    const res = await call(getRecord, { cookie: v.cookie, path: "/api/track/record" });
    expect((res.body as { decisions: number }).decisions).toBe(0);
  });

  it("is a 401 signed out", async () => {
    expect((await call(getRecord, { path: "/api/track/record" })).status).toBe(401);
  });
});

describe("GET /api/track/plan", () => {
  it("is unmeasured, and says what to run, when the desk has no price history", async () => {
    const u = await signedInUser();
    const res = await call(getPlan, { cookie: u.cookie, path: "/api/track/plan" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ status: "unmeasured", horizon: 20 });
    expect((res.body as { reason: string }).reason).toContain("npm run fetch-prices");
  });

  it("walks the plan over the stored history of the stocks the desk follows, leaving the S&P 500 out", async () => {
    const u = await signedInUser();
    const bars = weekdays(300);
    const wave = (phase: number) => bars.map((_, i) => 100 + 6 * Math.sin((i + phase) / 9) + i * 0.04);
    await seedBars(await company("AAA"), wave(0), bars);
    await seedBars(await company("BBB"), wave(7), bars);
    await seedBars(await company(BENCHMARK_TICKER), wave(3), bars);

    const check = await planCheckData();
    expect(check.status).toBe("measured");
    expect(check.tickers).toBe(2);
    expect(check.all.entries).toBeGreaterThan(0);
    expect(check.all.entries).toBe(check.market.entries + check.pullback.entries);

    const res = await call(getPlan, { cookie: u.cookie, path: "/api/track/plan" });
    expect((res.body as { tickers: number }).tickers).toBe(2);
  });

  it("is a 401 signed out", async () => {
    expect((await call(getPlan, { path: "/api/track/plan" })).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ the panels */

describe("the track panels", () => {
  it("render the person's record from the database", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await settleDecisions(u.userId);

    const html = renderToStaticMarkup(await TrackRecordPanel({ userId: u.userId }));
    expect(html).toContain("1 decisions");
    expect(html).toContain("20 sessions: right (+20.0%)");
    expect(html).toContain("The plan reached 1.5R, 2R and 3R without hitting its stop");
    expect(renderToStaticMarkup(await StockTrackPanel({ userId: u.userId, ticker: "AAA" }))).toContain("20 sessions: right");
    expect(renderToStaticMarkup(await StockTrackPanel({ userId: u.userId, ticker: "BBB" }))).toContain("No decision recorded on BBB yet");
    expect(renderToStaticMarkup(await PlanCheckPanel())).toContain("fetch-prices");
  });
});

/* ------------------------------------------------------------------ the committee and the job */

describe("the evidence pack", () => {
  async function pack(u: TestUser, ticker: string) {
    process.env.SIGNAL_FEEDS = "none";
    resetConfig();
    return buildEvidence((await findCompany(ticker))!, { userId: u.userId, accountId: u.accountId });
  }

  it("carries the figures of the person's measured decisions on the stock, and the same hash twice", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await settleDecisions(u.userId);

    const first = await pack(u, "AAA");
    const track = first.items.filter((i) => i.kind === "track");
    expect(track).toHaveLength(5);
    expect(track[0].label).toBe("The desk's own earlier decisions on this stock");
    // quoted at the longest horizon measured: 100 to 160 over 60 sessions, against a market that stood still
    expect(track[1]).toMatchObject({ unit: "ratio", asOf: DATES[60] });
    expect(track[1].value).toBeCloseTo(0.6, 10);
    expect(track[2].value).toBeCloseTo(0, 10);
    expect(track[3].value).toBeCloseTo(0.6, 10);
    expect(track[4].text).toMatch(/^right:/);
    // it is a numbered item the fact checker can test a model's figure against
    expect(new Set(first.items.map((i) => i.id)).size).toBe(first.items.length);
    // not an input: a stock never decided on is not missing evidence
    expect(first.coverage.inputs.map((i) => i.name).join(" ")).not.toMatch(/decision|track/i);

    expect((await pack(u, "AAA")).hash).toBe(first.hash);
  });

  it("carries nothing for a stock the person has not decided on, or for another person's decisions", async () => {
    const [u, v] = [await signedInUser(), await signedInUser()];
    const a = await company("AAA");
    await company("BBB");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);
    await settleDecisions(u.userId);

    expect((await pack(u, "BBB")).items.some((i) => i.kind === "track")).toBe(false);
    expect((await pack(v, "AAA")).items.some((i) => i.kind === "track")).toBe(false);
  });

  it("leaves a decision out until one of its horizons has been measured", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(3));
    await seedBars(await company(BENCHMARK_TICKER), still(3));
    await decide(u, a);
    await settleDecisions(u.userId);
    expect((await pack(u, "AAA")).items.some((i) => i.kind === "track")).toBe(false);
  });
});

describe("the nightly recheck job", () => {
  it("settles the decisions whose horizons have closed and reports how many", async () => {
    const u = await signedInUser();
    const a = await company("AAA");
    await seedBars(a, climbing(70));
    await seedBars(await company(BENCHMARK_TICKER), still(70));
    await decide(u, a);

    const { job } = await enqueue({ kind: "maintenance.recheck", userId: null });
    const claimed = await claim("w", ["maintenance.recheck"], 60_000);
    await processJob(claimed!, "w", 60_000);

    const done = await getJobById(job.id);
    expect(done!.status).toBe("succeeded");
    expect(done!.result).toMatchObject({ decisionsSettled: 3 });
    expect(await count("decision_outcomes")).toBe(3);
  });
});
