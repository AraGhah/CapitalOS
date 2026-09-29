import { pool } from "../db";
import { latestMetrics } from "../scoring";
import { breaches, type Operator } from "../theses";
import type { RuleText } from "./roster";
import { addJournal } from "./journal";

/* ---------------------------------------------------------------------------
   AI memory.

   A committee's assumptions are kept, with the annual period they were made
   against. When a later period is filed, each one is settled by arithmetic on
   the new figure — so over time the desk can say which of its assumptions held,
   and which models made the ones that did not.
--------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ memory */

export interface MemoryRow {
  id: string;
  ticker: string;
  runId: string | null;
  createdAt: string;
  kind: "assumption" | "invalidation";
  statement: string;
  metric: string | null;
  operator: Operator | null;
  value: number | null;
  baselinePeriod: string | null;
  status: "pending" | "supported" | "refuted" | "untestable";
  checkedAt: string | null;
  checkedPeriod: string | null;
  actual: number | null;
}

export async function remember(input: {
  companyId: string;
  runId: string;
  modelId: string | null;
  baselinePeriod: string | null;
  assumptions: RuleText[];
  invalidation: RuleText[];
}): Promise<number> {
  const rows = [
    ...input.assumptions.map((r) => ({ ...r, kind: "assumption" })),
    ...input.invalidation.map((r) => ({ ...r, kind: "invalidation" })),
  ];

  for (const r of rows) {
    await pool.query(
      `INSERT INTO ai_memory (company_id, run_id, model_id, kind, statement, metric, operator, value,
                              baseline_period, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.companyId,
        input.runId,
        input.modelId,
        r.kind,
        r.text,
        r.metric,
        r.operator,
        r.value,
        input.baselinePeriod,
        // Without a rule there is nothing a filing can settle; it is kept for the
        // record but will never move out of this state.
        r.metric ? "pending" : "untestable",
      ]
    );
  }
  return rows.length;
}

export async function listMemory(opts: { companyId?: string; limit?: number } = {}): Promise<MemoryRow[]> {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, c.ticker FROM ai_memory m JOIN companies c ON c.id = m.company_id
       WHERE ($1::uuid IS NULL OR m.company_id = $1)
       ORDER BY m.created_at DESC LIMIT $2`,
      [opts.companyId ?? null, opts.limit ?? 100]
    );
    const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return rows.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      runId: r.run_id,
      createdAt: (r.created_at as Date).toISOString(),
      kind: r.kind,
      statement: r.statement,
      metric: r.metric,
      operator: r.operator,
      value: r.value === null ? null : Number(r.value),
      baselinePeriod: date(r.baseline_period),
      status: r.status,
      checkedAt: r.checked_at ? (r.checked_at as Date).toISOString() : null,
      checkedPeriod: date(r.checked_period),
      actual: r.actual === null ? null : Number(r.actual),
    }));
  } catch {
    return [];
  }
}

export interface MemoryCheck {
  checked: number;
  settled: Array<{ ticker: string; statement: string; status: "supported" | "refuted"; actual: number }>;
  waiting: number;
}

// An assumption is supported when its condition holds on the newer period. An
// invalidation rule is the opposite — its condition is the breaking condition,
// the same convention the theses table uses — so it is "refuted" (the thesis it
// guarded broke) when the condition holds.
export async function checkMemory(): Promise<MemoryCheck> {
  const { rows } = await pool.query(
    `SELECT m.id, m.company_id, c.ticker, m.kind, m.statement, m.metric, m.operator, m.value, m.baseline_period
     FROM ai_memory m JOIN companies c ON c.id = m.company_id
     WHERE m.status = 'pending' AND m.metric IS NOT NULL`
  );

  const result: MemoryCheck = { checked: rows.length, settled: [], waiting: 0 };
  const metricsByCompany = new Map<string, Awaited<ReturnType<typeof latestMetrics>>>();

  for (const row of rows) {
    let metrics = metricsByCompany.get(row.company_id);
    if (!metrics) {
      metrics = await latestMetrics(row.company_id);
      metricsByCompany.set(row.company_id, metrics);
    }

    const baseline = row.baseline_period ? (row.baseline_period as Date).toISOString().slice(0, 10) : null;
    // Only a period filed after the one the assumption was made from can settle it.
    if (!metrics.periodEnd || (baseline && metrics.periodEnd <= baseline)) {
      result.waiting++;
      continue;
    }

    const value = metrics.derived.get(row.metric) ?? metrics.raw.get(row.metric);
    if (value === undefined) {
      result.waiting++;
      continue;
    }

    const actual = value.toNumber();
    const conditionHolds = breaches(
      { metric: row.metric, operator: row.operator, value: Number(row.value) },
      actual
    );
    const status = row.kind === "assumption" ? (conditionHolds ? "supported" : "refuted") : conditionHolds ? "refuted" : "supported";

    await pool.query(
      `UPDATE ai_memory SET status = $2, checked_at = now(), checked_period = $3, actual = $4 WHERE id = $1`,
      [row.id, status, metrics.periodEnd, actual]
    );
    await addJournal({
      companyId: row.company_id,
      kind: status === "supported" ? "memory-supported" : "memory-refuted",
      title: `${row.kind === "assumption" ? "Assumption" : "Thesis condition"} ${status === "supported" ? "held" : "broke"}: ${row.statement}`,
      detail: `${row.metric} was ${Number(actual.toPrecision(4))} for the period ending ${metrics.periodEnd} (rule: ${row.operator} ${row.value}).`,
      refId: row.id,
    });

    result.settled.push({ ticker: row.ticker, statement: row.statement, status, actual });
  }

  return result;
}

// What share of each model's testable assumptions held — the long-run record
// the plan calls AI memory, graded by later filings rather than by any model.
export async function memoryRecordByModel(): Promise<Array<{ modelId: string; supported: number; refuted: number; pending: number }>> {
  try {
    const { rows } = await pool.query(
      `SELECT model_id,
              count(*) FILTER (WHERE status = 'supported')::int AS supported,
              count(*) FILTER (WHERE status = 'refuted')::int AS refuted,
              count(*) FILTER (WHERE status = 'pending')::int AS pending
       FROM ai_memory
       WHERE metric IS NOT NULL AND model_id IS NOT NULL
       GROUP BY model_id`
    );
    return rows.map((r) => ({ modelId: r.model_id, supported: r.supported, refuted: r.refuted, pending: r.pending }));
  } catch {
    return [];
  }
}
