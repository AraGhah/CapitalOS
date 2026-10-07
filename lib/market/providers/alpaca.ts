import Decimal from "decimal.js";
import { config } from "../../config";
import { fetchWithRetry, readJson } from "../../http";
import {
  rangeStart,
  UnsupportedSymbolError,
  withChange,
  type Bar,
  type Chart,
  type Dividend,
  type MarketDataProvider,
  type Range,
  type Split,
} from "../types";

/* ---------------------------------------------------------------------------
   Alpaca Market Data (https://docs.alpaca.markets/docs/about-market-data-api).

   Stocks:  GET data.alpaca.markets/v2/stocks/{symbol}/bars   (split-adjusted)
            GET data.alpaca.markets/v2/stocks/{symbol}/trades/latest
   Crypto:  GET data.alpaca.markets/v1beta3/crypto/us/bars?symbols=BTC/USD
   Actions: GET data.alpaca.markets/v1/corporate-actions?symbols=…&types=…
   Clock:   GET {trading host}/v2/clock — whether today's bar is still forming

   Authenticated with APCA-API-KEY-ID / APCA-API-SECRET-KEY. Bars are paged
   with next_page_token. The free plan serves the IEX feed.
--------------------------------------------------------------------------- */

const DATA = "https://data.alpaca.markets";

function headers(): Record<string, string> {
  const c = config();
  return {
    "APCA-API-KEY-ID": c.ALPACA_API_KEY_ID ?? "",
    "APCA-API-SECRET-KEY": c.ALPACA_API_SECRET_KEY ?? "",
    Accept: "application/json",
  };
}

function tradingHost(): string {
  return config().ALPACA_PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
}

async function getJson<T>(url: string, symbol: string): Promise<T> {
  const res = await fetchWithRetry(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  const body = await readJson<T & { message?: string }>(res);
  if (res.status === 404 || res.status === 422) throw new UnsupportedSymbolError("Alpaca", symbol);
  if (!res.ok || !body) throw new Error(`Alpaca ${res.status}: ${body?.message ?? res.statusText}`);
  return body;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function toBar(b: AlpacaBar): Bar {
  return { date: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
}

// "BTC-USD" (the desk's spelling) is "BTC/USD" on Alpaca's crypto API.
function cryptoPair(symbol: string): string | null {
  const m = symbol.toUpperCase().match(/^([A-Z]{2,6})-USD$/);
  return m ? `${m[1]}/USD` : null;
}

async function stockBars(symbol: string, start: Date): Promise<Bar[]> {
  const feed = config().ALPACA_DATA_FEED;
  const bars: Bar[] = [];
  let token: string | null = null;
  do {
    const params = new URLSearchParams({
      timeframe: "1Day",
      start: start.toISOString(),
      adjustment: "split",
      feed,
      limit: "10000",
    });
    if (token) params.set("page_token", token);
    const body: { bars: AlpacaBar[] | null; next_page_token: string | null } = await getJson(
      `${DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`,
      symbol
    );
    for (const b of body.bars ?? []) bars.push(toBar(b));
    token = body.next_page_token;
  } while (token);
  return bars;
}

async function cryptoBars(pair: string, start: Date): Promise<Bar[]> {
  const bars: Bar[] = [];
  let token: string | null = null;
  do {
    const params = new URLSearchParams({ symbols: pair, timeframe: "1Day", start: start.toISOString(), limit: "10000" });
    if (token) params.set("page_token", token);
    const body: { bars: Record<string, AlpacaBar[]>; next_page_token: string | null } = await getJson(
      `${DATA}/v1beta3/crypto/us/bars?${params}`,
      pair
    );
    for (const b of body.bars?.[pair] ?? []) bars.push(toBar(b));
    token = body.next_page_token;
  } while (token);
  return bars;
}

async function marketOpen(): Promise<boolean> {
  try {
    const clock = await getJson<{ is_open: boolean }>(`${tradingHost()}/v2/clock`, "clock");
    return clock.is_open;
  } catch {
    // Unknown: treat today's bar as possibly still forming.
    return true;
  }
}

interface CorporateActions {
  corporate_actions: {
    forward_splits?: Array<{ ex_date: string; new_rate: number; old_rate: number }>;
    reverse_splits?: Array<{ ex_date: string; new_rate: number; old_rate: number }>;
    cash_dividends?: Array<{ ex_date: string; payable_date?: string | null; rate: number }>;
  };
  next_page_token: string | null;
}

async function corporateActions(symbol: string, types: string): Promise<CorporateActions["corporate_actions"]> {
  const out: CorporateActions["corporate_actions"] = { forward_splits: [], reverse_splits: [], cash_dividends: [] };
  let token: string | null = null;
  do {
    const params = new URLSearchParams({ symbols: symbol, types, start: "1990-01-01", limit: "1000" });
    if (token) params.set("page_token", token);
    const body: CorporateActions = await getJson(`${DATA}/v1/corporate-actions?${params}`, symbol);
    out.forward_splits!.push(...(body.corporate_actions.forward_splits ?? []));
    out.reverse_splits!.push(...(body.corporate_actions.reverse_splits ?? []));
    out.cash_dividends!.push(...(body.corporate_actions.cash_dividends ?? []));
    token = body.next_page_token;
  } while (token);
  return out;
}

export const alpaca: MarketDataProvider = {
  name: "alpaca",
  licensed: true,

  async chart(ticker: string, range: Range): Promise<Chart> {
    const pair = cryptoPair(ticker);
    if (ticker.startsWith("^")) throw new UnsupportedSymbolError("Alpaca", ticker);
    const start = rangeStart(range);

    if (pair) {
      const bars = await cryptoBars(pair, start);
      const last = bars.at(-1);
      return withChange({
        ticker: ticker.toUpperCase(),
        currency: "USD",
        price: last?.close ?? null,
        previousClose: bars.at(-2)?.close ?? null,
        bars,
        // crypto trades around the clock: the latest day is always forming
        lastBarComplete: false,
        source: "alpaca",
      });
    }

    const symbol = ticker.toUpperCase();
    const [bars, latest, open] = await Promise.all([
      stockBars(symbol, start),
      getJson<{ trade?: { p: number } }>(
        `${DATA}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=${config().ALPACA_DATA_FEED}`,
        symbol
      ).catch(() => null),
      marketOpen(),
    ]);
    if (bars.length === 0 && !latest?.trade) throw new UnsupportedSymbolError("Alpaca", symbol);

    const today = new Date().toISOString().slice(0, 10);
    const lastBar = bars.at(-1);
    const forming = open && lastBar?.date === today;
    return withChange({
      ticker: symbol,
      currency: "USD",
      price: latest?.trade?.p ?? lastBar?.close ?? null,
      previousClose: (forming ? bars.at(-2)?.close : lastBar?.close) ?? null,
      bars,
      lastBarComplete: !forming,
      source: "alpaca",
    });
  },

  async splits(ticker: string): Promise<Split[]> {
    const actions = await corporateActions(ticker.toUpperCase(), "forward_split,reverse_split");
    return [...(actions.forward_splits ?? []), ...(actions.reverse_splits ?? [])]
      .filter((s) => s.new_rate > 0 && s.old_rate > 0)
      .map((s) => ({ date: s.ex_date, ratio: new Decimal(s.new_rate).div(s.old_rate) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  async dividends(ticker: string): Promise<Dividend[]> {
    const actions = await corporateActions(ticker.toUpperCase(), "cash_dividend");
    return (actions.cash_dividends ?? [])
      .filter((d) => d.rate > 0)
      .map((d) => ({ exDate: d.ex_date, payDate: d.payable_date ?? null, amount: new Decimal(d.rate) }))
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  },
};
