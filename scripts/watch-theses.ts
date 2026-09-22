import "../lib/env";
import cron from "node-cron";
import { checkOpenTheses } from "../lib/theses";

// A long-running process rather than a shell wrapper: the same check the one-shot
// script runs, on a schedule. Hand the work to your OS task scheduler instead if
// you would rather not leave a process up.
const SCHEDULE = process.env.THESIS_CRON ?? "0 * * * *";

async function run() {
  try {
    const summary = await checkOpenTheses();
    const stamp = new Date().toISOString();
    console.log(
      `${stamp} checked ${summary.checked}, ${summary.invalidated.length} breached, ` +
        `${summary.unresolved.length} unchecked`
    );
    for (const breach of summary.invalidated) {
      console.log(`  ${breach.ticker}: ${breach.rule.metric} = ${breach.actual}`);
    }
  } catch (err) {
    console.error(`thesis check failed: ${(err as Error).message}`);
  }
}

if (!cron.validate(SCHEDULE)) {
  console.error(`THESIS_CRON is not a valid cron expression: ${SCHEDULE}`);
  process.exit(1);
}

console.log(`watching theses on "${SCHEDULE}"`);
cron.schedule(SCHEDULE, run);
run();
