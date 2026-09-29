import "../lib/env";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { pool } from "../lib/db";
import { PRESETS, periodsAsOf, runBacktest } from "../lib/strategy/backtest";

/* ---------------------------------------------------------------------------
   The backtester's self-test: point-in-time fundamentals first — the one thing
   a backtest most easily gets wrong — then the preset strategies, live.

   npm run selftest-strategy
--------------------------------------------------------------------------- */

function pointInTime() {
  const f = (metric: string, periodEnd: string, value: number, knownFrom: string) => ({
    metric,
    periodEnd,
    value: new Decimal(value),
    knownFrom,
  });
  const facts = [
    f("revenue", "2023-12-31", 100, "2024-02-20"),
    f("revenue", "2024-12-31", 120, "2025-02-18"),
    f("revenue", "2023-12-31", 95, "2025-02-18"), // the 2023 figure, restated in the 2024 10-K
  ];

  // Before the 2024 10-K was filed, 2024 does not exist and 2023 is as first reported.
  const early = periodsAsOf(facts, "2025-01-31");
  assert.equal(early.length, 1);
  assert.equal(early[0].values.get("revenue")?.toNumber(), 100);

  // After it, both years exist and 2023 carries the restated figure.
  const late = periodsAsOf(facts, "2025-03-01");
  assert.deepEqual(late.map((p) => p.periodEnd), ["2024-12-31", "2023-12-31"]);
  assert.equal(late[1].values.get("revenue")?.toNumber(), 95);

  console.log("ok: figures count from their filing date, restatements from theirs");
}

async function presets() {
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  for (const spec of PRESETS) {
    const r = await runBacktest(spec);
    const s = r.stats;
    console.log(`\n${spec.name}: ${r.start} → ${r.end} (${r.sessions} sessions)`);
    console.log(
      `  return ${pct(s.totalReturn)} (CAGR ${pct(s.cagr)}) vs SPY ${pct(s.benchmarkReturn)} (${pct(s.benchmarkCagr)}) · vol ${pct(s.vol)} · sharpe ${s.sharpe?.toFixed(2)} · max DD ${pct(s.maxDrawdown)} vs ${pct(s.benchmarkDrawdown)}`
    );
    console.log(`  trades ${s.trades} · win rate ${pct(s.winRate)} · invested ${pct(s.invested)} · turnover ${s.turnover.toFixed(2)}x/yr · cost drag ${pct(s.costDrag)}/yr`);
    for (const g of r.regimes) console.log(`  ${g.regime}: ${g.days} days, strategy ${pct(g.strategy)} vs SPY ${pct(g.benchmark)}`);
    console.log(`  last rebalances: ${r.rebalances.slice(-3).map((b) => `${b.date} [${b.holdings.join(",") || "cash"}]`).join(" ")}`);

    assert.ok(r.sessions > 250);
    assert.ok(r.equity.every((e) => Number.isFinite(e.strategy) && e.strategy > 0));
    assert.ok(Math.abs(r.years.reduce((v, y) => v * (1 + y.strategy), 1) - (1 + s.totalReturn)) < 1e-9, "the years compound to the total");
  }
  console.log("\nok: presets ran, years compound to the total");
}

async function main() {
  pointInTime();
  await presets();
  console.log("\nall strategy checks passed");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
