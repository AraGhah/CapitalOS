import "../lib/env";
import cron from "node-cron";
import { pool } from "../lib/db";
import { runCycle } from "../lib/autopilot/cycle";

/* ---------------------------------------------------------------------------
   The autopilot, as a long-running process: one pass of the loop on a schedule.

   npm run autopilot              every 30 minutes (AUTOPILOT_CRON)
   npm run autopilot -- --once    one pass, then exit — for the OS task scheduler
   add --convene, or set AUTOPILOT_CONVENE=1, to let it convene committees on
   high-severity alerts (model calls, capped by AUTOPILOT_MAX_COMMITTEES a day)
--------------------------------------------------------------------------- */

const SCHEDULE = process.env.AUTOPILOT_CRON ?? "*/30 * * * *";
const once = process.argv.includes("--once");
const convene = process.argv.includes("--convene") || process.env.AUTOPILOT_CONVENE === "1";

let running = false;

async function pass() {
  const stamp = new Date().toISOString();
  // A pass that convenes committees can outlast the schedule; the next tick is
  // skipped rather than stacked on top of it.
  if (running) {
    console.log(`${stamp} previous pass still running, skipping this one`);
    return;
  }
  running = true;
  try {
    const s = await runCycle({ convene });
    console.log(
      `${stamp} tracked ${s.tracked}, ${s.found} triggers, ${s.created} new alerts ${JSON.stringify(s.bySeverity)}; ` +
        `regime ${s.regime ?? "unknown"}; ${s.convened.length} committees convened`
    );
    for (const c of s.convened) console.log(`  committee on ${c.ticker}: /committee/${c.runId}${c.cached ? " (cached)" : ""}`);
    if (s.skippedConvening) console.log(`  ${s.skippedConvening}`);
    for (const e of s.errors) console.log(`  error: ${e}`);
  } catch (err) {
    console.error(`${stamp} autopilot pass failed: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

if (once) {
  pass().finally(() => pool.end());
} else {
  if (!cron.validate(SCHEDULE)) {
    console.error(`AUTOPILOT_CRON is not a valid cron expression: ${SCHEDULE}`);
    process.exit(1);
  }
  console.log(`autopilot on "${SCHEDULE}"${convene ? ", convening committees on high-severity alerts" : ", alerts only"}`);
  cron.schedule(SCHEDULE, pass);
  pass();
}
