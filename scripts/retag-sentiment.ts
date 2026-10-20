import "../lib/env";
import { pool } from "../lib/db";
import { LEXICON_PROVIDER } from "../lib/sentiment";
import { LABELS } from "../lib/sentiment/benchmark";
import { retag } from "../lib/sentiment/retag";

// Relabel the stored headlines that the old forty-word list tagged, with the
// current rules. Free: no model is called, and a model's labels are never touched.
//
//   npm run retag-sentiment                 what would change (writes nothing)
//   npm run retag-sentiment -- --apply      write it
//   npm run retag-sentiment -- --provider=lexicon:1 --apply   relabel an earlier version of the rules
//
// A company's cached dossier is keyed on its headlines' labels, so the next
// pipeline run for a company whose labels moved starts afresh: one model run if
// a key is configured, free otherwise.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const provider = args.find((a) => a.startsWith("--provider="))?.slice("--provider=".length);

async function main() {
  const report = await retag({ apply, provider });
  console.log(`${report.considered} headlines labelled by "${report.replaced}"; the rules (${LEXICON_PROVIDER}) would change ${report.changed} of them, across ${report.companies} companies.`);
  if (report.considered === 0) return;

  console.log("\n  before ↓ / after →   " + LABELS.map((l) => l.padStart(8)).join(" "));
  for (const from of LABELS) console.log(`  ${from.padEnd(19)} ${LABELS.map((to) => String(report.matrix[from][to]).padStart(8)).join(" ")}`);

  console.log(report.applied ? `\nwritten: ${report.considered} headlines are now labelled "${LEXICON_PROVIDER}".` : "\nnothing written (pass --apply to write it).");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
