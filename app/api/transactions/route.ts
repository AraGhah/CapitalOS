import Decimal from "decimal.js";
import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { TransactionCreate } from "@/lib/http/schemas";
import { resolveCompany } from "@/lib/resolve";
import { listTransactions, recordTransaction } from "@/lib/ledger";
import { limitUser } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export const GET = route(async (req, { actor }) => {
  const includeVoided = req.nextUrl.searchParams.get("voided") === "1";
  return Response.json(await listTransactions(actor, { limit: 200, includeVoided }));
});

export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, TransactionCreate);
  await limitUser(actor.userId, "ledger-write", 60);

  const qty = new Decimal(body.qty);
  const price = new Decimal(body.price);
  const fees = new Decimal(body.fees ?? "0");
  // The columns are NUMERIC(14,4), NUMERIC(12,4) and NUMERIC(10,4).
  if (qty.lte(0) || qty.gte("1e10")) throw new HttpError(400, "quantity must be a positive number");
  if (price.lte(0) || price.gte("1e8")) throw new HttpError(400, "price must be a positive number");
  if (fees.lt(0) || fees.gte("1e6")) throw new HttpError(400, "fees must be zero or a positive number");

  // A date alone is a trade at noon UTC, so it lands on that calendar day in
  // every timezone the desk is read from.
  const when = new Date(body.executedAt.length === 10 ? `${body.executedAt}T12:00:00Z` : body.executedAt);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, "executedAt is not a real date");
  if (when.getTime() > Date.now() + 36 * 3_600_000) throw new HttpError(400, "a transaction cannot be dated in the future");

  // Only a symbol SEC or the market-data provider recognises gets a companies row.
  const company = await resolveCompany(body.ticker).catch((err: Error) => {
    throw new HttpError(404, err.message);
  });

  const { id, duplicate } = await recordTransaction(actor, {
    companyId: company.id,
    ticker: company.ticker,
    side: body.side,
    qty,
    price,
    fees,
    executedAt: when,
    note: body.note ?? null,
    idempotencyKey: body.idempotencyKey ?? req.headers.get("idempotency-key"),
  });
  return Response.json({ id, duplicate }, { status: duplicate ? 200 : 201 });
});
