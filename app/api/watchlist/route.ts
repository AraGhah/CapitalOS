import { NextRequest, NextResponse } from "next/server";
import { addToWatchlist, findCompany, getWatchlist, removeFromWatchlist } from "@/lib/company";
import { getTape } from "@/lib/desk";
import { getVerdicts } from "@/lib/dossier";
import { resolveCompany } from "@/lib/resolve";

export const dynamic = "force-dynamic";

// Each row carries what the watchlist is for: a sparkline, the day's move, and
// the verdict the pipeline last reached on it.
export async function GET() {
  const [rows, tape, verdicts] = await Promise.all([getWatchlist(), getTape(), getVerdicts()]);
  const priced = new Map(tape.map((t) => [t.ticker, t]));

  return NextResponse.json(
    rows.map((row) => {
      const quote = priced.get(row.ticker);
      const call = verdicts.get(row.ticker);
      return {
        ...row,
        close: quote?.close ?? null,
        changePct: quote?.changePct ?? null,
        spark: quote?.spark ?? [],
        verdict: call?.verdict ?? null,
        verdictAt: call?.createdAt ?? null,
      };
    })
  );
}

export async function POST(req: NextRequest) {
  const { ticker, note } = await req.json();
  if (typeof ticker !== "string" || !ticker.trim()) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  // A ticker the desk has not ingested yet can still be watched: the resolver
  // creates its row, but only once SEC or Yahoo confirms the symbol is real.
  let company;
  try {
    company = await resolveCompany(ticker);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `unknown ticker "${ticker}"` },
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
