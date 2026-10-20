import { z } from "zod";
import { getJson, isoDay, type FetchLike } from "./http";

/* ---------------------------------------------------------------------------
   StockTwits sentiment, as counts.

   TradingAgents' sentiment analyst reads StockTwits posts. Here only the
   label each author put on their own post is read — bullish, bearish or none —
   and counted. The text of a post is never fetched into the evidence pack: it
   is a stranger's words, it cannot be checked against anything, and a count of
   labels is the one part of it that is a figure.

   The public stream returns the 30 most recent posts for a symbol. It cannot
   be asked for a date, so a reading is only ever "now"; lib/signals/store.ts
   keeps the dated copies.
--------------------------------------------------------------------------- */

export interface SocialPulse {
  source: "stocktwits";
  symbol: string;
  messages: number;
  bullish: number;
  bearish: number;
  unlabeled: number;
  newest: string | null;
  oldest: string | null;
  url: string;
}

const Stream = z.object({
  messages: z.array(
    z.object({
      created_at: z.string().optional(),
      entities: z
        .object({ sentiment: z.object({ basic: z.string().nullable().optional() }).nullable().optional() })
        .nullable()
        .optional(),
    })
  ),
});

export const STREAM_SIZE = 30;

// StockTwits lists a share class as BRK.B and nothing else needs mapping for
// the equities this desk covers.
export function stocktwitsSymbol(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function parseStream(payload: unknown, ticker: string): SocialPulse | null {
  const parsed = Stream.safeParse(payload);
  if (!parsed.success) return null;

  const symbol = stocktwitsSymbol(ticker);
  const recent = parsed.data.messages.slice(0, STREAM_SIZE);
  let bullish = 0;
  let bearish = 0;
  let unlabeled = 0;
  const days: string[] = [];

  for (const message of recent) {
    const label = message.entities?.sentiment?.basic?.toLowerCase();
    if (label === "bullish") bullish++;
    else if (label === "bearish") bearish++;
    else unlabeled++;
    const day = isoDay(message.created_at);
    if (day) days.push(day);
  }
  days.sort();

  return {
    source: "stocktwits",
    symbol,
    messages: recent.length,
    bullish,
    bearish,
    unlabeled,
    newest: days.at(-1) ?? null,
    oldest: days[0] ?? null,
    url: `https://stocktwits.com/symbol/${encodeURIComponent(symbol)}`,
  };
}

export async function fetchStocktwits(ticker: string, fetchImpl?: FetchLike): Promise<SocialPulse> {
  const symbol = stocktwitsSymbol(ticker);
  const body = await getJson(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, fetchImpl);
  const pulse = parseStream(body, ticker);
  if (!pulse) throw new Error("StockTwits answered in a shape this desk does not read");
  return pulse;
}

// A share of fewer posts than this is noise, not a mood.
export const MIN_LABELLED = 5;

export function bullishShare(pulse: SocialPulse): number | null {
  const labelled = pulse.bullish + pulse.bearish;
  return labelled >= MIN_LABELLED ? pulse.bullish / labelled : null;
}
