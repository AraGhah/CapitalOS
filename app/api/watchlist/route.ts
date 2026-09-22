import { NextRequest, NextResponse } from "next/server";
import { addToWatchlist, findCompany, getWatchlist, removeFromWatchlist } from "@/lib/company";

export async function GET() {
  return NextResponse.json(await getWatchlist());
}

export async function POST(req: NextRequest) {
  const { ticker, note } = await req.json();
  if (typeof ticker !== "string" || !ticker.trim()) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  // Only companies already tracked can be watched; adding an unknown ticker here
  // would create a row with no filings, prices or score behind it.
  const company = await findCompany(ticker);
  if (!company) {
    return NextResponse.json(
      { error: `no company stored for "${ticker}" — ingest it first` },
      { status: 404 }
    );
  }

  await addToWatchlist(company.id, typeof note === "string" && note.trim() ? note.trim() : null);
  return NextResponse.json({ ticker: company.ticker }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) return NextResponse.json({ error: "ticker is required" }, { status: 400 });

  const company = await findCompany(ticker);
  if (!company) return NextResponse.json({ error: "unknown ticker" }, { status: 404 });

  const removed = await removeFromWatchlist(company.id);
  return NextResponse.json({ removed });
}
