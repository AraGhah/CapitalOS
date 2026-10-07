import { fetchArticles, searchName, type Article } from "./news";
import { domainOf } from "./format";
import { isWebUrl } from "./url";
import { config } from "./config";

// Free, public discovery feeds. None needs a key, all of them go down
// sometimes, and each one reports its own outcome so the rail can say which was
// unreachable rather than quietly showing fewer headlines.
//
// Which feeds run is NEWS_FEEDS. The default is the sources whose terms allow
// this use: GDELT (an open research dataset), Hacker News' public Algolia API
// and Google News' public RSS. Reddit's terms require its registered API for
// programmatic access, and Yahoo's RSS is tied to Yahoo's data terms, so both
// are opt-in for personal use and off by default.

export type FeedId = "gdelt" | "google_news" | "yahoo_finance" | "hacker_news" | "reddit";

export interface FeedResult {
  feed: FeedId;
  label: string;
  articles: Article[];
  error: string | null;
}

export const FEED_LABELS: Record<FeedId, string> = {
  gdelt: "GDELT Project",
  google_news: "Google News",
  yahoo_finance: "Yahoo Finance",
  hacker_news: "Hacker News",
  reddit: "Reddit",
};

const UA = "CapitalOS/1.0 (personal research desk)";
const TIMEOUT_MS = 12_000;

async function get(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// The RSS here is shallow and predictable, so two regexes beat adding an XML
// parser to the dependency list.
function parseRss(xml: string): Article[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];

  return items.flatMap((item) => {
    const title = tag(item, "title");
    const link = tag(item, "link");
    if (!title || !link) return [];

    const pubDate = tag(item, "pubDate");
    const parsed = pubDate ? Date.parse(pubDate) : NaN;

    return [
      {
        title: decodeEntities(title).trim(),
        url: link.trim(),
        domain: domainOf(link.trim()),
        publishedAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
      },
    ];
  });
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!match) return null;
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase();
    if (named[key]) return named[key];
    if (key.startsWith("#")) {
      const n = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return whole;
  });
}

// Reddit serves Atom from search.rss, not RSS: entries rather than items, and the
// link is an attribute instead of a text node. Its JSON endpoints answer 403 to
// anything without an OAuth token, so this is the way in that stays key-free.
function parseAtom(xml: string): Article[] {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];

  return entries.flatMap((entry) => {
    const title = tag(entry, "title");
    const href = entry.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    if (!title || !href) return [];

    const updated = tag(entry, "updated") ?? tag(entry, "published");
    const parsed = updated ? Date.parse(updated) : NaN;
    const url = decodeEntities(href).trim();

    return [
      {
        title: decodeEntities(title).trim(),
        url,
        domain: domainOf(url),
        publishedAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
      },
    ];
  });
}

async function googleNews(query: string): Promise<Article[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return parseRss(await get(url, "application/rss+xml"));
}

async function yahooFinance(ticker: string): Promise<Article[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  return parseRss(await get(url, "application/rss+xml"));
}

async function hackerNews(query: string): Promise<Article[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=30`;
  const body = JSON.parse(await get(url, "application/json")) as {
    hits?: Array<{ objectID: string; title: string | null; url: string | null; created_at: string }>;
  };

  return (body.hits ?? []).flatMap((hit) => {
    if (!hit.title) return [];
    // A text post has no url of its own, so the discussion is the article.
    const url = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
    return [
      {
        title: hit.title.trim(),
        url,
        domain: domainOf(url),
        publishedAt: new Date(hit.created_at).toISOString(),
      },
    ];
  });
}

async function reddit(query: string): Promise<Article[]> {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&limit=40`;
  return parseAtom(await get(url, "application/atom+xml, application/rss+xml"));
}

// All five run at once: one slow feed should not hold up the other four, and a
// rejected one becomes a reported error rather than a thrown one.
export async function scoutFeeds(ticker: string, name: string): Promise<FeedResult[]> {
  const plain = searchName(name) || ticker;

  const enabled = new Set<FeedId>(config().NEWS_FEEDS);
  const all: Array<[FeedId, () => Promise<Article[]>]> = [
    ["gdelt", () => fetchArticles(plain, { timespan: "7d", maxRecords: 75 })],
    ["google_news", () => googleNews(`${plain} stock`)],
    ["yahoo_finance", () => yahooFinance(ticker)],
    ["hacker_news", () => hackerNews(plain)],
    ["reddit", () => reddit(`${plain} ${ticker}`)],
  ];
  const jobs: Array<[FeedId, Promise<Article[]>]> = all
    .filter(([id]) => enabled.has(id))
    .map(([id, run]) => [id, run()]);

  const settled = await Promise.allSettled(jobs.map(([, job]) => job));

  return settled.map((outcome, i) => {
    const [feed] = jobs[i];
    if (outcome.status === "fulfilled") {
      return { feed, label: FEED_LABELS[feed], articles: dedupe(outcome.value), error: null };
    }
    const reason = outcome.reason;
    return {
      feed,
      label: FEED_LABELS[feed],
      articles: [],
      error: reason instanceof Error ? reason.message : String(reason),
    };
  });
}

function dedupe(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const article of articles) {
    if (!isWebUrl(article.url)) continue;
    const key = article.url.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(article);
  }
  return out;
}
