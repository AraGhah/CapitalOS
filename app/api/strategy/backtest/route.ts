import type { NextRequest } from "next/server";
import { BACKTEST_METRICS, runBacktest, type Rebalance, type StrategySpec } from "@/lib/strategy/backtest";
import type { MetricKey, Op } from "@/lib/scanner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OPS: Op[] = [">=", "<=", ">", "<"];
const REBALANCE: Rebalance[] = ["monthly", "quarterly", "annual"];

// Every field is checked against a fixed set: a strategy arrives as data and is
// compared by arithmetic, never evaluated.
function parseSpec(body: Record<string, unknown>): StrategySpec | string {
  const metric = (m: unknown): m is MetricKey => typeof m === "string" && (BACKTEST_METRICS as string[]).includes(m);
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

  const rules = Array.isArray(body.rules) ? body.rules : [];
  for (const r of rules) {
    const rule = r as Record<string, unknown>;
    if (!metric(rule.metric)) return `unknown metric ${JSON.stringify(rule.metric)}`;
    if (!OPS.includes(rule.op as Op)) return `unknown comparison ${JSON.stringify(rule.op)}`;
    if (typeof rule.value !== "number" || !Number.isFinite(rule.value)) return "every rule needs a numeric value";
  }
  if (!metric(body.rankBy)) return "rankBy must be a metric";
  if (!num(body.maxPositions, 1, 10)) return "maxPositions must be 1 to 10";
  if (!REBALANCE.includes(body.rebalance as Rebalance)) return "rebalance must be monthly, quarterly or annual";
  if (!num(body.costBps, 0, 200) || !num(body.slippageBps, 0, 200)) return "costs must be 0 to 200 basis points";
  if (!num(body.years, 1, 10)) return "years must be 1 to 10";

  const universe = Array.isArray(body.universe)
    ? body.universe.filter((t): t is string => typeof t === "string" && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(t))
    : null;

  return {
    name: typeof body.name === "string" ? body.name.slice(0, 120) : "Custom strategy",
    rules: rules.map((r) => r as StrategySpec["rules"][number]),
    rankBy: body.rankBy as MetricKey,
    rankDescending: body.rankDescending !== false,
    maxPositions: Math.round(body.maxPositions as number),
    rebalance: body.rebalance as Rebalance,
    costBps: body.costBps as number,
    slippageBps: body.slippageBps as number,
    years: Math.round(body.years as number),
    universe: universe?.length ? universe : null,
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const spec = parseSpec(body);
  if (typeof spec === "string") return Response.json({ error: spec }, { status: 400 });

  try {
    return Response.json(await runBacktest(spec));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "the backtest failed" }, { status: 422 });
  }
}
