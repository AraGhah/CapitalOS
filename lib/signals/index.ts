import type { EvidenceItem } from "../ai/evidence";
import { config } from "../config";
import { errorFields, log } from "../log";
import { searchName } from "../news";
import { isoDay, type FetchLike } from "./http";
import { fetchMarkets, matching, type PredictionMarket } from "./polymarket";
import { bullishShare, fetchStocktwits, type SocialPulse } from "./stocktwits";
import { cachedSnapshot, type SnapshotReader } from "./store";

/* ---------------------------------------------------------------------------
   Outside signals as evidence.

   StockTwits' author-labelled sentiment and Polymarket's odds, ported from
   TradingAgents' data vendors, arrive in the committee's evidence pack as
   numbered items like every other figure. A feed that is switched off, down or
   empty is reported as "not retrieved" in the pack's coverage line; it never
   becomes a guess.
--------------------------------------------------------------------------- */

type Item = Omit<EvidenceItem, "id">;

export type SignalFeed = "stocktwits" | "polymarket";

export interface SignalResult {
  items: Item[];
  inputs: Array<{ name: string; present: boolean }>;
}

export interface SignalOptions {
  feeds?: readonly SignalFeed[];
  ttlMinutes?: number;
  fetchImpl?: FetchLike;
  snapshot?: SnapshotReader;
}

/* --------------------------------------------------------------- conversions */

export function socialItems(pulse: SocialPulse, fetchedAt: string): Item[] {
  if (pulse.messages === 0) return [];
  const asOf = pulse.newest ?? isoDay(fetchedAt) ?? undefined;
  const source = { kind: "stocktwits", ref: `StockTwits symbol stream, ${pulse.messages} most recent posts`, url: pulse.url };

  const items: Item[] = [
    {
      kind: "social",
      label: "Posts in the latest StockTwits stream",
      value: pulse.messages,
      unit: "count",
      asOf,
      text:
        "only the bullish or bearish label each author put on their own post is counted; the posts were not read. " +
        "A self-selected, easily manipulated crowd: weak evidence on its own",
      source,
    },
    { kind: "social", label: "StockTwits posts their authors labelled bullish", value: pulse.bullish, unit: "count", asOf, source },
    { kind: "social", label: "StockTwits posts their authors labelled bearish", value: pulse.bearish, unit: "count", asOf, source },
  ];

  const share = bullishShare(pulse);
  items.push(
    share === null
      ? { kind: "social", label: "Bullish share of labelled StockTwits posts", asOf, text: "too few posts carry a label to compute a share", source }
      : { kind: "social", label: "Bullish share of labelled StockTwits posts", value: share, unit: "ratio", asOf, source }
  );
  return items;
}

export function predictionItems(markets: PredictionMarket[], fetchedAt: string): Item[] {
  const asOf = isoDay(fetchedAt) ?? undefined;
  return markets.map((m) => ({
    kind: "prediction",
    label: `Polymarket odds for "${m.question}": implied probability of "${m.outcome}"`,
    value: m.probability,
    unit: "ratio",
    asOf,
    text: `open market, ranked by traded volume${m.endDate ? `, resolves ${m.endDate}` : ""}. The crowd's priced odds, not a forecast made here`,
    source: { kind: "polymarket", ref: "Polymarket Gamma API (public)", url: m.url },
  }));
}

/* ------------------------------------------------------------------ topics */

// Macro events that move any equity, searched for every company; company-named
// markets are searched for separately.
const MACRO_TOPICS: Array<{ topic: string; names: RegExp; limit: number }> = [
  { topic: "Fed rate cut", names: /\b(fed|fomc|federal reserve|interest rates?|rate (cuts?|hikes?))\b/i, limit: 2 },
  { topic: "US recession", names: /\brecession\b/i, limit: 2 },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A question is about the company if it names it, or names its ticker when the
// ticker is long enough not to be an ordinary word ("A", "ON", "ALL").
export function namesCompany(ticker: string, companyName: string): (question: string) => boolean {
  const core = searchName(companyName);
  const byName = core.length >= 3 ? new RegExp(`\\b${escape(core)}\\b`, "i") : null;
  const byTicker = ticker.length >= 3 ? new RegExp(`(^|[^A-Za-z0-9])\\$?${escape(ticker)}($|[^A-Za-z0-9])`) : null;
  return (question) => Boolean(byName?.test(question) || byTicker?.test(question));
}

/* ---------------------------------------------------------------- gathering */

export async function gatherSignals(
  company: { ticker: string; name: string },
  options: SignalOptions = {}
): Promise<SignalResult> {
  const feeds = new Set(options.feeds ?? config().SIGNAL_FEEDS);
  const ttl = options.ttlMinutes ?? config().SIGNAL_TTL_MINUTES;
  const read = options.snapshot ?? cachedSnapshot;

  // Each feed fills its own list; they are joined in a fixed order below, so
  // the pack (and its hash) does not depend on which feed answered first.
  const social = async (): Promise<SignalResult> => {
    try {
      const snap = await read("stocktwits", company.ticker.toUpperCase(), ttl, () => fetchStocktwits(company.ticker, options.fetchImpl));
      const items = socialItems(snap.payload, snap.fetchedAt);
      return { items, inputs: [{ name: "StockTwits sentiment", present: items.length > 0 }] };
    } catch (err) {
      log.warn({ ...errorFields(err), ticker: company.ticker }, "StockTwits not retrieved");
      return { items: [], inputs: [{ name: "StockTwits sentiment", present: false }] };
    }
  };

  const predictions = async (): Promise<SignalResult> => {
    const topics = [
      { topic: searchName(company.name) || company.ticker, names: namesCompany(company.ticker, company.name), limit: 3 },
      ...MACRO_TOPICS.map((t) => ({ topic: t.topic, names: (q: string) => t.names.test(q), limit: t.limit })),
    ];
    // The topics are independent: one search failing leaves the others.
    const settled = await Promise.allSettled(
      topics.map(async (t) => {
        const snap = await read("polymarket", t.topic.toLowerCase(), ttl, () => fetchMarkets(t.topic, options.fetchImpl));
        return { markets: matching(snap.payload, t.names, t.limit), fetchedAt: snap.fetchedAt };
      })
    );

    const seen = new Set<string>();
    const items: Item[] = [];
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log.warn(errorFields(outcome.reason), "Polymarket search not retrieved");
        continue;
      }
      const fresh = outcome.value.markets.filter((m) => {
        if (seen.has(m.question)) return false;
        seen.add(m.question);
        return true;
      });
      items.push(...predictionItems(fresh, outcome.value.fetchedAt));
    }
    return { items, inputs: [{ name: "Polymarket odds", present: items.length > 0 }] };
  };

  const parts = await Promise.all([feeds.has("stocktwits") ? social() : null, feeds.has("polymarket") ? predictions() : null]);
  return {
    items: parts.flatMap((p) => p?.items ?? []),
    inputs: parts.flatMap((p) => p?.inputs ?? []),
  };
}
