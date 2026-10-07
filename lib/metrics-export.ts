import { pool } from "./db";

/* ---------------------------------------------------------------------------
   Business and system metrics for Prometheus, read from the tables that
   already record them — the job queue, the model-call ledger, the ingest
   tables — so there is no second set of counters to drift from the truth.
--------------------------------------------------------------------------- */

type Sample = { name: string; help: string; type: "gauge" | "counter"; values: Array<{ labels?: Record<string, string>; value: number }> };

function render(samples: Sample[]): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const lines: string[] = [];
  for (const s of samples) {
    lines.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`);
    for (const v of s.values) {
      const labels = v.labels && Object.keys(v.labels).length
        ? `{${Object.entries(v.labels).map(([k, val]) => `${k}="${esc(val)}"`).join(",")}}`
        : "";
      lines.push(`${s.name}${labels} ${Number.isFinite(v.value) ? v.value : 0}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function collectMetrics(): Promise<string> {
  const [jobs, oldestQueued, workers, calls, spend, freshness, users] = await Promise.all([
    pool.query(`SELECT kind, status, count(*)::int AS n FROM jobs GROUP BY kind, status`),
    pool.query(`SELECT kind, EXTRACT(EPOCH FROM now() - min(run_at))::float AS age FROM jobs WHERE status = 'queued' AND run_at <= now() GROUP BY kind`),
    pool.query(`SELECT count(*)::int AS n FROM workers WHERE seen_at > now() - interval '1 minute'`),
    pool.query(
      `SELECT provider, stage, count(*)::int AS calls, count(*) FILTER (WHERE error IS NOT NULL)::int AS failures,
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p95
       FROM model_calls WHERE created_at > now() - interval '1 hour' GROUP BY provider, stage`
    ),
    pool.query(`SELECT COALESCE(sum(cost_usd), 0)::float AS usd FROM model_calls WHERE created_at >= date_trunc('day', now())`),
    pool.query(
      `SELECT 'prices' AS feed, EXTRACT(EPOCH FROM now() - max(date)::timestamptz)::float AS age FROM prices_daily
       UNION ALL SELECT 'filings', EXTRACT(EPOCH FROM now() - max(filed_at)::timestamptz)::float FROM filings
       UNION ALL SELECT 'headlines', EXTRACT(EPOCH FROM now() - max(retrieved_at))::float FROM headlines`
    ),
    pool.query(`SELECT count(*)::int AS n FROM users WHERE disabled_at IS NULL`),
  ]);

  return render([
    {
      name: "capitalos_jobs",
      help: "Jobs by kind and status",
      type: "gauge",
      values: jobs.rows.map((r) => ({ labels: { kind: r.kind, status: r.status }, value: r.n })),
    },
    {
      name: "capitalos_queue_oldest_seconds",
      help: "Age of the oldest job waiting to run, by kind",
      type: "gauge",
      values: oldestQueued.rows.map((r) => ({ labels: { kind: r.kind }, value: r.age })),
    },
    { name: "capitalos_workers_alive", help: "Workers that sent a heartbeat in the last minute", type: "gauge", values: [{ value: workers.rows[0].n }] },
    {
      name: "capitalos_model_calls_last_hour",
      help: "Model calls in the last hour by provider and stage",
      type: "gauge",
      values: calls.rows.map((r) => ({ labels: { provider: r.provider, stage: r.stage }, value: r.calls })),
    },
    {
      name: "capitalos_model_call_failures_last_hour",
      help: "Failed model calls in the last hour",
      type: "gauge",
      values: calls.rows.map((r) => ({ labels: { provider: r.provider, stage: r.stage }, value: r.failures })),
    },
    {
      name: "capitalos_model_call_latency_p95_ms",
      help: "95th percentile model call latency over the last hour",
      type: "gauge",
      values: calls.rows.map((r) => ({ labels: { provider: r.provider, stage: r.stage }, value: r.p95 })),
    },
    { name: "capitalos_model_spend_today_usd", help: "Metered model spend since midnight", type: "gauge", values: [{ value: spend.rows[0].usd }] },
    {
      name: "capitalos_data_age_seconds",
      help: "Time since the newest stored row, by feed",
      type: "gauge",
      values: freshness.rows.map((r) => ({ labels: { feed: r.feed }, value: r.age ?? 0 })),
    },
    { name: "capitalos_active_users", help: "Users not disabled", type: "gauge", values: [{ value: users.rows[0].n }] },
  ]);
}
