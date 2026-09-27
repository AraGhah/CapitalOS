import { pool } from "./db";
import { cachedJson } from "./sec";
import { padCik } from "./edgar";
import { fetchChart } from "./quote";
import { findCompany, type CompanyRow } from "./company";

// Researching a ticker the desk has never seen has to create its companies row
// first. A symbol is only accepted if something real recognises it — SEC's own
// ticker file, or failing that Yahoo, which also covers ETFs and foreign listings
// that never file with the SEC. A typo matches neither and is refused, so the
// table does not fill up with rows for tickers that do not exist.

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

let tickerMap: Map<string, TickerEntry> | null = null;

async function loadTickerMap(): Promise<Map<string, TickerEntry>> {
  if (tickerMap) return tickerMap;

  const data = (await cachedJson(
    "company-tickers",
    "https://www.sec.gov/files/company_tickers.json"
  )) as Record<string, TickerEntry>;

  const map = new Map<string, TickerEntry>();
  for (const entry of Object.values(data)) map.set(entry.ticker.toUpperCase(), entry);
  tickerMap = map;
  return map;
}

export class UnknownTickerError extends Error {
  constructor(ticker: string) {
    super(`no listed company or fund found for "${ticker}"`);
    this.name = "UnknownTickerError";
  }
}

export async function resolveCompany(rawTicker: string): Promise<CompanyRow> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) throw new UnknownTickerError(rawTicker);

  const existing = await findCompany(ticker);
  if (existing) return existing;

  let name: string | null = null;
  let cik: string | null = null;

  try {
    const entry = (await loadTickerMap()).get(ticker);
    if (entry) {
      name = entry.title;
      cik = padCik(entry.cik_str);
    }
  } catch {
    // SEC unreachable — Yahoo below is the remaining way to confirm the symbol.
  }

  if (!name) {
    try {
      const chart = await fetchChart(ticker, "5d");
      if (chart.bars.length > 0 || chart.price !== null) name = ticker;
    } catch {
      // not a symbol Yahoo knows either
    }
  }

  if (!name) throw new UnknownTickerError(ticker);

  await pool.query(
    `INSERT INTO companies (ticker, name, cik) VALUES ($1, $2, $3)
     ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name`,
    [ticker, name, cik]
  );

  const created = await findCompany(ticker);
  if (!created) throw new Error(`could not create a company row for ${ticker}`);
  return created;
}
