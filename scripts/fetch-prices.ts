import "../lib/env";
import { pool } from "../lib/db";
import { BENCHMARK_TICKER } from "../lib/constants";

const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

interface DailyBar {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

async function resolveCompanyId(ticker: string): Promise<string> {
  const existing = await pool.query("SELECT id FROM companies WHERE ticker = $1", [ticker]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await pool.query(
    "INSERT INTO companies (ticker, name) VALUES ($1, $1) RETURNING id",
    [ticker]
  );
  return created.rows[0].id;
}

async function fetchDaily(ticker: string): Promise<DailyBar[]> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=full&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const series = data["Time Series (Daily)"];
  if (!series) {
    console.error(`no data for ${ticker}:`, data["Note"] ?? data["Information"] ?? data);
    return [];
  }

  return Object.entries(series).map(([date, values]) => {
    const v = values as Record<string, string>;
    return {
      date,
      open: v["1. open"],
      high: v["2. high"],
      low: v["3. low"],
      close: v["4. close"],
      volume: v["5. volume"],
    };
  });
}

async function upsertPrices(companyId: string, bars: DailyBar[]) {
  for (const bar of bars) {
    await pool.query(
      `INSERT INTO prices_daily (company_id, date, open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, date) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume`,
      [companyId, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume]
    );
  }
}

async function main() {
  if (!API_KEY) {
    console.error("set ALPHA_VANTAGE_API_KEY in .env.local first (free key at alphavantage.co/support/#api-key)");
    process.exit(1);
  }

  const { rows: companies } = await pool.query("SELECT ticker FROM companies WHERE active = true");
  const tickers = new Set(companies.map((c) => c.ticker as string));
  tickers.add(BENCHMARK_TICKER);

  for (const ticker of tickers) {
    console.log(`fetching ${ticker}...`);
    const companyId = await resolveCompanyId(ticker);
    const bars = await fetchDaily(ticker);
    await upsertPrices(companyId, bars);
    console.log(`  ${bars.length} rows`);

    // free tier: 5 calls/min
    await new Promise((r) => setTimeout(r, 12000));
  }

  await pool.end();
}

main();
