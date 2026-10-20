import { z } from "zod";
import { cleanText, getJson, isoDay, type FetchLike } from "./http";

/* ---------------------------------------------------------------------------
   Polymarket odds.

   Prediction markets price what happens next: a rate cut, a recession, an
   election. News says what happened and FRED says where things stand; the
   market's price is the crowd's odds, which is a third kind of evidence. It is
   shown as odds, never as a forecast this desk makes.

   Polymarket's Gamma API is public and read-only. It serves live prices only,
   so a market's probability is "as fetched" and is stored with its date by
   lib/signals/store.ts.
--------------------------------------------------------------------------- */

export interface PredictionMarket {
  question: string;
  outcome: string;
  // 0..1, the price of the first outcome
  probability: number;
  // yyyy-mm-dd
  endDate: string | null;
  volume: number;
  url: string;
}

// Gamma encodes outcomes and prices as JSON arrays inside strings.
const JsonArray = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}, z.array(z.unknown()).optional());

const Market = z.object({
  question: z.string().optional(),
  closed: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  outcomes: JsonArray,
  outcomePrices: JsonArray,
  volumeNum: z.number().nullable().optional(),
});

const Search = z.object({
  events: z
    .array(
      z.object({
        slug: z.string().optional(),
        markets: z.array(Market).optional(),
      })
    )
    .optional(),
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,160}$/i;

// Thinly traded markets are a few people's opinion; below this they are left out.
export const MIN_VOLUME_USD = 10_000;

// Open markets that resolve in the future, deepest first. `closed` is the
// reliable "resolved" flag: a market stays active after it settles.
export function parseMarkets(payload: unknown, now: Date = new Date()): PredictionMarket[] {
  const parsed = Search.safeParse(payload);
  if (!parsed.success) return [];

  const out: PredictionMarket[] = [];
  for (const event of parsed.data.events ?? []) {
    for (const market of event.markets ?? []) {
      if (market.closed || !market.question) continue;
      if (market.endDate && Date.parse(market.endDate) < now.getTime()) continue;

      const outcome = market.outcomes?.[0];
      const price = Number(market.outcomePrices?.[0]);
      if (typeof outcome !== "string" || !Number.isFinite(price) || price < 0 || price > 1) continue;

      const volume = market.volumeNum ?? 0;
      if (volume < MIN_VOLUME_USD) continue;

      out.push({
        question: cleanText(market.question),
        outcome: cleanText(outcome, 40),
        probability: price,
        endDate: isoDay(market.endDate),
        volume,
        url: event.slug && SLUG.test(event.slug) ? `https://polymarket.com/event/${event.slug}` : "https://polymarket.com",
      });
    }
  }
  return out.sort((a, b) => b.volume - a.volume);
}

export async function fetchMarkets(topic: string, fetchImpl?: FetchLike, now?: Date): Promise<PredictionMarket[]> {
  const body = await getJson(
    `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(topic)}&limit_per_type=20`,
    fetchImpl
  );
  return parseMarkets(body, now);
}

// Search is fuzzy: "Apple" also finds markets about apple pie. A market is
// kept only if its question actually names what was asked about.
export function matching(
  markets: PredictionMarket[],
  names: (question: string) => boolean,
  limit: number
): PredictionMarket[] {
  return markets.filter((m) => names(m.question)).slice(0, limit);
}
