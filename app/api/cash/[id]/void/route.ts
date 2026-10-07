import { route } from "@/lib/http/route";
import { notFound, parseJson } from "@/lib/http/errors";
import { TransactionVoid } from "@/lib/http/schemas";
import { isUuid } from "@/lib/ids";
import { voidCashMovement } from "@/lib/cash";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (req, { actor, params }) => {
  if (!isUuid(params.id)) throw notFound("no such cash movement");
  const { reason } = await parseJson(req, TransactionVoid);
  await voidCashMovement(actor, params.id, reason);
  return Response.json({ ok: true });
});
