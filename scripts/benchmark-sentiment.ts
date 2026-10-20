import "../lib/env";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";
import { findUserByEmail } from "../lib/auth/users";
import { hasModel, modelName } from "../lib/llm";
import { tagTitlesWithModel } from "../lib/agents";
import { DEV, HELD_OUT, type Gold } from "../lib/sentiment/gold";
import { LABELS, evaluate, explain, majorityAccuracy, parseGold, runBenchmark, type BenchmarkResult } from "../lib/sentiment/benchmark";
import { readHeadline } from "../lib/sentiment/lexicon";
import type { Sentiment } from "../lib/sentiment";

// How well the headline taggers agree with a careful reader, on labelled
// headlines kept in the repository. Free and deterministic: no model is called
// unless --model is given.
//
//   npm run benchmark-sentiment                      the rules and the old word list, on both sets
//   npm run benchmark-sentiment -- --gold=mine.json  your own labelled headlines
//   npm run benchmark-sentiment -- --misses          list every headline the rules got wrong
//   npm run benchmark-sentiment -- --model --user=you@example.com [--all]
//                                                    also score the configured model (costs requests; see below)
//
// --model sends the held-out set (120 headlines) to the same labelling prompt
// the analyst uses, 40 to a request: 3 requests, or 9 with --all (the
// development set as well, 360 headlines). They are metered against --user's
// daily spend like any other model call.

const BATCH = 40;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const pct = (n: number | null) => (n === null ? "  –  " : `${(n * 100).toFixed(1).padStart(5)}%`);

function print(result: BenchmarkResult, majority: number) {
  const [lo, hi] = result.interval;
  console.log(`\n${result.name}`);
  console.log(`  accuracy ${pct(result.accuracy)}  (95% interval ${pct(lo)} – ${pct(hi)}, n = ${result.n}; always saying the commonest label scores ${pct(majority)})`);
  console.log(`  macro F1 ${pct(result.macroF1)}   weighted F1 ${pct(result.weightedF1)}`);
  console.log("  class     precision  recall     F1   support");
  for (const l of LABELS) {
    const c = result.perClass[l];
    console.log(`  ${l.padEnd(9)} ${pct(c.precision)}   ${pct(c.recall)} ${pct(c.f1)}   ${String(c.support).padStart(4)}`);
  }
  console.log("  confusion (rows: what the reader said; columns: what the tagger said)");
  console.log(`  ${"".padEnd(9)} ${LABELS.map((l) => l.padStart(8)).join(" ")}`);
  for (const e of LABELS) console.log(`  ${e.padEnd(9)} ${LABELS.map((g) => String(result.confusion[e][g]).padStart(8)).join(" ")}`);
  console.log(`  by kind   ${result.byKind.map((k) => `${k.kind} ${(k.accuracy * 100).toFixed(0)}% (${k.n})`).join(", ")}`);
}

function printMisses(result: BenchmarkResult) {
  if (result.misses.length === 0) return;
  console.log(`\n  ${result.misses.length} missed:`);
  for (const m of result.misses) console.log(`   - [${m.expected} → ${m.got}] ${m.title}${m.why ? `\n       ${m.why}` : ""}`);
}

async function modelLabels(gold: Gold[], userId: string): Promise<Sentiment[]> {
  const labels: Sentiment[] = [];
  for (let i = 0; i < gold.length; i += BATCH) {
    labels.push(...(await tagTitlesWithModel(gold.slice(i, i + BATCH).map((g) => g.title), userId, { purpose: "benchmark", stage: "tagging" })));
  }
  return labels;
}

async function main() {
  const own = value("gold");
  const showMisses = flag("misses");

  if (own) {
    const gold = parseGold(JSON.parse(readFileSync(own, "utf8")));
    console.log(`${gold.length} headlines from ${own}`);
    const rules = evaluate("rules (current)", gold, gold.map((g) => readHeadline(g.title).label), explain);
    print(rules, majorityAccuracy(gold));
    printMisses(rules);
  } else {
    const report = runBenchmark();
    for (const split of [report.heldOut, report.dev]) {
      console.log(`\n=== ${split.name}: ${split.gold.length} headlines ===`);
      print(split.rules, split.majority);
      print(split.wordList, split.majority);
      if (showMisses) printMisses(split.rules);
    }
    if (!showMisses) console.log("\n(--misses lists the headlines the rules got wrong.)");
  }

  if (flag("model")) {
    if (!hasModel()) throw new Error("--model needs a model configured (an API key in .env); the desk runs without one by default");
    const email = value("user");
    const user = email ? await findUserByEmail(email) : null;
    if (!user) throw new Error("--model needs --user=<email> of an existing account: the calls are metered against that person's daily spend");

    const gold = own ? parseGold(JSON.parse(readFileSync(own, "utf8"))) : flag("all") ? [...HELD_OUT, ...DEV] : HELD_OUT;
    const requests = Math.ceil(gold.length / BATCH);
    console.log(`\nscoring ${modelName()} on ${gold.length} headlines: ${requests} requests (each counts against ${user.email}'s daily spend limit)`);
    const labels = await modelLabels(gold, user.id);
    const result = evaluate(`${modelName()}`, gold, labels);
    print(result, majorityAccuracy(gold));
    const rules = evaluate("rules, same headlines", gold, gold.map((g) => readHeadline(g.title).label));
    print(rules, majorityAccuracy(gold));
    if (showMisses) printMisses(result);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
