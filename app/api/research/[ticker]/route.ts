import type { NextRequest } from "next/server";
import { resolveCompany } from "@/lib/resolve";
import { analyst, dossierHash, scout, strategist } from "@/lib/agents";
import {
  getCachedDossier,
  getLatestDossier,
  saveDossier,
  type Dossier,
} from "@/lib/dossier";
import { addToWatchlist } from "@/lib/company";
import { budgetRemaining, BudgetExhaustedError } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The pipeline streams newline-delimited JSON, one object per phase, so the
// interface can show Scout handing off to Analyst handing off to Strategist as it
// actually happens rather than guessing at a progress bar.

export type PipelineEvent =
  | { phase: "scout"; status: "running" }
  | { phase: "scout"; status: "done"; feeds: unknown[]; fetched: number; stored: number }
  | { phase: "analyst"; status: "running" }
  | { phase: "analyst"; status: "done"; tagged: number; provider: string; sentiment: unknown }
  | { phase: "strategist"; status: "running" }
  | { phase: "strategist"; status: "done"; dossier: Dossier }
  | { phase: "cached"; dossier: Dossier }
  | { phase: "error"; message: string };

export async function GET(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const company = await resolveCompany(ticker);
  const dossier = await getLatestDossier(company.id);

  return Response.json({ company, dossier });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const watch = url.searchParams.get("watch") !== "0";

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: PipelineEvent) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      try {
        const company = await resolveCompany(ticker);

        // Researching a ticker puts it on the watchlist, so the desk keeps
        // tracking whatever it has looked at.
        if (watch) await addToWatchlist(company.id, null);

        send({ phase: "scout", status: "running" });
        const scouted = await scout(company);
        send({
          phase: "scout",
          status: "done",
          feeds: scouted.feeds,
          fetched: scouted.fetched,
          stored: scouted.stored,
        });

        send({ phase: "analyst", status: "running" });
        const analysed = await analyst(company);
        send({
          phase: "analyst",
          status: "done",
          tagged: analysed.tagged,
          provider: analysed.provider,
          sentiment: analysed.sentiment,
        });

        const hash = dossierHash(company, analysed.headlines);

        // Identical evidence gets the stored answer back rather than a second
        // opinion and a second bill.
        if (!force) {
          const cached = await getCachedDossier(company.id, hash);
          if (cached) {
            send({ phase: "cached", dossier: cached });
            controller.close();
            return;
          }
        }

        if ((await budgetRemaining()) <= 0) throw new BudgetExhaustedError();

        send({ phase: "strategist", status: "running" });
        const call = await strategist(company, analysed.headlines, analysed.sentiment);

        await saveDossier({
          companyId: company.id,
          inputHash: hash,
          headlineIds: analysed.headlines.map((h) => h.id),
          verdict: call.verdict,
          confidence: call.confidence,
          risk: call.risk,
          horizon: call.horizon,
          brief: call.brief,
          bull: call.bull,
          bear: call.bear,
          catalysts: call.catalysts,
          sentiment: analysed.sentiment,
          feeds: scouted.feeds,
          provider: call.provider,
        });

        const saved = await getCachedDossier(company.id, hash);
        if (!saved) throw new Error("the dossier was written but could not be read back");

        send({ phase: "strategist", status: "done", dossier: saved });
      } catch (err) {
        send({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
