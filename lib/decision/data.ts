import { createHash } from "node:crypto";
import type { Actor } from "../actor";
import { getRun } from "../ai/store";
import { evaluateChecklist } from "../checklist";
import { gatherChecklist } from "../checklist-data";
import { FxTable } from "../fx";
import { HttpError, notFound } from "../http/errors";
import { errorFields, log } from "../log";
import { aligned, loadBars } from "../market/bars";
import { simpleReturns } from "../risk/stats";
import { technicalRead } from "../technical-read";
import type { TechnicalSnapshot } from "../technicals";
import { decide, type Decision, type DecisionInput } from "./decide";
import { rate } from "./rating";
import { DEBATE_RULES, type RiskBook } from "./risk-debate";

/* ---------------------------------------------------------------------------
   Gathers what the Portfolio Manager reads — a finished committee report, the
   person's checklist, profile and portfolio, the stock's technical snapshot
   and, for a purchase, a year of daily returns of everything the person holds
   — and hands it to lib/decision/decide.ts, which does the judging.
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

// Daily returns rounded to the millionth of a percent point: far below anything a
// risk figure resolves, and it keeps the recorded inputs a fraction of the size.
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// What the risk debate needs: the stock's returns beside those of every other
// holding and of the S&P 500, on the sessions they all share. A holding with no
// price history is left out and named; a stock with none, or too few shared
// sessions, gives an "unmeasured" book that the cautious seats price in rather
// than ignore.
export async function gatherRiskBook(ticker: string, holdings: Array<{ ticker: string; value: number }>): Promise<RiskBook> {
  const others = holdings.filter((h) => h.ticker !== ticker && h.value > 0);
  const tickers = [...new Set([ticker, ...others.map((o) => o.ticker), "SPY"])];
  const loaded = new Map(await Promise.all(tickers.map(async (t) => [t, await loadBars(t).catch(() => null)] as const)));

  const candidate = loaded.get(ticker);
  if (!candidate) return { status: "unmeasured", reason: `no price history could be loaded for ${ticker}` };
  const usable = others.filter((o) => loaded.get(o.ticker));
  const skipped = others.filter((o) => !loaded.get(o.ticker)).map((o) => o.ticker);
  const market = loaded.get("SPY") ?? null;

  const { dates, closes } = aligned([candidate.bars, ...usable.map((o) => loaded.get(o.ticker)!.bars), ...(market ? [market.bars] : [])]);
  if (dates.length < DEBATE_RULES.minSessions) {
    return { status: "unmeasured", reason: `fewer than ${DEBATE_RULES.minSessions} trading days are shared by ${ticker} and everything you hold` };
  }
  const returns = closes.map((c) => simpleReturns(c).map(round6));
  return {
    status: "measured",
    asOf: dates[dates.length - 1],
    sessions: dates.length,
    candidate: returns[0],
    others: usable.map((o, i) => ({ ticker: o.ticker, value: o.value, returns: returns[i + 1] })),
    market: market ? returns[usable.length + 1] : null,
    skipped,
  };
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

  const rating: DecisionInput["rating"] = {
    dimensions: report.dimensions.map((d) => ({ key: d.key, label: d.label, resolved: d.resolved, contested: d.contested })),
    confidence: { score: report.confidence.score, label: report.confidence.label },
    unverifiedFigures: report.unverifiedFigures,
  };

  // Only a purchase is debated, so the portfolio's prices are read only for one.
  let book: RiskBook | null = null;
  const final = rate(rating).final;
  if (final === "buy" || final === "overweight") {
    try {
      book = await gatherRiskBook(report.ticker, gathered.holdings);
    } catch (err) {
      log.warn({ ...errorFields(err), ticker: report.ticker }, "could not build the portfolio's return book for the risk debate");
      book = { status: "unmeasured", reason: "the portfolio's price history could not be read" };
    }
  }

  const input: DecisionInput = {
    runId,
    ticker: report.ticker,
    name: report.name,
    asOf: today,
    rating,
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
    book,
  };

  return { input, decision: decide(input), hash: inputsHash(input), companyId: gathered.companyId };
}
