import "../lib/env";
process.env.CAPITALOS_SERVICE ??= "capitalos-worker";

import { pool } from "../lib/db";
import { config } from "../lib/config";
import { log } from "../lib/log";
import { runWorker } from "../lib/jobs/worker";
import { JOB_KINDS, type JobKind } from "../lib/jobs/handlers";

/* ---------------------------------------------------------------------------
   npm run worker                 run every kind of job, and the scheduler
   npm run worker -- --no-schedule      jobs only (when another worker schedules)
   WORKER_KINDS=committee,research npm run worker   only these kinds

   Stops cleanly on SIGINT/SIGTERM: no new jobs are claimed, running ones
   finish (up to five minutes), then the process exits.
--------------------------------------------------------------------------- */

async function main() {
  const c = config(); // fail fast on a bad configuration
  if (c.SENTRY_DSN) {
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: c.SENTRY_DSN, environment: c.NODE_ENV, sendDefaultPii: false, tracesSampleRate: 0 });
    const { setErrorReporter } = await import("../lib/observability");
    setErrorReporter((err, context) => Sentry.captureException(err, { extra: context }));
  }
  const kinds = (process.env.WORKER_KINDS?.split(",").map((k) => k.trim()).filter(Boolean) ?? JOB_KINDS) as JobKind[];
  const unknown = kinds.filter((k) => !JOB_KINDS.includes(k));
  if (unknown.length) throw new Error(`unknown job kinds: ${unknown.join(", ")}`);

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log.info({ signal: sig }, "shutting down");
      controller.abort();
    });
  }

  await runWorker(
    {
      kinds,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      schedule: !process.argv.includes("--no-schedule"),
    },
    controller.signal
  );
}

main()
  .catch((err) => {
    log.fatal({ err: { message: (err as Error).message, stack: (err as Error).stack } }, "worker crashed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
