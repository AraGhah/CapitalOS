import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { BacktestSpec } from "@/lib/http/schemas";
import { BACKTEST_METRICS, runBacktest } from "@/lib/strategy/backtest";
import type { MetricKey } from "@/lib/scanner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Every field is checked against a fixed set: a strategy arrives as data and is
// compared by arithmetic, never evaluated.
export const POST = route(async (req) => {
  const spec = await parseJson(req, BacktestSpec);
  const known = (m: string): m is MetricKey => (BACKTEST_METRICS as string[]).includes(m);
  for (const r of spec.rules) if (!known(r.metric)) throw new HttpError(400, `unknown metric ${JSON.stringify(r.metric)}`);
  if (!known(spec.rankBy)) throw new HttpError(400, "rankBy must be a metric");

  try {
    return Response.json(
      await runBacktest({
        ...spec,
        rules: spec.rules.map((r) => ({ ...r, metric: r.metric as MetricKey })),
        rankBy: spec.rankBy as MetricKey,
        universe: spec.universe?.length ? spec.universe : null,
      })
    );
  } catch (err) {
    // The backtester's own refusals ("not enough shared price history") are
    // things the person can act on.
    if (err instanceof Error && !("code" in err)) throw new HttpError(422, err.message);
    throw err;
  }
});
