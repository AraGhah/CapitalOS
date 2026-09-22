import "../lib/env";
import { pool } from "../lib/db";
import { checkOpenTheses } from "../lib/theses";

async function main() {
  const summary = await checkOpenTheses();

  for (const breach of summary.invalidated) {
    console.log(
      `${breach.ticker}: ${breach.rule.metric} is ${breach.actual} ` +
        `(rule: ${breach.rule.operator} ${breach.rule.value}) -> invalidated`
    );
  }

  for (const gap of summary.unresolved) {
    console.log(`${gap.ticker}: ${gap.metric} has no stored value, rule not checked`);
  }

  console.log(
    `checked ${summary.checked} open theses, ${summary.invalidated.length} breached, ` +
      `${summary.unresolved.length} rules unchecked`
  );

  await pool.end();
}

main();
