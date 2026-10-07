import { route } from "@/lib/http/route";
import { HttpError, parseJson, parseWith } from "@/lib/http/errors";
import { Ticker, WatchlistAdd } from "@/lib/http/schemas";
import { addToWatchlist, findCompany, getWatchlist, removeFromWatchlist } from "@/lib/company";
import { getTape } from "@/lib/desk";
import { getVerdicts } from "@/lib/dossier";
import { resolveCompany } from "@/lib/resolve";

export const dynamic = "force-dynamic";

// Each row carries what the watchlist is for: a sparkline, the day's move, and
// the verdict the pipeline last reached on it.
export const GET = route(async (_req, { actor }) => {
  const [rows, tape, verdicts] = await Promise.all([getWatchlist(actor.userId), getTape(actor), getVerdicts()]);
  const priced = new Map(tape.map((t) => [t.ticker, t]));

  return Response.json(
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
});

export const POST = route(async (req, { actor }) => {
  const { ticker, note } = await parseJson(req, WatchlistAdd);
  // A ticker the desk has not ingested yet can still be watched: the resolver
  // creates its row, but only once SEC or the market-data provider confirms the symbol is real.
  const company = await resolveCompany(ticker).catch((err: Error) => {
    throw new HttpError(404, err.message);
  });
  await addToWatchlist(actor.userId, company.id, note || null);
  return Response.json({ ticker: company.ticker }, { status: 201 });
});

export const DELETE = route(async (req, { actor }) => {
  const ticker = parseWith(Ticker, req.nextUrl.searchParams.get("ticker") ?? "");
  const company = await findCompany(ticker);
  if (!company) throw new HttpError(404, "unknown ticker");
  return Response.json({ removed: await removeFromWatchlist(actor.userId, company.id) });
});
