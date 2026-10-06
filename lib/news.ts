import { createHash } from "crypto";
import { pool } from "./db";
import { cosineSim, embed } from "./embeddings";
import { isWebUrl } from "./url";

export interface Article {
  url: string;
  title: string;
  domain: string;
  publishedAt: string;
}

// GDELT asks for one request every five seconds and answers an impatient caller
// with a plain-text notice rather than an error status. In practice it throttles
// harder than that and occasionally drops the connection outright, so each
// request waits its turn and then backs off and tries again.
const GDELT_INTERVAL_MS = 6000;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 8000;

const TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// One GDELT request at a time, each starting at least GDELT_INTERVAL_MS after
// the last. Callers queue on a chain; reading a shared timestamp instead let
// concurrent callers all decide it was their turn at once.
let gate: Promise<void> = Promise.resolve();
function takeTurn(): Promise<void> {
  const turn = gate.then(() => sleep(GDELT_INTERVAL_MS));
  gate = turn;
  return turn;
}

function isThrottleNotice(body: string): boolean {
  return /^please limit requests/i.test(body.trimStart());
}

async function gdeltRequest(url: string): Promise<string> {
  let lastProblem = "no response";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await takeTurn();

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": process.env.SEC_USER_AGENT ?? "CapitalOS contact@example.com" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();

      if (!res.ok) lastProblem = `${res.status} ${res.statusText}`;
      else if (isThrottleNotice(body)) lastProblem = "rate limited";
      else return body;
    } catch (err) {
      lastProblem = (err as Error).message;
    }

    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }

  throw new Error(`GDELT unavailable after ${MAX_ATTEMPTS} attempts (${lastProblem})`);
}

function parseSeenDate(seendate: string): string {
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

// SEC names carry legal suffixes that never appear in a headline.
export function searchName(name: string): string {
  return name
    .replace(/[,.]/g, " ")
    .replace(/\s*\/[A-Z]{2}\/?\s*$/i, " ")
    .replace(
      /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|the|sa|nv|ag)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchArticles(
  query: string,
  opts: { timespan?: string; maxRecords?: number } = {}
): Promise<Article[]> {
  const params = new URLSearchParams({
    query: `"${query}" sourcelang:english`,
    mode: "ArtList",
    format: "json",
    timespan: opts.timespan ?? "7d",
    maxrecords: String(opts.maxRecords ?? 250),
  });

  const body = await gdeltRequest(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);

  let parsed: { articles?: Array<Record<string, string>> };
  try {
    parsed = JSON.parse(body);
  } catch {
    // Query-syntax complaints come back as prose too.
    throw new Error(`GDELT did not return JSON: ${body.trim().slice(0, 160)}`);
  }

  return (parsed.articles ?? [])
    .filter((a) => a.url && a.title && isWebUrl(a.url))
    .map((a) => ({
      url: a.url,
      title: a.title.trim(),
      domain: a.domain ?? new URL(a.url).hostname,
      publishedAt: parseSeenDate(a.seendate ?? ""),
    }));
}

export interface Cluster {
  canonical: Article;
  members: Article[];
  firstSeen: string;
  lastSeen: string;
}

function centroid(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
  }
  return sum.map((v) => v / vectors.length);
}

export interface ClusterOptions {
  threshold: number;
  windowHours: number;
}

// One pass in publication order: an article joins the nearest open cluster it is
// close enough to and recent enough for, or starts its own. Comparing against the
// cluster centroid rather than any single member stops a chain of slightly
// similar headlines from dragging unrelated stories into one event.
export function clusterArticles(
  articles: Article[],
  vectors: number[][],
  opts: ClusterOptions
): Cluster[] {
  const order = articles
    .map((article, index) => ({ article, vector: vectors[index] }))
    .sort((a, b) => a.article.publishedAt.localeCompare(b.article.publishedAt));

  interface Open {
    members: Article[];
    vectors: number[][];
    centroid: number[];
    lastSeenMs: number;
  }

  const windowMs = opts.windowHours * 3600_000;
  const open: Open[] = [];

  for (const { article, vector } of order) {
    const publishedMs = Date.parse(article.publishedAt);

    let best: Open | null = null;
    let bestScore = opts.threshold;

    for (const cluster of open) {
      if (publishedMs - cluster.lastSeenMs > windowMs) continue;
      const score = cosineSim(vector, cluster.centroid);
      if (score >= bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best) {
      best.members.push(article);
      best.vectors.push(vector);
      best.centroid = centroid(best.vectors);
      best.lastSeenMs = Math.max(best.lastSeenMs, publishedMs);
    } else {
      open.push({
        members: [article],
        vectors: [vector],
        centroid: vector,
        lastSeenMs: publishedMs,
      });
    }
  }

  return open.map((cluster) => {
    // First to report wins, with the domain breaking ties so a rerun picks the same one.
    const canonical = [...cluster.members].sort(
      (a, b) =>
        a.publishedAt.localeCompare(b.publishedAt) || a.domain.localeCompare(b.domain)
    )[0];
    const times = cluster.members.map((m) => m.publishedAt).sort();
    return {
      canonical,
      members: cluster.members,
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
    };
  });
}

async function upsertNewsSource(article: Article, embedding: number[]): Promise<string> {
  const rawHash = createHash("sha256").update(article.title).digest("hex");

  const existing = await pool.query(`SELECT id FROM sources WHERE url = $1`, [article.url]);
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE sources SET embedding = $2 WHERE id = $1 AND embedding IS NULL`, [
      existing.rows[0].id,
      JSON.stringify(embedding),
    ]);
    return existing.rows[0].id;
  }

  const { rows } = await pool.query(
    `INSERT INTO sources (kind, url, title, published_at, raw_hash, embedding)
     VALUES ('news', $1, $2, $3, $4, $5)
     RETURNING id`,
    [article.url, article.title, article.publishedAt, rawHash, JSON.stringify(embedding)]
  );
  return rows[0].id;
}

export interface StoredEvents {
  events: number;
  articles: number;
}

// An event is keyed by its canonical article, so a later run that sees the same
// story with more coverage updates the count instead of adding a second event.
export async function storeClusters(
  companyId: string,
  clusters: Cluster[],
  vectorByUrl: Map<string, number[]>
): Promise<StoredEvents> {
  let articles = 0;

  for (const cluster of clusters) {
    const sourceIds = new Map<string, string>();
    for (const member of cluster.members) {
      const id = await upsertNewsSource(member, vectorByUrl.get(member.url) ?? []);
      sourceIds.set(member.url, id);
      articles++;
    }

    const canonicalId = sourceIds.get(cluster.canonical.url)!;
    const existing = await pool.query(
      `SELECT id FROM events WHERE company_id = $1 AND canonical_source_id = $2`,
      [companyId, canonicalId]
    );

    let eventId: string;
    if (existing.rows.length > 0) {
      eventId = existing.rows[0].id;
      await pool.query(
        `UPDATE events SET title = $2, first_seen = $3, last_seen = $4, source_count = $5
         WHERE id = $1`,
        [eventId, cluster.canonical.title, cluster.firstSeen, cluster.lastSeen, cluster.members.length]
      );
    } else {
      const inserted = await pool.query(
        `INSERT INTO events (company_id, canonical_source_id, title, first_seen, last_seen, source_count)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          companyId,
          canonicalId,
          cluster.canonical.title,
          cluster.firstSeen,
          cluster.lastSeen,
          cluster.members.length,
        ]
      );
      eventId = inserted.rows[0].id;
    }

    for (const id of sourceIds.values()) {
      await pool.query(
        `INSERT INTO event_sources (event_id, source_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [eventId, id]
      );
    }
  }

  return { events: clusters.length, articles };
}

export interface EventRow {
  id: string;
  title: string;
  firstSeen: string;
  lastSeen: string;
  sourceCount: number;
  canonicalSourceId: string;
  url: string;
  domains: string[];
}

// Ordered by how many outlets carried the story rather than by date: the whole
// point of collapsing coverage into events is that a story thirty outlets ran is
// a stronger signal than thirty stories one outlet each ran.
export async function getEvents(companyId: string, limit = 20): Promise<EventRow[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.first_seen, e.last_seen, e.source_count,
            e.canonical_source_id, s.url,
            (SELECT array_agg(DISTINCT split_part(replace(replace(m.url,'https://',''),'http://',''), '/', 1))
             FROM event_sources es JOIN sources m ON m.id = es.source_id
             WHERE es.event_id = e.id) AS domains
     FROM events e
     JOIN sources s ON s.id = e.canonical_source_id
     WHERE e.company_id = $1
     ORDER BY e.source_count DESC, e.first_seen DESC
     LIMIT $2`,
    [companyId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    firstSeen: (r.first_seen as Date).toISOString(),
    lastSeen: (r.last_seen as Date).toISOString(),
    sourceCount: r.source_count,
    canonicalSourceId: r.canonical_source_id,
    url: r.url,
    domains: r.domains ?? [],
  }));
}

export async function embedTitles(
  articles: Article[],
  stripTerms: string[]
): Promise<{ provider: string; vectorByUrl: Map<string, number[]>; vectors: number[][] }> {
  // Every headline names the company, so leaving it in would make unrelated
  // stories look alike.
  const pattern =
    stripTerms.filter(Boolean).length > 0
      ? new RegExp(
          stripTerms
            .filter(Boolean)
            .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
            .join("|"),
          "gi"
        )
      : null;

  const texts = articles.map((a) => (pattern ? a.title.replace(pattern, " ") : a.title));
  const { provider, vectors } = await embed(texts);

  const vectorByUrl = new Map<string, number[]>();
  articles.forEach((a, i) => vectorByUrl.set(a.url, vectors[i]));
  return { provider, vectorByUrl, vectors };
}
