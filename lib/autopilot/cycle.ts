import { LOCKS, pool, tryWithSessionLock } from "../db";
import type { Actor } from "../actor";
import { config } from "../config";
import { getPortfolio } from "../holdings";
import { runConsensus } from "../ai/committee";
import { availableModels } from "../ai/models";
import { addJournal } from "../ai/journal";
import {
  newFilings,
  newsSurges,
  priceAndVolume,
  riskAndRegime,
  thesisAndMemory,
  trackedCompanies,
  type AlertDraft,
} from "./triggers";

/* ---------------------------------------------------------------------------
   The autonomous loop:

     market changes → a trigger fires → an alert is written → (optionally) a
     committee researches it → theses and memory are re-checked → the portfolio
     consequence is attached → the person reviews it.

   Everything up to the committee is code and costs nothing. Convening a
   committee spends model calls, so it happens only when switched on
   (AUTOPILOT_CONVENE=1 or the checkbox on the Alerts page), only for high-
   severity alerts on companies the desk tracks, and only up to a daily cap.
--------------------------------------------------------------------------- */

export interface CycleOptions {
  convene: boolean;
}

export interface CycleSummary {
  tracked: number;
  checked: string[];
  found: number;
  created: number;
  bySeverity: Record<string, number>;
  convened: Array<{ ticker: string; runId: string; cached: boolean }>;
  skippedConvening: string | null;
  regime: string | null;
  errors: string[];
}

export class CycleBusyError extends Error {
  constructor() {
    super("another autopilot pass is still running; this one was skipped");
    this.name = "CycleBusyError";
  }
}

// One pass at a time per person across every process: a pass that convenes
// committees can outlast the schedule, and two overlapping passes would both see
// room under the daily committee cap and both spend it.
export async function runCycle(actor: Pick<Actor, "userId" | "accountId">, opts: CycleOptions): Promise<CycleSummary> {
  const summary = await tryWithSessionLock(LOCKS.autopilot(actor.userId), () => cycle(actor, opts));
  if (summary === null) throw new CycleBusyError();
  return summary;
}

async function cycle(actor: Pick<Actor, "userId" | "accountId">, opts: CycleOptions): Promise<CycleSummary> {
  const { MAX_COMMITTEES, COMMITTEE_MODE } = {
    MAX_COMMITTEES: config().AUTOPILOT_MAX_COMMITTEES,
    COMMITTEE_MODE: config().AUTOPILOT_MODE,
  };
  const { rows: started } = await pool.query(`INSERT INTO autopilot_runs (user_id) VALUES ($1) RETURNING id`, [
    actor.userId,
  ]);
  const runId = started[0].id as string;
  const errors: string[] = [];

  try {
    const tracked = await trackedCompanies(actor);

    // Weights for held names, so a move can be stated as its effect on the portfolio.
    const { holdings } = await getPortfolio(actor.accountId);
    const weightOf = new Map(holdings.map((h) => [h.ticker, h.weight.toNumber()]));
    const valueOf = new Map(holdings.map((h) => [h.ticker, h.marketValue.toNumber()]));
    for (const c of tracked) c.weight = weightOf.get(c.ticker) ?? null;

    const { rows: previous } = await pool.query(
      `SELECT summary->>'regime' AS regime FROM autopilot_runs
       WHERE user_id = $1 AND finished_at IS NOT NULL AND summary ? 'regime' ORDER BY started_at DESC LIMIT 1`,
      [actor.userId]
    );

    // Each detector is independent; one failing is reported, not fatal.
    const settle = async <T>(name: string, fn: () => Promise<T>, empty: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
        return empty;
      }
    };

    const [moves, news, filings, theses, riskRegime] = await Promise.all([
      settle("prices", () => priceAndVolume(tracked), []),
      settle("news", () => newsSurges(tracked), []),
      settle("filings", () => newFilings(tracked), []),
      settle("theses", () => thesisAndMemory(actor.userId), []),
      settle("risk", () => riskAndRegime(actor, previous[0]?.regime ?? null), { alerts: [], regime: null }),
    ]);
    const drafts: AlertDraft[] = [...theses, ...moves, ...filings, ...news, ...riskRegime.alerts];

    const created: Array<AlertDraft & { id: string }> = [];
    for (const d of drafts) {
      const impact =
        d.move !== null && d.weight !== null
          ? {
              position_weight: d.weight,
              position_move: d.move,
              portfolio_effect: d.weight * d.move,
              dollars: valueOf.has(d.ticker ?? "") ? (valueOf.get(d.ticker as string) as number) * (d.move / (1 + d.move)) : null,
            }
          : null;
      const { rows } = await pool.query(
        `INSERT INTO alerts (user_id, company_id, kind, severity, title, detail, dedupe_key, impact)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
        [actor.userId, d.companyId, d.kind, d.severity, d.title, d.detail, d.dedupeKey, impact ? JSON.stringify(impact) : null]
      );
      if (rows.length > 0) created.push({ ...d, id: rows[0].id });
    }

    // Research what matters, if allowed to spend on it.
    const convened: CycleSummary["convened"] = [];
    let skippedConvening: string | null = null;
    const worth = created.filter((a) => a.severity === "high" && a.ticker && a.companyId);

    if (!opts.convene) {
      skippedConvening = worth.length ? "convening is off — high-severity alerts wait for review" : null;
    } else if (availableModels().length === 0) {
      skippedConvening = "no model key configured";
    } else {
      const { rows: today } = await pool.query(
        // committees the autopilot actually started today; a cached report it
        // pointed an alert at was paid for on another day and does not count
        `SELECT count(DISTINCT r.id)::int AS n
         FROM alerts a JOIN consensus_runs r ON r.id = a.run_id
         WHERE a.user_id = $1 AND r.created_at >= date_trunc('day', now())`,
        [actor.userId]
      );
      let room = Math.max(0, MAX_COMMITTEES - today[0].n);
      for (const alert of worth) {
        if (room <= 0) {
          skippedConvening = `the daily cap of ${MAX_COMMITTEES} autopilot committees is reached (AUTOPILOT_MAX_COMMITTEES)`;
          break;
        }
        try {
          const result = await runConsensus({
            actor,
            ticker: alert.ticker as string,
            mode: COMMITTEE_MODE,
            focus: `What does this change for the investment case? ${alert.title}. ${alert.detail}`,
          });
          await pool.query(`UPDATE alerts SET run_id = $2 WHERE id = $1`, [alert.id, result.runId]);
          convened.push({ ticker: alert.ticker as string, runId: result.runId, cached: result.cached });
          if (!result.cached) room--;
        } catch (err) {
          errors.push(`committee on ${alert.ticker}: ${(err as Error).message}`);
        }
      }
    }

    for (const a of created.filter((x) => x.severity !== "info")) {
      await addJournal({ userId: actor.userId, companyId: a.companyId, kind: "alert", title: a.title, detail: a.detail, refId: a.id });
    }

    const summary: CycleSummary = {
      tracked: tracked.length,
      checked: ["price moves", "volume", "news surges", "filings", "theses", "committee memory", "portfolio risk", "market regime"],
      found: drafts.length,
      created: created.length,
      bySeverity: created.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.severity]: (acc[a.severity] ?? 0) + 1 }), {}),
      convened,
      skippedConvening,
      regime: riskRegime.regime,
      errors,
    };
    await pool.query(`UPDATE autopilot_runs SET finished_at = now(), summary = $2 WHERE id = $1`, [runId, JSON.stringify(summary)]);
    return summary;
  } catch (err) {
    await pool.query(`UPDATE autopilot_runs SET finished_at = now(), error = $2 WHERE id = $1`, [runId, (err as Error).message]);
    throw err;
  }
}

/* ------------------------------------------------------------------ reads */

export interface AlertRow {
  id: string;
  createdAt: string;
  ticker: string | null;
  kind: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string | null;
  impact: { position_weight: number; position_move: number; portfolio_effect: number; dollars: number | null } | null;
  runId: string | null;
  status: "new" | "seen" | "dismissed";
}

export async function listAlerts(
  userId: string,
  opts: { status?: "new" | "seen" | "dismissed"; limit?: number } = {}
): Promise<AlertRow[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.created_at, c.ticker, a.kind, a.severity, a.title, a.detail, a.impact, a.run_id, a.status
     FROM alerts a LEFT JOIN companies c ON c.id = a.company_id
     WHERE a.user_id = $1 AND ($2::text IS NULL OR a.status = $2)
     ORDER BY CASE a.severity WHEN 'high' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.created_at DESC
     LIMIT $3`,
    [userId, opts.status ?? null, opts.limit ?? 100]
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: (r.created_at as Date).toISOString(),
    ticker: r.ticker,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    impact: r.impact,
    runId: r.run_id,
    status: r.status,
  }));
}

export async function setAlertStatus(userId: string, id: string, status: "new" | "seen" | "dismissed"): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE alerts SET status = $3 WHERE id = $1 AND user_id = $2`, [id, userId, status]);
  return (rowCount ?? 0) > 0;
}

export async function recentCycles(
  userId: string,
  limit = 10
): Promise<Array<{ id: string; startedAt: string; finishedAt: string | null; summary: CycleSummary | null; error: string | null }>> {
  const { rows } = await pool.query(
    `SELECT id, started_at, finished_at, summary, error FROM autopilot_runs
     WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({
    id: String(r.id),
    startedAt: (r.started_at as Date).toISOString(),
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    summary: r.summary,
    error: r.error,
  }));
}
