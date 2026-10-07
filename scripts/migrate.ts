import "../lib/env";
import { pool } from "../lib/db";
import { log } from "../lib/log";
import { loadMigrations, migrate, pendingMigrations } from "../lib/migrate";

// npm run migrate            apply every pending migration in migrations/
// npm run migrate -- --status   list what is pending without applying it
async function main() {
  if (process.argv.includes("--status")) {
    const pending = await pendingMigrations(pool);
    const all = loadMigrations();
    console.log(`${all.length - pending.length} applied, ${pending.length} pending`);
    for (const m of pending) console.log(`  pending ${m.version}_${m.name}`);
    return;
  }
  const result = await migrate(pool, { log: (line) => console.log(line) });
  console.log(`${result.applied.length} applied, ${result.skipped} already in place`);
}

main()
  .catch((err) => {
    log.error({ err: { message: (err as Error).message } }, "migration failed");
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
