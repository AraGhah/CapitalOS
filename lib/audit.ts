import type { Db } from "./db";

/* ---------------------------------------------------------------------------
   The audit log. Written inside the same database transaction as the change
   it describes, so there is never a ledger write without its audit row, nor
   an audit row for a write that rolled back.
--------------------------------------------------------------------------- */

export interface AuditContext {
  userId: string | null;
  requestId?: string | null;
  ip?: string | null;
}

export async function audit(
  db: Db,
  ctx: AuditContext,
  entry: { action: string; entity: string; entityId?: string | null; detail?: Record<string, unknown> }
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, request_id, ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ctx.userId,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      ctx.requestId ?? null,
      ctx.ip ?? null,
      JSON.stringify(entry.detail ?? {}),
    ]
  );
}
