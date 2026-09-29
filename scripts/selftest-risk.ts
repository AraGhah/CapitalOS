import "../lib/env";
import assert from "node:assert/strict";
import { pool } from "../lib/db";
import {
  beta,
  concentration,
  correlation,
  correlationClusters,
  covarianceMatrix,
  historicalVaR,
  maxDrawdown,
  riskContributions,
} from "../lib/risk/stats";
import { applyScenario } from "../lib/risk/scenarios";
import { analyzeRisk, parseBasket } from "../lib/risk/engine";

/* ---------------------------------------------------------------------------
   The risk engine's self-test: the arithmetic on hand-made series, then one
   live analysis of a basket (Yahoo prices, no model calls, nothing written).

   npm run selftest-risk ["NVDA:30,AMD:20,MSFT:50"]
--------------------------------------------------------------------------- */

function unit() {
  const a = [0.01, -0.02, 0.015, 0.005, -0.01];
  const doubled = a.map((x) => 2 * x);

  assert.ok(Math.abs((beta(doubled, a) ?? 0) - 2) < 1e-12, "beta of 2x a series is 2");
  assert.ok(Math.abs((correlation(doubled, a) ?? 0) - 1) < 1e-12);
  assert.ok(Math.abs(maxDrawdown([0.1, -0.5, 0.2]) - -0.5) < 1e-12);
  assert.equal(historicalVaR([0.01]), null, "too few days for a VaR");

  const shares = riskContributions([0.5, 0.5], covarianceMatrix([a, doubled]));
  assert.ok(Math.abs(shares[0] + shares[1] - 1) < 1e-12, "risk shares sum to one");
  assert.ok(shares[1] > shares[0], "the more volatile half carries more risk");

  assert.deepEqual(concentration([0.25, 0.25, 0.25, 0.25]), { hhi: 0.25, effectiveN: 4 });
  assert.deepEqual(
    correlationClusters(["A", "B", "C"], [[1, 0.9, 0.1], [0.9, 1, 0.2], [0.1, 0.2, 1]], 0.7),
    [["A", "B"]]
  );

  const scenario = applyScenario(
    [
      { ticker: "X", weight: 0.6, marketValue: 600, betas: { semis: 1.5 }, r2: { semis: 0.8 } },
      { ticker: "Y", weight: 0.4, marketValue: 400, betas: { semis: null }, r2: { semis: null } },
    ],
    "semis",
    -0.3
  );
  assert.ok(Math.abs(scenario.impact - -0.27) < 1e-12);
  assert.ok(Math.abs((scenario.dollars ?? 0) - -270) < 1e-9);
  assert.deepEqual(scenario.unmeasured, ["Y"]);

  const parsed = parseBasket("nvda:30, AMD:20 MSFT, bad!ticker");
  assert.deepEqual(parsed.lines.map((l) => l.ticker), ["NVDA", "AMD", "MSFT"]);
  assert.ok(Math.abs(parsed.lines[0].weight - 30 / 51) < 1e-12);
  assert.equal(parsed.errors.length, 1);

  console.log("ok: beta, correlation, drawdown, VaR, risk shares, concentration, clusters, scenarios, basket parsing");
}

async function live(text: string) {
  const report = await analyzeRisk({ kind: "custom", text });
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

  console.log(`\n${report.label}: ${text}`);
  console.log(`window ${report.window?.start} → ${report.window?.end} (${report.window?.sessions} sessions)`);
  console.log(
    `vol ${pct(report.portfolio.vol)} · beta ${report.portfolio.beta?.toFixed(2)} · max drawdown ${pct(report.portfolio.maxDrawdown)} · VaR95 ${pct(report.portfolio.var95)} · sharpe ${report.portfolio.sharpe?.toFixed(2)}`
  );
  console.log(`1y ${pct(report.portfolio.return1y)} vs SPY ${pct(report.portfolio.benchmarkReturn1y)} · avg corr ${report.portfolio.avgCorrelation?.toFixed(2)} · effective N ${report.portfolio.effectiveN.toFixed(1)}`);
  for (const p of report.positions) {
    console.log(`  ${p.ticker.padEnd(6)} w ${pct(p.weight)} risk ${pct(p.riskShare)} vol ${pct(p.vol)} beta ${p.beta?.toFixed(2)} day ${pct(p.dayChange)}`);
  }
  for (const f of report.factors) console.log(`  factor ${f.id.padEnd(9)} beta ${f.portfolioBeta?.toFixed(2) ?? "—"} explained ${pct(f.explained)}`);
  for (const f of report.findings) console.log(`  [${f.severity}] ${f.text}`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);

  const semis = applyScenario(report.exposures, "semis", -0.3);
  console.log(`  scenario semis −30% → ${pct(semis.impact)} (explained ${pct(semis.explained)})`);

  assert.ok(report.positions.length > 0, "the basket was measured");
  const shareSum = report.positions.reduce((s, p) => s + (p.riskShare ?? 0), 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, "risk shares sum to one");
  console.log("ok: live analysis");
}

async function main() {
  unit();
  await live(process.argv[2] ?? "NVDA:30,AMD:20,MSFT:30,XOM:20");
  console.log("\nall risk checks passed");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
