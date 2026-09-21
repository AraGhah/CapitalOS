import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { ACCOUNT_ID } from "@/lib/constants";

async function resolveCompanyId(ticker: string): Promise<string> {
  const normalized = ticker.trim().toUpperCase();

  const existing = await pool.query("SELECT id FROM companies WHERE ticker = $1", [normalized]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await pool.query(
    "INSERT INTO companies (ticker, name) VALUES ($1, $1) RETURNING id",
    [normalized]
  );
  return created.rows[0].id;
}

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

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ticker, side, qty, price, fees, executedAt } = body;

  if (!ticker || (side !== "buy" && side !== "sell") || !qty || !price || !executedAt) {
    return NextResponse.json({ error: "missing or invalid fields" }, { status: 400 });
  }

  const companyId = await resolveCompanyId(ticker);

  const { rows } = await pool.query(
    `INSERT INTO transactions (account_id, company_id, side, qty, price, fees, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [ACCOUNT_ID, companyId, side, qty, price, fees ?? 0, executedAt]
  );

  return NextResponse.json({ id: rows[0].id }, { status: 201 });
}
