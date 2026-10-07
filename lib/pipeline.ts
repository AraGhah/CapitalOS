import type { Actor } from "./actor";
import { LOCKS, withSessionLock } from "./db";
import { resolveCompany } from "./resolve";
import { addToWatchlist } from "./company";
import { analyst, dossierHash, scout, strategist } from "./agents";
import { getCachedDossier, saveDossier, type Dossier } from "./dossier";
import { budgetRemaining, BudgetExhaustedError, reserveDossier } from "./llm";

/* ---------------------------------------------------------------------------
   The desk pipeline — scout, analyst, strategist — in one place, for the
   research page, the copilot's research_ticker tool and the job worker.

   One run per ticker at a time across every process: two clicks (or a click
   and the copilot) on the same ticker would otherwise tag the same headlines
   twice and pay for two strategist calls on identical evidence.
--------------------------------------------------------------------------- */

export type PipelineEvent =
  | { phase: "scout"; status: "running" }
  | { phase: "scout"; status: "done"; feeds: unknown[]; fetched: number; stored: number }
  | { phase: "analyst"; status: "running" }
  | { phase: "analyst"; status: "done"; tagged: number; provider: string; sentiment: unknown }
  | { phase: "strategist"; status: "running" }
  | { phase: "strategist"; status: "done"; dossier: Dossier }
  | { phase: "cached"; dossier: Dossier }
  | { phase: "error"; message: string };

export async function runDeskPipeline(
  actor: Pick<Actor, "userId">,
  ticker: string,
  opts: { force?: boolean; watch?: boolean; onEvent?: (e: PipelineEvent) => void } = {}
): Promise<{ dossier: Dossier; cached: boolean; ticker: string; name: string }> {
  const send = (e: PipelineEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // a listener that went away does not stop a paid run
    }
  };

  const company = await resolveCompany(ticker);

  // Researching a ticker puts it on the watchlist, so the desk keeps tracking
  // whatever it has looked at.
  if (opts.watch !== false) await addToWatchlist(actor.userId, company.id, null);

  // The lock is held for the whole run; a second request for the same ticker
  // waits for this one and then, almost always, hits the cache it wrote.
  return withSessionLock(
    LOCKS.research(company.ticker),
    async () => {
      send({ phase: "scout", status: "running" });
      const scouted = await scout(company);
      send({ phase: "scout", status: "done", feeds: scouted.feeds, fetched: scouted.fetched, stored: scouted.stored });

      // Labelling headlines is model calls too, so an exhausted budget stops
      // the run here rather than only before the strategist.
      if ((await budgetRemaining(actor.userId)) <= 0) throw new BudgetExhaustedError();

      send({ phase: "analyst", status: "running" });
      const analysed = await analyst(company, actor.userId);
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
      if (!opts.force) {
        const cached = await getCachedDossier(company.id, hash);
        if (cached) {
          send({ phase: "cached", dossier: cached });
          return { dossier: cached, cached: true, ticker: company.ticker, name: company.name };
        }
      }

      const release = await reserveDossier(actor.userId);
      try {
        send({ phase: "strategist", status: "running" });
        const call = await strategist(company, analysed.headlines, analysed.sentiment, actor.userId);
        await saveDossier({
          requestedBy: actor.userId,
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
      } finally {
        // the saved dossier now counts itself; the slot it held is released
        await release();
      }

      const saved = await getCachedDossier(company.id, hash);
      if (!saved) throw new Error("the dossier was written but could not be read back");
      send({ phase: "strategist", status: "done", dossier: saved });
      return { dossier: saved, cached: false, ticker: company.ticker, name: company.name };
    },
    // A pipeline run takes a minute or two; a second request for the same
    // ticker waits that long rather than failing.
    { timeoutMs: 5 * 60_000 }
  );
}
