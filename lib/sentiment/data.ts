import { BENCHMARK_TICKER } from "../constants";
import { pool } from "../db";
import { LEXICON_PROVIDER, type Sentiment } from "../sentiment";
import { getSplits } from "../splits";
import { studyOf, type Close, type StudyResult, type TaggedHeadline } from "./study";

/* ---------------------------------------------------------------------------
   Gathers what the market study reads — every labelled headline on the desk
   with its date, and the stored daily closes of the companies they name and of
   the S&P 500 — and hands them to lib/sentiment/study.ts, which does the
   measuring. Stored prices only: the study spans every company on the desk, and
   asking the market-data provider for each would be a request per company per
   page view. No model is called.
--------------------------------------------------------------------------- */

// Older headlines are rarely still in a feed, and older prices are rarely the
// ones that mattered; the window keeps the query bounded as the desk ages.
const LOOKBACK_DAYS = 540;
const ISO = (d: Date) => d.toISOString().slice(0, 10);

export type Labeller = "rules" | "word list" | "model";

export function labellerOf(provider: string | null): Labeller {
  if (provider === LEXICON_PROVIDER) return "rules";
  if (provider === "lexicon") return "word list";
  return "model";
}

export interface LabellerStudy {
  labeller: Labeller;
  headlines: number;
  study: StudyResult;
}

export interface SentimentStudyRead {
  headlines: number;
  byLabel: Record<Sentiment, number>;
  all: StudyResult;
  // one study per labeller that has labelled anything, so a model's labels are not judged by the rules' record
  by: LabellerStudy[];
}

export async function sentimentStudy(): Promise<SentimentStudyRead> {
  const { rows } = await pool.query(
    `SELECT company_id, published_at, sentiment, sentiment_provider
     FROM headlines
     WHERE sentiment IS NOT NULL AND published_at IS NOT NULL AND published_at >= now() - ($1::int * interval '1 day')`,
    [LOOKBACK_DAYS]
  );

  const tagged = rows.map((r) => ({
    companyId: r.company_id as string,
    date: ISO(r.published_at as Date),
    label: r.sentiment as Sentiment,
    labeller: labellerOf(r.sentiment_provider as string | null),
  }));

  const byLabel: Record<Sentiment, number> = { bullish: 0, neutral: 0, bearish: 0 };
  for (const t of tagged) byLabel[t.label] += 1;

  const companyIds = [...new Set(tagged.map((t) => t.companyId))];
  const earliest = tagged.reduce<string | null>((min, t) => (min === null || t.date < min ? t.date : min), null);
  const since = earliest ?? ISO(new Date());

  const bars = new Map<string, Close[]>();
  let market: Close[] | null = null;
  if (tagged.length > 0) {
    const benchmark = await pool.query(`SELECT id FROM companies WHERE ticker = $1`, [BENCHMARK_TICKER]);
    const benchmarkId = (benchmark.rows[0]?.id as string | undefined) ?? null;
    const wanted = benchmarkId ? [...companyIds, benchmarkId] : companyIds;

    const prices = await pool.query(
      `SELECT company_id, date, close FROM prices_daily
       WHERE company_id = ANY($1) AND date >= ($2::date - 10) AND close IS NOT NULL
       ORDER BY company_id, date`,
      [wanted, since]
    );
    for (const p of prices.rows) {
      const list = bars.get(p.company_id as string) ?? [];
      list.push({ date: ISO(p.date as Date), close: Number(p.close) });
      bars.set(p.company_id as string, list);
    }
    market = benchmarkId ? (bars.get(benchmarkId) ?? null) : null;
  }

  const splits = new Map<string, string[]>();
  for (const [id, list] of await getSplits(companyIds)) splits.set(id, list.map((s) => s.date));

  const study = (subset: TaggedHeadline[]) => studyOf({ headlines: subset, bars, market, splits });
  const labellers = (["rules", "word list", "model"] as const).filter((l) => tagged.some((t) => t.labeller === l));

  return {
    headlines: tagged.length,
    byLabel,
    all: study(tagged),
    by: labellers.map((labeller) => {
      const subset = tagged.filter((t) => t.labeller === labeller);
      return { labeller, headlines: subset.length, study: study(subset) };
    }),
  };
}
