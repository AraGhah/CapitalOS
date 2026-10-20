import { priceStats } from "../ai/evidence";
import { periodsOf, priceAndCap } from "../checklist-data";
import { loadBars } from "../market/bars";
import { macroSnapshot } from "../market/overview";
import { annualPeriods } from "../scoring";
import { getSplits } from "../splits";
import type { PersonaInput } from "./figures";
import { readLenses, type LensReport } from "./lenses";

/* ---------------------------------------------------------------------------
   Gathers what the investor lenses read — the company's annual periods, a year
   of prices, the 10-year Treasury yield and its splits — and hands them to
   lib/personas/lenses.ts, which does the judging. The annual periods and the
   market value are built by the same functions the pre-investment checklist
   uses, so the two never disagree about a figure. No model is called.
--------------------------------------------------------------------------- */

// Ten years of annual periods is as much history as any lens asks for; the
// filings rarely hold more.
const YEARS = 10;

export interface LensRead extends LensReport {
  // where the prices came from, e.g. "prices_daily table"
  source: string | null;
}

type CompanyIn = { id: string; ticker: string; name: string; sector: string | null };

export async function personaInput(company: CompanyIn): Promise<{ input: PersonaInput; source: string | null }> {
  const [raw, bars, macro, splits] = await Promise.all([
    annualPeriods(company.id),
    loadBars(company.ticker).catch(() => null),
    macroSnapshot().catch(() => []),
    getSplits([company.id]),
  ]);

  const { price, marketCap } = priceAndCap(bars, raw[0], splits.get(company.id));
  const belowHigh = bars && bars.bars.length > 1 ? priceStats(bars.bars.map((b) => ({ date: b.date, close: b.close }))).belowHigh : null;

  return {
    input: {
      ticker: company.ticker,
      name: company.name,
      sector: company.sector,
      asOf: new Date().toISOString().slice(0, 10),
      periods: periodsOf(raw, YEARS),
      marketCap,
      price: price ? { last: price.last, asOf: price.asOf, belowHigh } : null,
      tenYear: macro.find((m) => m.id === "DGS10")?.latest ?? null,
      splits: (splits.get(company.id) ?? []).map((s) => s.date),
    },
    source: bars?.source ?? null,
  };
}

export async function lensRead(company: CompanyIn): Promise<LensRead> {
  const { input, source } = await personaInput(company);
  return { ...readLenses(input), source };
}
