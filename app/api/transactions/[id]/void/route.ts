import { route } from "@/lib/http/route";
import { notFound, parseJson } from "@/lib/http/errors";
import { TransactionVoid } from "@/lib/http/schemas";
import { isUuid } from "@/lib/ids";
import { voidTransaction } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// A ledger row is never deleted: a mistake is voided, with a reason, and stays
// on record (and in the audit log) as voided.
export const POST = route<{ id: string }>(async (req, { actor, params }) => {
  if (!isUuid(params.id)) throw notFound("no such transaction");
  const { reason } = await parseJson(req, TransactionVoid);
  await voidTransaction(actor, params.id, reason);
  return Response.json({ ok: true });
});
