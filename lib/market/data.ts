import { config } from "../config";
import { log } from "../log";
import { take, UPSTREAM } from "../ratelimit";
import { alpaca } from "./providers/alpaca";
import { yahoo } from "./providers/yahoo";
import { NoMarketDataError, type Chart, type Dividend, type MarketDataProvider, type Range, type Split } from "./types";

export * from "./types";

/* ---------------------------------------------------------------------------
   Market data, behind one interface.

   Every price, split and dividend the desk uses comes through a provider:
   - alpaca: Alpaca Market Data (licensed; the free IEX feed or paid SIP). The
     production provider.
   - yahoo: Yahoo Finance's undocumented chart endpoint. Not licensed for
     redistribution or commercial use and liable to change without notice, so
     it is a development convenience only: used when chosen explicitly, or in
     development when no licensed provider is configured, and never in
     production by default.

   Each stored price row records which provider it came from.
--------------------------------------------------------------------------- */

let warned = false;

export function marketData(): MarketDataProvider {
  const c = config();
  const hasAlpaca = Boolean(c.ALPACA_API_KEY_ID && c.ALPACA_API_SECRET_KEY);

  if (c.MARKET_DATA_PROVIDER === "alpaca") {
    if (!hasAlpaca) throw new NoMarketDataError();
    return alpaca;
  }
  if (c.MARKET_DATA_PROVIDER === "auto" && hasAlpaca) return alpaca;
  if (c.MARKET_DATA_PROVIDER === "auto" && c.NODE_ENV === "production") throw new NoMarketDataError();

  if (!warned) {
    warned = true;
    log.warn("market data is coming from Yahoo's unofficial endpoint — fine for personal development, not for a deployed product");
  }
  return yahoo;
}

// Rate-limited, shared by every process.
export async function chart(ticker: string, range: Range): Promise<Chart> {
  const provider = marketData();
  await take(provider.name === "alpaca" ? UPSTREAM.alpaca : UPSTREAM.yahoo);
  return provider.chart(ticker, range);
}

export async function splits(ticker: string): Promise<Split[]> {
  const provider = marketData();
  await take(provider.name === "alpaca" ? UPSTREAM.alpaca : UPSTREAM.yahoo);
  return provider.splits(ticker);
}

export async function dividends(ticker: string): Promise<Dividend[]> {
  const provider = marketData();
  await take(provider.name === "alpaca" ? UPSTREAM.alpaca : UPSTREAM.yahoo);
  return provider.dividends(ticker);
}

