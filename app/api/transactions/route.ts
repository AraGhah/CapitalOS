import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import { pool } from "@/lib/db";
import { ACCOUNT_ID } from "@/lib/constants";
import { resolveCompany } from "@/lib/resolve";
import { heldQuantity } from "@/lib/holdings";

export const dynamic = "force-dynamic";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT t.id, c.ticker, t.side, t.qty, t.price, t.fees, t.executed_at
     FROM transactions t
     JOIN companies c ON c.id = t.company_id
     WHERE t.account_id = $1
     ORDER BY t.executed_at DESC
     LIMIT 50`,
    [ACCOUNT_ID]
  );
  return NextResponse.json(rows);
}

// A number, or a string that is one; anything else is refused rather than
// handed to Postgres to fail on.
function decimal(value: unknown): Decimal | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) return null;
  try {
    const d = new Decimal(typeof value === "string" ? value.trim() : value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("the body must be a JSON object");

  const { ticker, side, executedAt } = body;
  if (typeof ticker !== "string" || !ticker.trim()) return bad("a ticker is required");
  if (side !== "buy" && side !== "sell") return bad("side must be buy or sell");

  const qty = decimal(body.qty);
  const price = decimal(body.price);
  const fees = body.fees === undefined || body.fees === "" || body.fees === null ? new Decimal(0) : decimal(body.fees);

  // The columns are NUMERIC(14,4), NUMERIC(12,4) and NUMERIC(10,4).
  if (!qty || qty.lte(0) || qty.gte("1e10")) return bad("quantity must be a positive number");
  if (!price || price.lte(0) || price.gte("1e8")) return bad("price must be a positive number");
  if (!fees || fees.lt(0) || fees.gte("1e6")) return bad("fees must be zero or a positive number");

  if (typeof executedAt !== "string" || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(executedAt)) {
    return bad("executedAt must be a date like 2026-10-05");
  }
  const when = new Date(executedAt.length === 10 ? `${executedAt}T12:00:00Z` : executedAt);
  if (Number.isNaN(when.getTime())) return bad("executedAt is not a real date");
  if (when.getTime() > Date.now() + 36 * 3_600_000) return bad("a transaction cannot be dated in the future");

  // Only a symbol SEC or Yahoo recognises gets a companies row.
  let company;
  try {
    company = await resolveCompany(ticker);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "unknown ticker" }, { status: 404 });
  }

  if (side === "sell") {
    const held = await heldQuantity(ACCOUNT_ID, company.id, when);
    if (qty.gt(held)) {
      return NextResponse.json(
        { error: `only ${held.toString()} ${company.ticker} was held on that date; a sell cannot exceed it` },
        { status: 422 }
      );
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO transactions (account_id, company_id, side, qty, price, fees, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [ACCOUNT_ID, company.id, side, qty.toString(), price.toString(), fees.toString(), when.toISOString()]
  );

  return NextResponse.json({ id: rows[0].id }, { status: 201 });
}
