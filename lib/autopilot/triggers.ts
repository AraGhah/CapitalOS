import { createHash } from "node:crypto";
import { pool } from "../db";
import type { Actor } from "../actor";
import { loadBars } from "../market/bars";
import { marketOverview } from "../market/overview";
import { analyzeRisk } from "../risk/engine";
import { checkOpenTheses } from "../theses";
import { checkMemory } from "../ai/memory";
import { mean, simpleReturns, stdev } from "../risk/stats";

/* ---------------------------------------------------------------------------
   What the autopilot watches for. Each trigger is a threshold on a computed
   number, and each alert says which number crossed it — so an alert can be
   checked, and the same market always raises the same alerts.
--------------------------------------------------------------------------- */

export interface AlertDraft {
  companyId: string | null;
  ticker: string | null;
  kind: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
  dedupeKey: string;
  held: boolean;
  weight: number | null;
  move: number | null;
}

export interface Tracked {
  id: string;
  ticker: string;
  held: boolean;
  weight: number | null;
}

// Held positions and the watchlist: the companies the desk is responsible for.
export async function trackedCompanies(actor: Pick<Actor, "userId" | "accountId">): Promise<Tracked[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.ticker,
            EXISTS (SELECT 1 FROM transactions t
                    WHERE t.company_id = c.id AND t.account_id = $1 AND t.voided_at IS NULL) AS held
     FROM companies c
     WHERE EXISTS (SELECT 1 FROM transactions t
                   WHERE t.company_id = c.id AND t.account_id = $1 AND t.voided_at IS NULL)
        OR EXISTS (SELECT 1 FROM watchlist w WHERE w.company_id = c.id AND w.user_id = $2)
     ORDER BY c.ticker`,
    [actor.accountId, actor.userId]
  );
  return rows.map((r) => ({ id: r.id, ticker: r.ticker, held: r.held, weight: null }));
}

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;

/* ------------------------------------------------------ price and volume */

// A move is unusual against the stock's own history: at least 5%, and at
// least three of its own daily standard deviations.
const MIN_MOVE = 0.05;
const SIGMAS = 3;
const VOLUME_MULTIPLE = 2.5;
const STALE_BARS_DAYS = 5;

export async function priceAndVolume(tracked: Tracked[]): Promise<AlertDraft[]> {
  const out: AlertDraft[] = [];
  for (const c of tracked) {
    const loaded = await loadBars(c.ticker);
    if (!loaded || loaded.bars.length < 30) continue;
    const bars = loaded.bars;
    const last = bars[bars.length - 1];
    // With the provider down the bars come from the table, which may end days ago; an
    // old move is not news and must not be raised as today's alert.
    if (Date.now() - Date.parse(last.date) > STALE_BARS_DAYS * 86_400_000) continue;
    const returns = simpleReturns(bars.map((b) => b.close));
    const move = returns[returns.length - 1];
    const history = returns.slice(0, -1);
    const sigma = stdev(history);
    const zscore = sigma > 0 ? move / sigma : 0;

    if (Math.abs(move) >= MIN_MOVE && Math.abs(zscore) >= SIGMAS) {
      const asLarge = history.filter((r) => Math.abs(r) >= Math.abs(move)).length;
      out.push({
        companyId: c.id,
        ticker: c.ticker,
        kind: "price-move",
        severity: c.held ? "high" : "warn",
        title: `${c.ticker} ${move < 0 ? "fell" : "rose"} ${pct(move).slice(1)} on ${last.date}`,
        detail: `A ${Math.abs(zscore).toFixed(1)}σ day against its own year of daily moves; ${asLarge} of the previous ${history.length} sessions moved as much.`,
        dedupeKey: `move:${c.ticker}:${last.date}`,
        held: c.held,
        weight: c.weight,
        move,
      });
    }

    const recent = bars.slice(-21, -1).map((b) => b.volume).filter((v): v is number => v !== null && v > 0);
    if (last.volume && recent.length >= 15) {
      const avg = mean(recent);
      const multiple = last.volume / avg;
      if (multiple >= VOLUME_MULTIPLE) {
        out.push({
          companyId: c.id,
          ticker: c.ticker,
          kind: "unusual-volume",
          severity: "info",
          title: `${c.ticker} traded ${multiple.toFixed(1)}× its usual volume on ${last.date}`,
          detail: `${last.volume.toLocaleString("en-US")} shares against a 20-day average of ${Math.round(avg).toLocaleString("en-US")}; the price moved ${pct(move)}.`,
          dedupeKey: `volume:${c.ticker}:${last.date}`,
          held: c.held,
          weight: c.weight,
          move,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ news */

// A news surge: at least ten headlines in a day and three times the daily
// average of the week before.
export async function newsSurges(tracked: Tracked[]): Promise<AlertDraft[]> {
  if (tracked.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT company_id,
            count(*) FILTER (WHERE published_at >= now() - interval '1 day')::int AS today,
            count(*) FILTER (WHERE published_at < now() - interval '1 day'
                               AND published_at >= now() - interval '8 days')::int AS week
     FROM headlines WHERE company_id = ANY($1) GROUP BY company_id`,
    [tracked.map((c) => c.id)]
  );
  const date = new Date().toISOString().slice(0, 10);
  return rows
    .filter((r) => r.today >= 10 && r.today >= 3 * Math.max(1, r.week / 7))
    .map((r) => {
      const c = tracked.find((t) => t.id === r.company_id) as Tracked;
      return {
        companyId: c.id,
        ticker: c.ticker,
        kind: "news-surge",
        severity: "warn" as const,
        title: `${c.ticker}: ${r.today} headlines in a day`,
        detail: `Against ${(r.week / 7).toFixed(1)} a day over the previous week. Something is being reported — the wire on its research page has them.`,
        dedupeKey: `news:${c.ticker}:${date}`,
        held: c.held,
        weight: c.weight,
        move: null,
      };
    });
}

/* --------------------------------------------------------------- filings */

export async function newFilings(tracked: Tracked[]): Promise<AlertDraft[]> {
  if (tracked.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT f.company_id, f.accession, f.form_type, f.filed_at, f.url
     FROM filings f WHERE f.company_id = ANY($1) AND f.filed_at >= current_date - 3`,
    [tracked.map((c) => c.id)]
  );
  return rows.map((r) => {
    const c = tracked.find((t) => t.id === r.company_id) as Tracked;
    const periodic = /^10-[KQ]/.test(r.form_type);
    return {
      companyId: c.id,
      ticker: c.ticker,
      kind: "filing",
      severity: periodic ? ("warn" as const) : ("info" as const),
      title: `${c.ticker} filed a ${r.form_type} on ${(r.filed_at as Date).toISOString().slice(0, 10)}`,
      detail: periodic
        ? "New reported figures: theses and remembered assumptions are re-checked against them on this pass."
        : `A current report. ${r.url ?? ""}`.trim(),
      dedupeKey: `filing:${r.accession}`,
      held: c.held,
      weight: c.weight,
      move: null,
    };
  });
}

/* ------------------------------------------------------- theses, memory */

export async function thesisAndMemory(userId: string): Promise<AlertDraft[]> {
  const out: AlertDraft[] = [];
  const theses = await checkOpenTheses(userId);
  const byTicker = new Map<string, typeof theses.invalidated>();
  for (const b of theses.invalidated) byTicker.set(b.ticker, [...(byTicker.get(b.ticker) ?? []), b]);

  for (const [ticker, breaches] of byTicker) {
    const { rows } = await pool.query(`SELECT id FROM companies WHERE ticker = $1`, [ticker]);
    out.push({
      companyId: rows[0]?.id ?? null,
      ticker,
      kind: "thesis-broken",
      severity: "high",
      title: `The thesis on ${ticker} no longer holds`,
      detail: breaches.map((b) => `${b.rule.metric} is ${Number(b.actual.toPrecision(4))} (rule: ${b.rule.operator} ${b.rule.value})`).join("; "),
      // keyed by the theses that broke, so a second thesis with the same rules still alerts
      dedupeKey: `thesis:${ticker}:${[...new Set(breaches.map((b) => b.thesisId))].sort().join(",")}`,
      held: false,
      weight: null,
      move: null,
    });
  }

  const memory = await checkMemory(userId);
  for (const s of memory?.settled ?? []) {
    if (s.status !== "refuted") continue;
    const { rows } = await pool.query(`SELECT id FROM companies WHERE ticker = $1`, [s.ticker]);
    out.push({
      companyId: rows[0]?.id ?? null,
      ticker: s.ticker,
      kind: "assumption-broke",
      severity: "warn",
      title: `A committee assumption on ${s.ticker} broke`,
      detail: `${s.statement} — the newer filing shows ${Number(s.actual.toPrecision(4))}.`,
      dedupeKey: `memory:${s.ticker}:${createHash("sha1").update(s.statement).digest("hex").slice(0, 12)}`,
      held: false,
      weight: null,
      move: null,
    });
  }
  return out;
}

/* ------------------------------------------------------- risk and regime */

export async function riskAndRegime(
  actor: Pick<Actor, "userId" | "accountId">,
  previousRegime: string | null
): Promise<{ alerts: AlertDraft[]; regime: string | null }> {
  const out: AlertDraft[] = [];
  const week = isoWeek(new Date());

  try {
    const risk = await analyzeRisk(actor, { kind: "holdings" });
    for (const f of risk.findings.filter((x) => x.severity === "high")) {
      out.push({
        companyId: null,
        ticker: null,
        kind: "portfolio-risk",
        severity: "warn",
        title: "Portfolio risk threshold crossed",
        detail: f.text,
        // weekly, so a standing concentration is a reminder rather than noise
        dedupeKey: `risk:${week}:${createHash("sha1").update(f.text.replace(/[\d.]+%?/g, "#")).digest("hex").slice(0, 12)}`,
        held: true,
        weight: null,
        move: null,
      });
    }
  } catch {
    // no positions or no prices — nothing to say
  }

  let regime: string | null = null;
  try {
    const o = await marketOverview();
    regime = o.regime.label;
    if (previousRegime && previousRegime !== regime) {
      out.push({
        companyId: null,
        ticker: null,
        kind: "regime-change",
        severity: "warn",
        title: `Market regime changed: ${previousRegime} → ${regime}`,
        detail: `${o.regime.on} risk-on signals, ${o.regime.off} risk-off, ${o.regime.neutral} neutral. ${o.signals
          .filter((s) => s.stance !== "neutral")
          .map((s) => `${s.name}: ${s.reading}`)
          .join("; ")}.`,
        dedupeKey: `regime:${regime}:${new Date().toISOString().slice(0, 10)}`,
        held: false,
        weight: null,
        move: null,
      });
    }
  } catch {
    // market data unreachable this pass
  }

  return { alerts: out, regime };
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
}
