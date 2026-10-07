import { pool } from "./db";
import type { Actor } from "./actor";
import { domainOf } from "./format";

// Everything on this page is read straight out of the tables the ingest scripts
// fill. Nothing here computes a number the database cannot show you the rows for.

export interface TapeRow {
  ticker: string;
  name: string;
  close: number | null;
  changePct: number | null;
  spark: number[];
  held: boolean;
  watched: boolean;
}

const SPARK_BARS = 30;

// One query for every ticker worth showing — held or watched — with the last
// month of closes attached so each row can draw its own sparkline without a
// second round trip.
export async function getTape(actor: Pick<Actor, "userId" | "accountId">): Promise<TapeRow[]> {
  const { rows } = await pool.query(
    `WITH tracked AS (
       SELECT c.id, c.ticker, c.name,
              EXISTS (SELECT 1 FROM transactions t
                      WHERE t.company_id = c.id AND t.account_id = $1 AND t.voided_at IS NULL) AS held,
              EXISTS (SELECT 1 FROM watchlist w WHERE w.company_id = c.id AND w.user_id = $3) AS watched
       FROM companies c
       WHERE EXISTS (SELECT 1 FROM transactions t
                     WHERE t.company_id = c.id AND t.account_id = $1 AND t.voided_at IS NULL)
          OR EXISTS (SELECT 1 FROM watchlist w WHERE w.company_id = c.id AND w.user_id = $3)
     ),
     recent AS (
       SELECT p.company_id, p.date, p.close,
              row_number() OVER (PARTITION BY p.company_id ORDER BY p.date DESC) AS rn
       FROM prices_daily p
       JOIN tracked t ON t.id = p.company_id
       WHERE p.close IS NOT NULL
     )
     SELECT t.ticker, t.name, t.held, t.watched,
            (SELECT array_agg(r.close ORDER BY r.date)
             FROM recent r WHERE r.company_id = t.id AND r.rn <= $2) AS closes
     FROM tracked t
     ORDER BY t.ticker`,
    [actor.accountId, SPARK_BARS, actor.userId]
  );

  return rows.map((r) => {
    const spark: number[] = (r.closes ?? []).map((v: string) => Number(v));
    const close = spark.length > 0 ? spark[spark.length - 1] : null;
    const prior = spark.length > 1 ? spark[spark.length - 2] : null;
    return {
      ticker: r.ticker,
      name: r.name,
      close,
      changePct: close !== null && prior ? ((close - prior) / prior) * 100 : null,
      spark,
      held: r.held,
      watched: r.watched,
    };
  });
}

export interface FeedStatus {
  name: string;
  detail: string;
  count: number;
  latest: string | null;
}

// The rail says what each feed has actually delivered. A feed with nothing
// stored reads "offline" rather than zero, because zero rows and a broken
// fetch look the same from here and pretending otherwise would be a guess.
export async function getFeedStatus(): Promise<FeedStatus[]> {
  const { rows } = await pool.query(
    `SELECT 'SEC EDGAR' AS name, 'filings indexed' AS detail,
            count(*)::int AS count, max(filed_at)::text AS latest FROM filings
     UNION ALL
     SELECT 'XBRL facts', 'reported figures',
            count(*)::int, max(period_end)::text FROM fundamentals
     UNION ALL
     SELECT 'Market data', 'daily bars',
            count(*)::int, max(date)::text FROM prices_daily
     UNION ALL
     SELECT 'News sources', 'headlines kept',
            count(*)::int, max(published_at)::text FROM sources WHERE kind = 'news'
     UNION ALL
     SELECT 'Event clusters', 'stories deduplicated',
            count(*)::int, max(last_seen)::text FROM events
     UNION ALL
     SELECT 'FRED macro', 'observations',
            count(*)::int, max(date)::text FROM macro_series`
  );

  return rows.map((r) => ({
    name: r.name,
    detail: r.detail,
    count: r.count,
    latest: r.latest ? r.latest.slice(0, 10) : null,
  }));
}

export interface WireRow {
  id: string;
  ticker: string;
  title: string;
  url: string;
  domain: string;
  sourceCount: number;
  firstSeen: string;
}

// The wire, across the whole desk rather than one company. Ordered by how many
// outlets carried the story, same as the per-company view, so the strongest
// coverage sits at the top instead of whatever landed last.
export async function getWire(limit = 12): Promise<WireRow[]> {
  const { rows } = await pool.query(
    `SELECT e.id, c.ticker, e.title, s.url, e.source_count, e.first_seen
     FROM events e
     JOIN companies c ON c.id = e.company_id
     JOIN sources s ON s.id = e.canonical_source_id
     ORDER BY e.source_count DESC, e.first_seen DESC
     LIMIT $1`,
    [limit]
  );

  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    title: r.title,
    url: r.url,
    domain: domainOf(r.url),
    sourceCount: r.source_count,
    firstSeen: (r.first_seen as Date).toISOString(),
  }));
}

export interface PipelineStage {
  name: string;
  count: number;
}

// Where the desk's own work stops. Each stage is a table the previous one feeds,
// so the first empty stage is the next script to run.
export async function getPipeline(userId: string): Promise<PipelineStage[]> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM filings)::int        AS filings,
            (SELECT count(*) FROM fundamentals)::int   AS figures,
            (SELECT count(*) FROM scores)::int         AS scores,
            (SELECT count(*) FROM research_notes WHERE user_id = $1)::int AS claims`,
    [userId]
  );

  const r = rows[0];
  return [
    { name: "Filings", count: r.filings },
    { name: "Figures", count: r.figures },
    { name: "Scores", count: r.scores },
    { name: "Claims", count: r.claims },
  ];
}

export interface DiscoveryFeed {
  feed: string;
  label: string;
  count: number;
  error: string | null;
  storedHeadlines: number;
  lastRun: string | null;
}

// The five discovery feeds, as of the last pipeline run anywhere on the desk,
// alongside how many headlines each has contributed in total. A feed that failed
// on that run says so — the rail is there to make an unreachable source obvious
// rather than letting it look like quiet news.
export async function getDiscoveryFeeds(): Promise<DiscoveryFeed[]> {
  const { rows } = await pool.query(
    `WITH last_run AS (
       SELECT feeds, created_at FROM dossiers ORDER BY created_at DESC LIMIT 1
     ),
     reported AS (
       SELECT f->>'feed' AS feed,
              f->>'label' AS label,
              (f->>'count')::int AS count,
              f->>'error' AS error,
              last_run.created_at
       FROM last_run, jsonb_array_elements(last_run.feeds) AS f
     ),
     stored AS (
       SELECT feed, count(*)::int AS stored FROM headlines GROUP BY feed
     )
     SELECT COALESCE(reported.feed, stored.feed) AS feed,
            reported.label, reported.count, reported.error, reported.created_at,
            COALESCE(stored.stored, 0) AS stored
     FROM reported
     FULL OUTER JOIN stored ON stored.feed = reported.feed`
  );

  return rows.map((r) => ({
    feed: r.feed,
    label: r.label ?? r.feed,
    count: r.count ?? 0,
    error: r.error,
    storedHeadlines: r.stored,
    lastRun: r.created_at ? (r.created_at as Date).toISOString() : null,
  }));
}

export interface DeskSentiment {
  bullish: number;
  neutral: number;
  bearish: number;
  tagged: number;
  score: number;
}

// Sentiment across every headline the desk has tagged, not one company's.
export async function getDeskSentiment(): Promise<DeskSentiment> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE sentiment = 'bullish')::int AS bullish,
            count(*) FILTER (WHERE sentiment = 'neutral')::int AS neutral,
            count(*) FILTER (WHERE sentiment = 'bearish')::int AS bearish,
            count(*) FILTER (WHERE sentiment IS NOT NULL)::int AS tagged
     FROM headlines`
  );

  const r = rows[0];
  return {
    ...r,
    score: r.tagged === 0 ? 0 : ((r.bullish - r.bearish) / r.tagged) * 100,
  };
}
