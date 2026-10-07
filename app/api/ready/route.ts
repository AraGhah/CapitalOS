import { ping, pool } from "@/lib/db";
import { pendingMigrations } from "@/lib/migrate";
import { liveWorkers } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

// Readiness: can this server do its job right now? The database answers, the
// schema is fully migrated, and (reported, not required) a worker is alive to
// run queued jobs. 503 takes the instance out of a load balancer's rotation.
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ready = true;

  try {
    checks.database = await ping();
  } catch (err) {
    ready = false;
    checks.database = { ok: false, error: (err as Error).message.slice(0, 200) };
  }

  if (ready) {
    try {
      const pending = await pendingMigrations(pool);
      checks.migrations = { ok: pending.length === 0, pending: pending.map((m) => `${m.version}_${m.name}`) };
      if (pending.length > 0) ready = false;
    } catch (err) {
      ready = false;
      checks.migrations = { ok: false, error: (err as Error).message.slice(0, 200) };
    }
    checks.workers = { alive: await liveWorkers().catch(() => 0) };
  }

  return Response.json({ status: ready ? "ready" : "not ready", checks }, { status: ready ? 200 : 503 });
}
