import { pool } from "./db";
import type { Actor } from "./actor";
import { findCompany } from "./company";
import { getFilings } from "./company";
import { getProfile } from "./profile";
import { annualPeriods, getScores } from "./scoring";
import { deriveMetrics } from "./metrics";
import { loadBars } from "./market/bars";
import { priceStats } from "./ai/evidence";
import { capitalisationShares } from "./edgar";
import { getSplits, splitFactor } from "./splits";
import { macroSnapshot } from "./market/overview";
import { getPortfolio } from "./holdings";
import { getAccount } from "./cash";
import { listTheses } from "./theses";
import { evaluateChecklist, type Checklist, type ChecklistInput, type PeriodIn } from "./checklist";

/* ---------------------------------------------------------------------------
   Gathers what the pre-investment checklist reads — the person's profile, the
   company's last four annual periods, a year of prices, its sector
   percentiles, the macro series, the portfolio and any open thesis — and hands
   it to lib/checklist, which does the judging. Every source that fails comes
   through as absent, and the checklist reports the gap rather than guessing.
--------------------------------------------------------------------------- */

const PERIODS = 4;
const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "40-F"]);

export class UnknownCompanyError extends Error {
  readonly status = 404;
  constructor(ticker: string) {
    super(`the desk has no company "${ticker.toUpperCase()}" — research it first to add it`);
    this.name = "UnknownCompanyError";
  }
}

export async function buildChecklist(
  actor: Pick<Actor, "userId" | "accountId">,
  ticker: string,
  opts: { positionSize?: number | null } = {}
): Promise<Checklist> {
  const company = await findCompany(ticker);
  if (!company) throw new UnknownCompanyError(ticker);

  const [profile, account, rawPeriods, bars, scores, macro, portfolio, theses, splits, filings, extra] = await Promise.all([
    getProfile(actor.userId),
    getAccount(actor),
    annualPeriods(company.id),
    loadBars(company.ticker).catch(() => null),
    getScores().catch(() => []),
    macroSnapshot(),
    getPortfolio(actor.accountId),
    listTheses(actor.userId, "open", { companyId: company.id }),
    getSplits([company.id]),
    getFilings(company.id, { limit: 40 }),
    pool.query(
      `SELECT c.currency,
              (SELECT count(*)::int FROM dividends d WHERE d.company_id = c.id AND d.ex_date > now() - interval '1 year') AS dividends
       FROM companies c WHERE c.id = $1`,
      [company.id]
    ),
  ]);

  if (opts.positionSize !== undefined && opts.positionSize !== null) profile.positionSize = opts.positionSize;

  // Each period's derived figures against the period before it, the same
  // arithmetic the scores and theses use.
  const recent = rawPeriods.slice(0, PERIODS);
  const periods: PeriodIn[] = recent.map((current, i) => {
    const derived = deriveMetrics({ current, prior: rawPeriods[i + 1] });
    return {
      periodEnd: current.periodEnd,
      values: Object.fromEntries([...current.values].map(([k, x]) => [k, x.toNumber()])),
      derived: Object.fromEntries([...derived].map(([k, x]) => [k, x.toNumber()])),
    };
  });

  let price: ChecklistInput["price"] = null;
  let marketCap: number | null = null;
  if (bars && bars.bars.length > 1) {
    const closes = bars.bars.map((b) => ({ date: b.date, close: b.close }));
    const stats = priceStats(closes);
    const last = bars.bars[bars.bars.length - 1];
    const recentVolume = bars.bars.slice(-20).filter((b) => b.volume !== null);
    price = {
      last: last.close,
      asOf: last.date,
      volatility: stats.volatility,
      maxDrawdown: stats.maxDrawdown,
      avgDollarVolume:
        recentVolume.length >= 10 ? recentVolume.reduce((s, b) => s + b.close * (b.volume as number), 0) / recentVolume.length : null,
      source: bars.source,
    };
    // Shares as filed for the latest period, restated for any split since, so
    // they are on the same basis as the split-adjusted price.
    const latest = recent[0];
    const shares = latest ? capitalisationShares(latest.values) : undefined;
    if (latest && shares && shares.gt(0)) {
      const factor = splitFactor(splits.get(company.id), latest.periodEnd);
      marketCap = shares.mul(factor).mul(last.close).toNumber();
    }
  }

  const score = scores.find((s) => s.companyId === company.id);
  const percentiles: Record<string, number> = {};
  for (const c of score?.components ?? []) if (!c.imputed) percentiles[c.component] = c.percentile;

  const series = (id: string) => macro.find((m) => m.id === id);
  const tenYear = series("DGS10");
  const unemployment = series("UNRATE");

  const held = portfolio.holdings.find((h) => h.companyId === company.id);
  const sameSector = company.sector
    ? await sectorValue(portfolio.holdings.map((h) => ({ companyId: h.companyId, value: h.marketValue.toNumber() })), company.sector)
    : held?.marketValue.toNumber() ?? 0;

  const thesis = theses[0];
  const annual = filings.find((f) => ANNUAL_FORMS.has(f.formType));

  return evaluateChecklist({
    today: new Date().toISOString().slice(0, 10),
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    listingCurrency: extra.rows[0]?.currency ?? "USD",
    baseCurrency: account.baseCurrency,
    profile,
    periods,
    price,
    marketCap,
    percentiles,
    macro: {
      tenYear: tenYear?.latest ?? null,
      curve: series("T10Y2Y")?.latest ?? null,
      cpiYoy: series("CPI_YOY")?.latest ?? null,
      unemployment: unemployment?.latest ?? null,
      unemploymentYearAgo: unemployment?.yearAgo ?? null,
      asOf: tenYear?.asOf ?? macro[0]?.asOf ?? null,
    },
    portfolio: {
      value: portfolio.holdings.reduce((s, h) => s + h.marketValue.toNumber(), 0),
      held: held?.marketValue.toNumber() ?? 0,
      sameSector,
      positions: portfolio.holdings.length,
    },
    thesis: thesis
      ? { rationale: thesis.thesis.rationale, rules: thesis.thesis.rules.length, breached: thesis.breached }
      : null,
    dividendsLastYear: extra.rows[0]?.dividends ?? 0,
    cik: company.cik,
    latestAnnualFiling: annual ? { form: annual.formType, filedAt: annual.filedAt } : null,
  });
}

async function sectorValue(holdings: Array<{ companyId: string; value: number }>, sector: string): Promise<number> {
  if (holdings.length === 0) return 0;
  const { rows } = await pool.query(`SELECT id FROM companies WHERE id = ANY($1) AND sector = $2`, [
    holdings.map((h) => h.companyId),
    sector,
  ]);
  const inSector = new Set(rows.map((r) => r.id as string));
  return holdings.filter((h) => inSector.has(h.companyId)).reduce((s, h) => s + h.value, 0);
}
