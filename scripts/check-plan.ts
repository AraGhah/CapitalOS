import "../lib/env";
import { pool } from "../lib/db";
import { planCheckData } from "../lib/track/data";
import type { PlanGroup } from "../lib/track/plan-check";

// Tests the plan's stop and reward levels against the stored price history of
// every stock on the desk: every 20 sessions it draws the plan the Trader would
// have drawn that day and walks it through the next 20 sessions. Free: stored
// closes only, no model and no outside feed.
//
//   npm run check-plan
//
// A longer history gives it more to work with: `RANGE=5y npm run fetch-prices`.

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const r = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`);

function show(name: string, g: PlanGroup) {
  if (g.entries === 0) return;
  const of = (n: number) => (g.filled === 0 ? "—" : pct(n / g.filled));
  console.log(
    `  ${name.padEnd(9)} ${String(g.entries).padStart(4)} entries, ${g.filled} filled; stopped ${of(g.stopped)}; reached ` +
      `${g.reached.map((x) => `${x.multiple}R ${of(x.count)}`).join(", ")} first; mean ${r(g.meanR)} with the stop, ${r(g.meanHoldR)} without it`
  );
}

async function main() {
  const check = await planCheckData();
  if (check.status === "unmeasured") {
    console.log(check.reason);
    return;
  }
  console.log(
    `${check.all.entries} plans on ${check.tickers} stocks, ${check.from} to ${check.to}; each walked ${check.horizon} sessions. ` +
      `The stop is ${check.stopAtrs} ATRs below the entry (median ${pct(check.medianRiskShare)} of the price).`
  );
  show("all", check.all);
  show("market", check.market);
  show("pullback", check.pullback);
  if (!check.enough) console.log("\nFewer than 30 entries: read these as an illustration, not a measurement.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
