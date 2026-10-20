import { createHash } from "node:crypto";
import type { Actor } from "../actor";
import { getRun } from "../ai/store";
import { evaluateChecklist } from "../checklist";
import { gatherChecklist } from "../checklist-data";
import { FxTable } from "../fx";
import { HttpError, notFound } from "../http/errors";
import { errorFields, log } from "../log";
import { technicalRead } from "../technical-read";
import type { TechnicalSnapshot } from "../technicals";
import { decide, type Decision, type DecisionInput } from "./decide";

/* ---------------------------------------------------------------------------
   Gathers what the Portfolio Manager reads — a finished committee report, the
   person's checklist, profile and portfolio, and the stock's technical
   snapshot — and hands it to lib/decision/decide.ts, which does the judging.
   No model is called: the committee already ran, and this only does arithmetic
   on what it left behind.
--------------------------------------------------------------------------- */

export interface GatheredDecision {
  input: DecisionInput;
  decision: Decision;
  // a digest of the exact inputs, so the same inputs are recorded once
  hash: string;
  companyId: string;
}

export function inputsHash(input: DecisionInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function fxToBase(listing: string, base: string, today: string): Promise<number | null> {
  if (listing === base) return 1;
  try {
    const table = await FxTable.load([listing, base], today);
    return table.rate(listing, base, today).toNumber();
  } catch (err) {
    log.warn({ ...errorFields(err), listing, base }, "no exchange rate stored for the decision; shares will not be computed");
    return null;
  }
}

export async function decideForRun(actor: Pick<Actor, "userId" | "accountId">, runId: string): Promise<GatheredDecision> {
  const run = await getRun(actor.userId, runId);
  if (!run) throw notFound("no such committee run");
  if (run.summary.status !== "done" || !run.report) {
    throw new HttpError(409, "this committee has not finished, so there is nothing to decide on yet");
  }
  const report = run.report;

  const gathered = await gatherChecklist(actor, report.ticker);
  const { input: checklistInput } = gathered;
  const checklist = evaluateChecklist(checklistInput);

  let technical: TechnicalSnapshot | null = null;
  try {
    technical = (await technicalRead(report.ticker)).snapshot;
  } catch (err) {
    log.warn({ ...errorFields(err), ticker: report.ticker }, "technical read failed for the decision; no stop will be drawn");
  }

  const today = new Date().toISOString().slice(0, 10);
  const { profile, portfolio, price } = checklistInput;

  const input: DecisionInput = {
    runId,
    ticker: report.ticker,
    name: report.name,
    asOf: today,
    rating: {
      dimensions: report.dimensions.map((d) => ({ key: d.key, label: d.label, resolved: d.resolved, contested: d.contested })),
      confidence: { score: report.confidence.score, label: report.confidence.label },
      unverifiedFigures: report.unverifiedFigures,
    },
    checklist: {
      level: checklist.verdict.level,
      headline: checklist.verdict.headline,
      blocking: checklist.verdict.blocking,
      unverified: checklist.verdict.unverified,
      risks: checklist.verdict.risks,
    },
    thesisBreached: checklistInput.thesis?.breached === true,
    technical,
    last: price?.last ?? null,
    listingCurrency: checklistInput.listingCurrency,
    baseCurrency: checklistInput.baseCurrency,
    fxToBase: await fxToBase(checklistInput.listingCurrency, checklistInput.baseCurrency, today),
    profile: {
      tolerance: profile.riskTolerance,
      plannedSize: profile.positionSize,
      investableAmount: profile.investableAmount,
      maxLossShare: profile.maxLossShare,
    },
    portfolio: {
      holdingsValue: portfolio.value,
      heldValue: portfolio.held,
      heldQty: gathered.heldQty,
      sectorValue: checklistInput.sector ? portfolio.sameSector : null,
    },
    volatility: price?.volatility ?? null,
    maxDrawdown: price?.maxDrawdown ?? null,
    avgDollarVolume: price?.avgDollarVolume ?? null,
  };

  return { input, decision: decide(input), hash: inputsHash(input), companyId: gathered.companyId };
}
