import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { JournalNote } from "@/lib/http/schemas";
import { addJournal, listJournal } from "@/lib/ai/journal";
import { findCompany } from "@/lib/company";

export const dynamic = "force-dynamic";

export const GET = route(async (req, { actor }) => {
  const ticker = req.nextUrl.searchParams.get("ticker");
  const company = ticker ? await findCompany(ticker) : null;
  if (ticker && !company) return Response.json({ entries: [] });
  return Response.json({ entries: await listJournal(actor.userId, { companyId: company?.id, limit: 100 }) });
});

// A note the person writes themselves: the decisions the desk cannot see, like
// why a position was sized the way it was.
export const POST = route(async (req, { actor }) => {
  const body = await parseJson(req, JournalNote);
  let companyId: string | null = null;
  if (body.ticker) {
    const company = await findCompany(body.ticker);
    if (!company) throw new HttpError(404, `the desk has no company "${body.ticker}"`);
    companyId = company.id;
  }
  await addJournal({ userId: actor.userId, companyId, kind: "note", title: body.title, detail: body.detail || null });
  return Response.json({ ok: true }, { status: 201 });
});
