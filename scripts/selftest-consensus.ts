import "../lib/env";
import { LEGACY_ACCOUNT_ID, LEGACY_OWNER_ID } from "../lib/actor";

const OWNER = { userId: LEGACY_OWNER_ID, accountId: LEGACY_ACCOUNT_ID };
import assert from "node:assert/strict";
import { pool } from "../lib/db";
import { resolveCompany } from "../lib/resolve";
import { buildEvidence, priceStats, renderEvidence, type EvidencePack } from "../lib/ai/evidence";
import { checkClaim, extractFigures, unsupportedFigures } from "../lib/ai/factcheck";
import { agreementOf, confidenceOf, dimensionConsensus } from "../lib/ai/consensus";
import { runConsensus, type RunEvent } from "../lib/ai/committee";
import { getRun } from "../lib/ai/store";
import type { ModelRequest, ModelResult } from "../lib/ai/providers";
import type { ModelSpec } from "../lib/ai/models";

/* ---------------------------------------------------------------------------
   The consensus engine's self-test. No model is called: the arithmetic is
   tested directly, and one whole committee run is driven by scripted replies
   against the real evidence pack for a stored company, then removed again.

   npm run selftest-consensus [TICKER] [--keep]

   --keep leaves the scripted run in place so its report page can be looked at;
   it is labelled as scripted in its question, and deleting it removes it all.
--------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const ticker = (args.find((a) => !a.startsWith("--")) ?? "MSFT").toUpperCase();
const FOCUS = keep ? "SCRIPTED SELF-TEST — not a real committee. Is the valuation justified?" : "Is the valuation justified?";

function section(name: string) {
  console.log(`\n— ${name}`);
}

/* ------------------------------------------------------------ unit checks */

function unitChecks() {
  section("figure extraction");
  const figures = extractFigures("Revenue rose 15.7% to $281.7B, trading at 34.2x with 3 segments since 2019 (E4, 10-K).");
  assert.deepEqual(figures.map((f) => f.raw), ["15.7%", "$281.7B", "34.2x"]);
  assert.equal(extractFigures("COVID-19 and the A100 launch in FY2025 Q3").length, 0);
  console.log("ok: units parsed, labels and small counts ignored");

  const pack: EvidencePack = {
    ticker: "TEST",
    name: "Test",
    sector: null,
    industry: null,
    generatedAt: new Date().toISOString(),
    periodEnd: "2025-06-30",
    coverage: { inputs: [], present: 0, expected: 0 },
    hash: "x",
    items: [
      { id: "E1", kind: "fundamental", label: "Revenue", value: 281_724_000_000, unit: "usd", source: { kind: "filing", ref: "10-K" } },
      { id: "E2", kind: "metric", label: "Revenue growth", value: 0.1493, unit: "ratio", source: { kind: "computed", ref: "x" } },
      { id: "E3", kind: "metric", label: "Gross margin", value: 0.6882, unit: "ratio", source: { kind: "computed", ref: "x" } },
      { id: "E4", kind: "valuation", label: "P/E", value: 36.41, unit: "multiple", source: { kind: "computed", ref: "x" } },
      { id: "E5", kind: "headline", label: "Headline", text: "\"Azure demand accelerates\"", source: { kind: "news", ref: "x" } },
    ],
  };

  const claim = (text: string, evidence: string[]) => checkClaim({ key: "T", text, evidence, agent: "t", modelId: "t", stage: "t" }, pack);

  section("claim checks");
  assert.equal(claim("Revenue was $281.7B, up 15%.", ["E1", "E2"]).verdict, "verified");
  assert.equal(claim("Revenue was $281,724 million.", ["E1"]).verdict, "verified");
  assert.equal(claim("Gross margin is 68.8%.", ["E1"]).verdict, "miscited");
  assert.equal(claim("Operating margin reached 91.5%.", ["E3"]).verdict, "unsupported");
  assert.equal(claim("The stock trades at 36.4x earnings.", ["E4"]).verdict, "verified");
  assert.equal(claim("Cloud demand is accelerating.", ["E5"]).verdict, "sourced");
  assert.equal(claim("Cloud demand is accelerating.", ["E99"]).verdict, "unsupported");
  assert.equal(claim("Management is excellent.", []).verdict, "unsourced");
  assert.deepEqual(unsupportedFigures("Margins of 68.8% and growth of 40%", pack), ["40%"]);
  console.log("ok: verified, miscited, unsupported, sourced and unsourced all land where they should");

  section("agreement and confidence");
  assert.equal(agreementOf([1, 1, 1]), 1);
  assert.equal(agreementOf([2, -2]), 0);
  assert.equal(agreementOf([1]), null);
  const dims = dimensionConsensus([
    { seat: "A", modelId: "a", dimensions: { valuation: { score: 1 }, growth: { score: 2 } } },
    { seat: "B", modelId: "b", dimensions: { valuation: { score: -2 }, growth: { score: 2 } } },
  ]);
  const valuation = dims.find((d) => d.key === "valuation")!;
  const growth = dims.find((d) => d.key === "growth")!;
  assert.equal(valuation.contested, true);
  assert.equal(growth.contested, false);
  assert.equal(growth.label2, "strong");
  const conf = confidenceOf({
    dimensions: dims,
    checks: { total: 4, verified: 3, sourced: 1, miscited: 0, unsupported: 0, contradicted: 0, unsourced: 0, accuracy: 1, evidenceRate: 1 },
    coverage: { inputs: [{ name: "x", present: true }], present: 1, expected: 1 },
    seats: 1,
    degraded: [],
  });
  assert.ok(conf.score <= 0.58, "a single seat is capped");
  console.log(`ok: contested valuation detected, single-seat confidence capped at ${conf.label}`);

  section("price statistics");
  const closes = Array.from({ length: 300 }, (_, i) => ({ date: `d${i}`, close: 100 + i }));
  const stats = priceStats(closes);
  assert.ok(Math.abs((stats.return1m ?? 0) - (399 / 378 - 1)) < 1e-9);
  assert.equal(stats.maxDrawdown, 0);
  assert.equal(stats.high, 399);
  console.log("ok: returns, high and drawdown");
}

/* ------------------------------------------------------ scripted committee */

function line(evidence: string, pattern: RegExp): { id: string; shown: string } | null {
  for (const l of evidence.split("\n")) {
    if (!pattern.test(l)) continue;
    const id = l.match(/^\[(E\d+)\]/)?.[1];
    const shown = l.match(/= (\S+)/)?.[1];
    if (id && shown) return { id, shown };
  }
  return null;
}

function scripted(): (spec: ModelSpec, req: ModelRequest) => Promise<ModelResult> {
  let analystCount = 0;

  return async (spec, req) => {
    const ev = req.evidence;
    const revenue = line(ev, /^\[E\d+\] Revenue, fiscal year/);
    const margin = line(ev, /^\[E\d+\] Gross margin \(/);
    const headline = ev.split("\n").find((l) => /^\[E\d+\] Headline/.test(l))?.match(/^\[(E\d+)\]/)?.[1];
    const role = req.instructions.match(/^ROLE: (.+)$/m)?.[1] ?? "";
    let body: unknown;

    const claims = [
      revenue && { text: `Revenue was ${revenue.shown} in the latest fiscal year.`, evidence: [revenue.id] },
      margin && { text: "Operating margin reached 91.5%.", evidence: [margin.id] },
      margin && revenue && { text: `Gross margin was ${margin.shown}.`, evidence: [revenue.id] },
      headline && { text: "Recent coverage discusses the company's product demand.", evidence: [headline] },
    ].filter(Boolean);

    if (role === "Independent equity analyst") {
      const n = analystCount++;
      body = {
        summary: `Scripted analyst ${n}. The business is strong but valuation is debated.`,
        dimensions: {
          business_quality: { score: 2, reason: "scripted", evidence: [] },
          growth: { score: 1, reason: "scripted", evidence: [] },
          valuation: { score: [1, -2, 0, 2][n % 4], reason: `scripted view ${n}`, evidence: [] },
          macro: { score: null, reason: "not enough evidence", evidence: [] },
        },
        claims,
        bull: ["scripted bull"],
        bear: ["scripted bear"],
        risks: [{ text: "Scripted competition risk", severity: "medium", evidence: [] }],
        catalysts: ["scripted catalyst"],
        assumptions: [{ text: "Growth stays above 10%", metric: "revenue_growth", operator: ">=", value: 0.1 }],
        thesis: "Scripted thesis.",
      };
    } else if (["Financial statement analyst", "Valuation specialist", "Industry and competition analyst", "Macro strategist", "News and sentiment analyst", "Risk officer"].includes(role)) {
      body = { summary: `Scripted ${role}.`, dimensions: { growth: { score: 1, reason: "x", evidence: [] }, valuation: { score: -1, reason: "x" } }, claims: claims.slice(0, 1), risks: [{ text: "Scripted risk", severity: "high" }], thesis: "x" };
    } else if (role === "Bull advocate" || role === "Bear advocate") {
      body = { arguments: claims.slice(0, 2).map((c) => ({ ...(c as object), strength: 2 })), strongest: "scripted", concession: "scripted" };
    } else if (role === "Challenger") {
      body = { challenges: [{ target: "valuation", question: "What growth does the price imply?", why: "scripted", evidence: [] }], priced_in: "scripted", blind_spot: "scripted" };
    } else if (role === "Fact checker") {
      const ids = [...req.user.matchAll(/^(\w+): /gm)].map((m) => m[1]);
      body = { checks: ids.map((id, i) => ({ id, verdict: i === 0 ? "contradicted" : "supported", reason: "scripted" })) };
    } else if (role === "Judge") {
      body = {
        claims: [{ id: "A1", verdict: "weak", reason: "scripted" }],
        dimensions: { valuation: { score: 0, contested: true, note: "scripted" } },
        disagreements: [{ topic: "Valuation", sides: ["cheap", "expensive"], why_it_matters: "x", would_resolve: "y" }],
        analyst_grades: { A: { logic: 8, financial_reasoning: 7, risk_awareness: 6, completeness: 7, assumptions: 5, uncertainty: 6 } },
        critical_uncertainty: "scripted",
      };
    } else if (role === "Synthesizer") {
      const revision = req.user.includes("YOUR DRAFT");
      body = {
        headline: revision ? "Strong franchise, contested price" : "Revenue of $999B makes it unstoppable",
        thesis: "Scripted thesis.",
        cases: { bull: "b", base: "m", bear: "r" },
        claims: claims.slice(0, 1),
        risks: [{ text: "Scripted risk", severity: "high", evidence: [] }],
        catalysts: [],
        primary_disagreement: "valuation",
        critical_uncertainty: "demand",
        assumptions: [{ text: "Growth stays above 10%", metric: "revenue_growth", operator: ">=", value: 0.1 }],
        invalidation: [{ text: "Gross margin below 60%", metric: "gross_margin", operator: "<", value: 0.6 }, { text: "No rule here" }],
        monitor: ["gross_margin"],
      };
    } else {
      throw new Error(`the script has no reply for role "${role}"`);
    }

    return { text: "```json\n" + JSON.stringify(body) + "\n```", inputTokens: 1000, outputTokens: 200, cachedTokens: 800, cacheWriteTokens: 0, latencyMs: 5, costUsd: 0.01, costEstimated: spec.priceIn === null };
  };
}

async function committeeRun() {
  section(`evidence pack for ${ticker}`);
  const company = await resolveCompany(ticker);
  const pack = await buildEvidence(company, OWNER);
  const kinds = pack.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  console.log(`${pack.items.length} items`, kinds);
  console.log(`coverage ${pack.coverage.present}/${pack.coverage.expected}; period ${pack.periodEnd}`);
  console.log(renderEvidence(pack).split("\n").slice(0, 14).join("\n"));
  assert.ok(pack.items.length > 5);

  section("scripted investment committee");
  const events: RunEvent[] = [];
  const { runId, cached } = await runConsensus(
    { actor: OWNER, ticker, mode: "committee", focus: FOCUS, force: true, caller: scripted() },
    (e) => events.push(e)
  );
  assert.equal(cached, false);

  try {
    const run = await getRun(OWNER.userId, runId);
    assert.ok(run?.report, "the report was stored");
    const report = run.report;

    console.log(`phases: ${events.filter((e) => e.type === "phase" && e.status === "done").map((e) => (e as { phase: string }).phase).join(" → ")}`);
    console.log(`calls: ${report.cost.calls} (${run.calls.length} in the ledger), tokens in/out/cached ${report.cost.inputTokens}/${report.cost.outputTokens}/${report.cost.cachedTokens}`);
    console.log(`checks:`, report.checks);
    console.log(`confidence: ${report.confidence.label} ${report.confidence.score.toFixed(3)}`);
    for (const r of report.confidence.reasons) console.log(`  ${r.ok ? "✓" : "⚠"} ${r.text}`);
    console.log(`valuation: agreement ${report.dimensions.find((d) => d.key === "valuation")?.agreement?.toFixed(2)}, contested ${report.dimensions.find((d) => d.key === "valuation")?.contested}`);
    console.log(`headline after revision: "${report.synthesis?.headline}"`);

    assert.equal(report.mode, "committee");
    assert.ok(report.checks.unsupported > 0, "the planted 91.5% figure failed");
    assert.ok(report.checks.miscited > 0, "the planted miscitation was caught");
    assert.ok(report.checks.contradicted > 0, "the model checker's ruling was applied");
    assert.equal(report.synthesis?.headline, "Strong franchise, contested price", "the synthesizer was sent back and revised");
    assert.deepEqual(report.unverifiedFigures, []);
    assert.equal(report.adoptableRules.length, 1, "only the complete rule is adoptable");
    assert.ok(report.dimensions.find((d) => d.key === "valuation")?.contested);
    assert.ok(report.claims.some((c) => c.judge?.verdict === "weak"), "the judge's ruling reached the claim");
    assert.ok(run.calls.some((c) => c.agent === "Synthesizer (revision)"));
    assert.equal(report.specialists.length, 6);

    const { rows: evals } = await pool.query(`SELECT count(*)::int AS n FROM model_evaluations WHERE run_id = $1`, [runId]);
    const { rows: mem } = await pool.query(`SELECT count(*)::int AS n FROM ai_memory WHERE run_id = $1`, [runId]);
    assert.ok(evals[0].n > 0);
    assert.equal(mem[0].n, 3, "one assumption, two invalidation conditions (one untestable)");
    console.log(`ok: ${evals[0].n} evaluations, ${mem[0].n} memories, report assembled`);

    const again = await runConsensus({ actor: OWNER, ticker, mode: "committee", focus: FOCUS, caller: scripted() });
    assert.equal(again.runId, runId, "identical evidence is served from the cache");
    console.log("ok: a second identical run hit the cache");
  } finally {
    if (keep) {
      console.log(`kept scripted run ${runId} — open /committee/${runId}`);
      return;
    }
    // The self-test leaves nothing behind in the ledger, the memory or the journal.
    await pool.query(`DELETE FROM ai_memory WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM decision_journal WHERE ref_id = $1`, [runId]);
    await pool.query(`DELETE FROM consensus_runs WHERE id = $1`, [runId]);
  }
}

async function main() {
  unitChecks();
  await committeeRun();
  console.log("\nall consensus checks passed");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
