import type { NextRequest } from "next/server";
import { addJournal, listJournal } from "@/lib/ai/journal";
import { findCompany } from "@/lib/company";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  const company = ticker ? await findCompany(ticker) : null;
  return Response.json({ entries: await listJournal({ companyId: company?.id, limit: 100 }) });
}

// A note the person writes themselves: the decisions the desk cannot see, like
// why a position was sized the way it was.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ticker?: string; title?: string; detail?: string };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "a note needs a title" }, { status: 400 });

  let companyId: string | null = null;
  if (body.ticker?.trim()) {
    const company = await findCompany(body.ticker);
    if (!company) return Response.json({ error: `the desk has no company "${body.ticker}"` }, { status: 404 });
    companyId = company.id;
  }

  await addJournal({ companyId, kind: "note", title: title.slice(0, 200), detail: body.detail?.trim().slice(0, 2000) || null });
  return Response.json({ ok: true }, { status: 201 });
}
