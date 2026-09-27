import { createHash } from "node:crypto";
import { pool } from "./db";
import type { Article } from "./news";
import type { FeedId } from "./feeds";
import type { Sentiment, SentimentSummary } from "./sentiment";

/* ----------------------------------------------------------------- headlines */

export interface HeadlineRow {
  id: string;
  feed: FeedId;
  title: string;
  url: string;
  domain: string | null;
  publishedAt: string | null;
  sentiment: Sentiment | null;
  sentimentProvider: string | null;
}

// Every headline gets a sources row first, so the thing a claim or a tag points
// at exists independently of the headline table. Re-running the scout on the same
// story updates nothing and inserts nothing.
export async function storeHeadlines(
  companyId: string,
  feed: FeedId,
  articles: Article[]
): Promise<number> {
  let stored = 0;

  for (const article of articles) {
    const rawHash = createHash("sha256").update(article.title).digest("hex");

    // sources has no unique constraint on url, so an existing row is looked up
    // first — the same pattern the news ingest uses.
    const existing = await pool.query(`SELECT id FROM sources WHERE url = $1 LIMIT 1`, [
      article.url,
    ]);
    const source =
      existing.rows.length > 0
        ? existing
        : await pool.query(
            `INSERT INTO sources (kind, url, title, published_at, raw_hash)
             VALUES ('news', $1, $2, $3, $4)
             RETURNING id`,
            [article.url, article.title, article.publishedAt, rawHash]
          );

    const { rowCount } = await pool.query(
      `INSERT INTO headlines (company_id, source_id, feed, title, url, domain, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, url) DO NOTHING`,
      [
        companyId,
        source.rows[0].id,
        feed,
        article.title,
        article.url,
        article.domain,
        article.publishedAt,
      ]
    );
    stored += rowCount ?? 0;
  }

  return stored;
}

export async function getHeadlines(companyId: string, limit = 120): Promise<HeadlineRow[]> {
  const { rows } = await pool.query(
    `SELECT id, feed, title, url, domain, published_at, sentiment, sentiment_provider
     FROM headlines
     WHERE company_id = $1
     ORDER BY published_at DESC NULLS LAST
     LIMIT $2`,
    [companyId, limit]
  );

  return rows.map(toHeadline);
}

export async function getUntagged(companyId: string, limit = 120): Promise<HeadlineRow[]> {
  const { rows } = await pool.query(
    `SELECT id, feed, title, url, domain, published_at, sentiment, sentiment_provider
     FROM headlines
     WHERE company_id = $1 AND sentiment IS NULL
     ORDER BY published_at DESC NULLS LAST
     LIMIT $2`,
    [companyId, limit]
  );

  return rows.map(toHeadline);
}

function toHeadline(r: Record<string, unknown>): HeadlineRow {
  return {
    id: r.id as string,
    feed: r.feed as FeedId,
    title: r.title as string,
    url: r.url as string,
    domain: (r.domain as string | null) ?? null,
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
    sentiment: (r.sentiment as Sentiment | null) ?? null,
    sentimentProvider: (r.sentiment_provider as string | null) ?? null,
  };
}

export async function saveTags(
  tags: Array<{ id: string; sentiment: Sentiment }>,
  provider: string
): Promise<number> {
  if (tags.length === 0) return 0;

  const { rowCount } = await pool.query(
    `UPDATE headlines AS h
     SET sentiment = t.sentiment, sentiment_provider = $3, tagged_at = now()
     FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS sentiment) AS t
     WHERE h.id = t.id`,
    [tags.map((t) => t.id), tags.map((t) => t.sentiment), provider]
  );
  return rowCount ?? 0;
}

/* ------------------------------------------------------------------ dossiers */

export type Verdict = "BUY" | "ACCUMULATE" | "HOLD" | "WAIT" | "AVOID";

export interface Brief {
  headline: string | null;
  summary: string | null;
  entryPlan: string | null;
}

export interface FeedReport {
  feed: FeedId;
  label: string;
  count: number;
  error: string | null;
}

export interface Dossier {
  id: string;
  companyId: string;
  ticker: string;
  name: string;
  createdAt: string;
  verdict: Verdict;
  confidence: number | null;
  risk: "low" | "medium" | "high" | null;
  horizon: string | null;
  brief: Brief;
  bull: string[];
  bear: string[];
  catalysts: string[];
  sentiment: SentimentSummary;
  feeds: FeedReport[];
  headlineCount: number;
  provider: string;
}

export interface DossierInput {
  companyId: string;
  inputHash: string;
  headlineIds: string[];
  verdict: Verdict;
  confidence: number | null;
  risk: "low" | "medium" | "high" | null;
  horizon: string | null;
  brief: Brief;
  bull: string[];
  bear: string[];
  catalysts: string[];
  sentiment: SentimentSummary;
  feeds: FeedReport[];
  provider: string;
}

// input_hash carries the cache: the same headline set produces the same row
// rather than a second opinion on identical evidence.
export async function saveDossier(input: DossierInput): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO dossiers (company_id, input_hash, headline_count, verdict, confidence, risk,
                           horizon, brief_headline, brief_summary, entry_plan,
                           bull, bear, catalysts, sentiment, feeds, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (company_id, input_hash) DO UPDATE
       SET created_at = now(),
           verdict = EXCLUDED.verdict,
           confidence = EXCLUDED.confidence,
           risk = EXCLUDED.risk,
           horizon = EXCLUDED.horizon,
           brief_headline = EXCLUDED.brief_headline,
           brief_summary = EXCLUDED.brief_summary,
           entry_plan = EXCLUDED.entry_plan,
           bull = EXCLUDED.bull,
           bear = EXCLUDED.bear,
           catalysts = EXCLUDED.catalysts,
           sentiment = EXCLUDED.sentiment,
           feeds = EXCLUDED.feeds,
           provider = EXCLUDED.provider
     RETURNING id`,
    [
      input.companyId,
      input.inputHash,
      input.headlineIds.length,
      input.verdict,
      input.confidence,
      input.risk,
      input.horizon,
      input.brief.headline,
      input.brief.summary,
      input.brief.entryPlan,
      JSON.stringify(input.bull),
      JSON.stringify(input.bear),
      JSON.stringify(input.catalysts),
      JSON.stringify(input.sentiment),
      JSON.stringify(input.feeds),
      input.provider,
    ]
  );

  const dossierId = rows[0].id as string;

  await pool.query(
    `INSERT INTO dossier_headlines (dossier_id, headline_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [dossierId, input.headlineIds]
  );

  return dossierId;
}

const SELECT_DOSSIER = `
  SELECT d.id, d.company_id, c.ticker, c.name, d.created_at, d.verdict, d.confidence, d.risk,
         d.horizon, d.brief_headline, d.brief_summary, d.entry_plan,
         d.bull, d.bear, d.catalysts, d.sentiment, d.feeds, d.headline_count, d.provider
  FROM dossiers d
  JOIN companies c ON c.id = d.company_id`;

export async function getLatestDossier(companyId: string): Promise<Dossier | null> {
  const { rows } = await pool.query(
    `${SELECT_DOSSIER} WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT 1`,
    [companyId]
  );
  return rows.length === 0 ? null : toDossier(rows[0]);
}

export async function getCachedDossier(
  companyId: string,
  inputHash: string
): Promise<Dossier | null> {
  const { rows } = await pool.query(
    `${SELECT_DOSSIER} WHERE d.company_id = $1 AND d.input_hash = $2`,
    [companyId, inputHash]
  );
  return rows.length === 0 ? null : toDossier(rows[0]);
}

// The verdict beside every watchlist and tape row.
export async function getVerdicts(): Promise<Map<string, { verdict: Verdict; createdAt: string }>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.ticker) c.ticker, d.verdict, d.created_at
     FROM dossiers d
     JOIN companies c ON c.id = d.company_id
     ORDER BY c.ticker, d.created_at DESC`
  );

  return new Map(
    rows.map((r) => [
      r.ticker as string,
      { verdict: r.verdict as Verdict, createdAt: (r.created_at as Date).toISOString() },
    ])
  );
}

function toDossier(r: Record<string, unknown>): Dossier {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    ticker: r.ticker as string,
    name: r.name as string,
    createdAt: (r.created_at as Date).toISOString(),
    verdict: r.verdict as Verdict,
    confidence: r.confidence === null ? null : Number(r.confidence),
    risk: (r.risk as Dossier["risk"]) ?? null,
    horizon: (r.horizon as string | null) ?? null,
    brief: {
      headline: (r.brief_headline as string | null) ?? null,
      summary: (r.brief_summary as string | null) ?? null,
      entryPlan: (r.entry_plan as string | null) ?? null,
    },
    bull: (r.bull as string[]) ?? [],
    bear: (r.bear as string[]) ?? [],
    catalysts: (r.catalysts as string[]) ?? [],
    sentiment: (r.sentiment as SentimentSummary) ?? {
      bullish: 0,
      neutral: 0,
      bearish: 0,
      tagged: 0,
      score: 0,
    },
    feeds: (r.feeds as FeedReport[]) ?? [],
    headlineCount: Number(r.headline_count ?? 0),
    provider: r.provider as string,
  };
}
