import { pool } from "./db";
import { config } from "./config";

/* ---------------------------------------------------------------------------
   Data retention. Tables that grow with every request are trimmed on a
   schedule, so the database does not quietly fill with history nobody reads:

   - chat transcripts older than RETENTION_CHAT_DAYS
   - raw model output (kept for debugging a bad reply) after RETENTION_RAW_MODEL_TEXT_DAYS;
     the parsed output, tokens and costs stay
   - expired and revoked sessions, old sign-in attempts
   - finished jobs and their event logs after 30 days
   - schedule slots after a week

   Ledger rows, audit rows, committee reports and fundamentals are never
   trimmed: they are the record.
--------------------------------------------------------------------------- */

export async function runRetention(): Promise<Record<string, number>> {
  const c = config();
  const run = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rowCount ?? 0;

  return {
    chatMessages: await run(
      `DELETE FROM chat_messages WHERE created_at < now() - make_interval(days => $1)`,
      [c.RETENTION_CHAT_DAYS]
    ),
    rawModelText: await run(
      `UPDATE model_calls SET raw_text = NULL
       WHERE raw_text IS NOT NULL AND created_at < now() - make_interval(days => $1)`,
      [c.RETENTION_RAW_MODEL_TEXT_DAYS]
    ),
    sessions: await run(
      `DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`
    ),
    loginAttempts: await run(`DELETE FROM login_attempts WHERE at < now() - interval '30 days'`),
    jobs: await run(
      `DELETE FROM jobs WHERE status IN ('succeeded', 'cancelled') AND finished_at < now() - interval '30 days'`
    ),
    scheduleSlots: await run(`DELETE FROM schedule_slots WHERE created_at < now() - interval '7 days'`),
    budgetReservations: await run(`DELETE FROM budget_reservations WHERE created_at < now() - interval '2 days'`),
  };
}
