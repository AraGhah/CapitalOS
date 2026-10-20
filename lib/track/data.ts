import { addJournal } from "../ai/journal";
import { BENCHMARK_TICKER } from "../constants";
import { pool } from "../db";
import { RATING_LABEL, type DecisionRating } from "../decision/rating";
import { getSplits } from "../splits";
import type { OhlcvBar } from "../technicals";
import { planCheck, PLAN_CHECK_RULES, type PlanCheck, type PlanCheckSeries } from "./plan-check";
import type { PathBar, PathResult } from "./paths";
import { outcomeLine, type StoredDecision } from "./reflect";
import { trackRecord, type RecordedCall, type TrackRecord } from "./record";
import { SETTLE_RULES, settleAt, type Close, type Outcome } from "./settle";

/* ---------------------------------------------------------------------------
   Gathers what the track record reads, and writes the outcomes the settling
   produces. The measuring itself is in settle.ts, paths.ts and record.ts and
   touches no database; this reads stored decisions and stored closes only. No
   outside feed and no model is asked.
--------------------------------------------------------------------------- */

const ISO = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ settling */

export interface SettleReport {
  // decisions with at least one horizon not yet written
  considered: number;
  // outcome rows written this time
  written: number;
  // of those, the ones recorded as not fairly measurable
  excluded: number;
  // horizons that have not closed yet
  waiting: number;
  settled: Array<{ userId: string; ticker: string; decisionId: string; horizon: number; verdict: Outcome["verdict"] }>;
}

// Writes the outcome of every recorded decision whose horizon has closed and
// has no outcome yet. Idempotent: a horizon is written once and never again, so
// running it every night, or twice at once, changes nothing the second time.
// With a userId it settles that person's decisions; without, everyone's.
export async function settleDecisions(userId: string | null = null): Promise<SettleReport> {
  const report: SettleReport = { considered: 0, written: 0, excluded: 0, waiting: 0, settled: [] };
  const horizons = SETTLE_RULES.horizons;

  const { rows: decisions } = await pool.query(
    `SELECT d.id, d.user_id, d.company_id, c.ticker, d.rating, d.price_as_of, d.decision->'plan' AS plan
     FROM decisions d JOIN companies c ON c.id = d.company_id
     WHERE ($1::uuid IS NULL OR d.user_id = $1)
       AND (SELECT count(*) FROM decision_outcomes o WHERE o.decision_id = d.id) < $2
     ORDER BY d.created_at`,
    [userId, horizons.length]
  );
  report.considered = decisions.length;
  if (decisions.length === 0) return report;

  const done = new Map<string, Set<number>>();
  const { rows: existing } = await pool.query(`SELECT decision_id, horizon FROM decision_outcomes WHERE decision_id = ANY($1)`, [decisions.map((d) => d.id)]);
  for (const r of existing) done.set(r.decision_id, (done.get(r.decision_id) ?? new Set()).add(r.horizon));

  const companyIds = [...new Set(decisions.map((d) => d.company_id as string))];
  const earliest = decisions.reduce<string | null>((min, d) => {
    const asOf = d.price_as_of ? ISO(d.price_as_of as Date) : null;
    return asOf !== null && (min === null || asOf < min) ? asOf : min;
  }, null);
  const since = earliest ?? ISO(new Date());

  const benchmark = await pool.query(`SELECT id FROM companies WHERE ticker = $1`, [BENCHMARK_TICKER]);
  const benchmarkId = (benchmark.rows[0]?.id as string | undefined) ?? null;
  const prices = await pool.query(
    `SELECT company_id, date, open, high, low, close FROM prices_daily
     WHERE company_id = ANY($1) AND date >= ($2::date - 10) AND close IS NOT NULL
     ORDER BY company_id, date`,
    [benchmarkId ? [...companyIds, benchmarkId] : companyIds, since]
  );
  const barsOf = new Map<string, PathBar[]>();
  for (const p of prices.rows) {
    const list = barsOf.get(p.company_id) ?? [];
    list.push({ date: ISO(p.date as Date), open: num(p.open), high: num(p.high), low: num(p.low), close: Number(p.close) });
    barsOf.set(p.company_id, list);
  }
  const market: Close[] = (benchmarkId ? (barsOf.get(benchmarkId) ?? []) : []).map((b) => ({ date: b.date, close: b.close }));
  const splitDates = new Map<string, string[]>();
  for (const [id, list] of await getSplits(companyIds)) splitDates.set(id, list.map((s) => s.date));

  for (const d of decisions) {
    const have = done.get(d.id) ?? new Set<number>();
    for (const horizon of horizons) {
      if (have.has(horizon)) continue;
      const outcome = settleAt({
        decision: { rating: d.rating as DecisionRating, asOf: d.price_as_of ? ISO(d.price_as_of as Date) : null, plan: d.plan },
        horizon,
        bars: barsOf.get(d.company_id) ?? [],
        market,
        splits: splitDates.get(d.company_id) ?? [],
      });
      if (outcome === null) {
        report.waiting += 1;
        continue;
      }

      const inserted = await pool.query(
        `INSERT INTO decision_outcomes (decision_id, horizon, user_id, company_id, verdict, reason, entry_date, entry_close, exit_date, exit_close,
                                        stock_return, market_return, alpha, path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (decision_id, horizon) DO NOTHING`,
        [
          d.id, horizon, d.user_id, d.company_id, outcome.verdict, outcome.reason, outcome.entryDate, outcome.entryClose, outcome.exitDate, outcome.exitClose,
          outcome.stockReturn, outcome.marketReturn, outcome.alpha, outcome.path === null ? null : JSON.stringify(outcome.path),
        ]
      );
      if ((inserted.rowCount ?? 0) === 0) continue;

      report.written += 1;
      if (outcome.verdict === "excluded") report.excluded += 1;
      report.settled.push({ userId: d.user_id, ticker: d.ticker, decisionId: d.id, horizon, verdict: outcome.verdict });

      // One journal line per decision: the primary horizon, when it could be measured.
      if (horizon === SETTLE_RULES.primaryHorizon && outcome.verdict !== "excluded") {
        await addJournal({
          userId: d.user_id,
          companyId: d.company_id,
          kind: "decision-settled",
          title: `${d.ticker}: the ${RATING_LABEL[d.rating as DecisionRating]} call ${outcome.verdict === "no_claim" ? "has been measured" : outcome.verdict === "flat" ? "was too close to call" : `was ${outcome.verdict}`} after ${horizon} sessions`,
          detail: outcomeLine(outcome),
          refId: d.id,
        });
      }
    }
  }
  return report;
}

/* -------------------------------------------------------------- the record */

const outcomeOf = (r: Record<string, unknown>): Outcome => ({
  horizon: r.horizon as number,
  verdict: r.verdict as Outcome["verdict"],
  reason: (r.reason as string | null) ?? null,
  entryDate: r.entry_date ? ISO(r.entry_date as Date) : null,
  entryClose: num(r.entry_close),
  exitDate: r.exit_date ? ISO(r.exit_date as Date) : null,
  exitClose: num(r.exit_close),
  stockReturn: num(r.stock_return),
  marketReturn: num(r.market_return),
  alpha: num(r.alpha),
  path: (r.path as PathResult | null) ?? null,
});

// The most recent recorded decisions of one person, each with the outcomes
// written for it so far. Only the parts of the stored decision the reflection
// reads are fetched.
export async function recordedCalls(userId: string, opts: { companyId?: string; ticker?: string; limit?: number } = {}): Promise<RecordedCall[]> {
  const { rows } = await pool.query(
    `SELECT d.id, c.ticker, d.created_at, d.price_as_of, d.rating, d.action, d.ref_price,
            d.decision->>'headline' AS headline,
            jsonb_build_object('rating', jsonb_build_object('contributions', d.decision->'rating'->'contributions', 'steps', d.decision->'rating'->'steps'),
                               'blockers', d.decision->'blockers') AS stored
     FROM decisions d JOIN companies c ON c.id = d.company_id
     WHERE d.user_id = $1
       AND ($2::uuid IS NULL OR d.company_id = $2)
       AND ($3::text IS NULL OR c.ticker = upper($3))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $4`,
    [userId, opts.companyId ?? null, opts.ticker ?? null, Math.min(opts.limit ?? 200, 500)]
  );
  if (rows.length === 0) return [];

  const { rows: outcomeRows } = await pool.query(
    `SELECT decision_id, horizon, verdict, reason, entry_date, entry_close, exit_date, exit_close, stock_return, market_return, alpha, path
     FROM decision_outcomes WHERE decision_id = ANY($1) ORDER BY horizon`,
    [rows.map((r) => r.id)]
  );
  const outcomes = new Map<string, Outcome[]>();
  for (const r of outcomeRows) outcomes.set(r.decision_id, [...(outcomes.get(r.decision_id) ?? []), outcomeOf(r)]);

  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    createdAt: (r.created_at as Date).toISOString(),
    asOf: r.price_as_of ? ISO(r.price_as_of as Date) : null,
    rating: r.rating,
    action: r.action,
    refPrice: num(r.ref_price),
    headline: r.headline ?? "",
    decision: (r.stored ?? {}) as StoredDecision,
    outcomes: outcomes.get(r.id) ?? [],
  }));
}

export async function readTrackRecord(userId: string, opts: { ticker?: string } = {}): Promise<TrackRecord> {
  // The cap, so the totals cover every decision and not just the newest page.
  return trackRecord(await recordedCalls(userId, { ticker: opts.ticker, limit: 500 }));
}

// A person's earlier decisions on one company that have been measured, newest
// first: what the committee's evidence pack carries forward.
export async function measuredHistory(userId: string, companyId: string, limit = 3): Promise<RecordedCall[]> {
  const calls = await recordedCalls(userId, { companyId, limit: 25 });
  return calls.filter((c) => c.outcomes.some((o) => o.verdict !== "excluded")).slice(0, limit);
}

/* ------------------------------------------------------------- the plan check */

const MAX_STOCKS = 40;
const LOOKBACK_DAYS = 1900;

export async function planCheckData(): Promise<PlanCheck> {
  const needed = PLAN_CHECK_RULES.warmup + PLAN_CHECK_RULES.horizon + 1;
  const { rows: stocks } = await pool.query(
    `SELECT c.id, c.ticker, count(*)::int AS n
     FROM prices_daily p JOIN companies c ON c.id = p.company_id
     WHERE c.ticker <> $1 AND p.close IS NOT NULL AND p.date >= current_date - $2::int
     GROUP BY c.id, c.ticker HAVING count(*) >= $3
     ORDER BY n DESC, c.ticker LIMIT $4`,
    [BENCHMARK_TICKER, LOOKBACK_DAYS, needed, MAX_STOCKS]
  );

  const series: PlanCheckSeries[] = [];
  if (stocks.length > 0) {
    const { rows } = await pool.query(
      `SELECT company_id, date, open, high, low, close, volume FROM prices_daily
       WHERE company_id = ANY($1) AND close IS NOT NULL AND date >= current_date - $2::int
       ORDER BY company_id, date`,
      [stocks.map((s) => s.id), LOOKBACK_DAYS]
    );
    const barsOf = new Map<string, OhlcvBar[]>();
    for (const r of rows) {
      const list = barsOf.get(r.company_id) ?? [];
      list.push({ date: ISO(r.date as Date), open: num(r.open), high: num(r.high), low: num(r.low), close: Number(r.close), volume: num(r.volume) });
      barsOf.set(r.company_id, list);
    }
    const splits = await getSplits(stocks.map((s) => s.id));
    for (const s of stocks) {
      series.push({ ticker: s.ticker, bars: barsOf.get(s.id) ?? [], splits: (splits.get(s.id) ?? []).map((x) => x.date) });
    }
  }
  return planCheck(series);
}
