import Decimal from "decimal.js";
import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { CashCreate } from "@/lib/http/schemas";
import { findCompany } from "@/lib/company";
import { listCashMovements, recordCashMovement } from "@/lib/cash";
import { limitUser } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export const GET = route(async (req, { actor }) =>
  Response.json(await listCashMovements(actor, req.nextUrl.searchParams.get("voided") === "1"))
);

export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, CashCreate);
  await limitUser(actor.userId, "ledger-write", 60);

  const amount = new Decimal(body.amount);
  if (amount.lte(0) || amount.gte("1e14")) throw new HttpError(400, "the amount must be a positive number");
  const when = new Date(body.occurredAt.length === 10 ? `${body.occurredAt}T12:00:00Z` : body.occurredAt);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, "occurredAt is not a real date");
  if (when.getTime() > Date.now() + 36 * 3_600_000) throw new HttpError(400, "a movement cannot be dated in the future");

  let companyId: string | null = null;
  if (body.ticker) {
    const company = await findCompany(body.ticker);
    if (!company) throw new HttpError(404, `the desk has no company "${body.ticker}"`);
    companyId = company.id;
  }

  const result = await recordCashMovement(actor, {
    kind: body.kind,
    amount,
    currency: body.currency,
    occurredAt: when,
    companyId,
    note: body.note ?? null,
    idempotencyKey: body.idempotencyKey ?? req.headers.get("idempotency-key"),
  });
  return Response.json(result, { status: result.duplicate ? 200 : 201 });
});
