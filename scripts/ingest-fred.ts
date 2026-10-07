import "../lib/env";
import { secUserAgent } from "../lib/config";
import { pool } from "../lib/db";

// Rates, inflation, growth and the dollar — enough context to read a company
// against its macro backdrop without a separate agent narrating it.
const DEFAULT_SERIES = [
  "DGS10", // 10-year treasury
  "DGS2", // 2-year treasury
  "T10Y2Y", // 10y minus 2y, negative when the curve inverts
  "FEDFUNDS", // effective fed funds rate
  "CPIAUCSL", // consumer price index
  "UNRATE", // unemployment
  "GDPC1", // real GDP
  "DTWEXBGS", // trade-weighted dollar
];

interface Observation {
  date: string;
  value: number;
}

// fredgraph.csv is open, so no key and no account. A missing reading — a market
// holiday, a report that was never published — is a gap in the series rather
// than a zero. Older files mark it with a lone full stop; current ones leave the
// cell empty, and Number("") is 0, so both are checked before converting.
function parseCsv(csv: string): Observation[] {
  const [, ...lines] = csv.trim().split(/\r?\n/);

  return lines.flatMap((line) => {
    const [date, raw] = line.split(",");
    if (!date || raw === undefined) return [];

    const cell = raw.trim();
    if (cell === "" || cell === ".") return [];
    const value = Number(cell);
    if (!Number.isFinite(value)) return [];
    return [{ date, value }];
  });
}

async function fetchSeries(seriesId: string): Promise<Observation[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, {
    headers: { "User-Agent": secUserAgent() },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const csv = await res.text();
  if (!csv.startsWith("observation_date") && !csv.startsWith("DATE")) {
    throw new Error(`unexpected response: ${csv.trim().slice(0, 80)}`);
  }
  return parseCsv(csv);
}

async function store(seriesId: string, observations: Observation[]) {
  if (observations.length === 0) return;

  // A revised reading replaces the old one: unlike fundamentals, macro series
  // carry no filing behind them, so there is no restatement history to keep.
  await pool.query(
    `INSERT INTO macro_series (series_id, date, value)
     SELECT $1, date::date, value
     FROM unnest($2::text[], $3::numeric[]) AS t(date, value)
     ON CONFLICT (series_id, date) DO UPDATE SET value = EXCLUDED.value`,
    [seriesId, observations.map((o) => o.date), observations.map((o) => o.value)]
  );
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const series = requested.length > 0 ? requested : DEFAULT_SERIES;

  for (const seriesId of series) {
    try {
      const observations = await fetchSeries(seriesId);
      await store(seriesId, observations);
      const first = observations[0]?.date ?? "-";
      const last = observations.at(-1);
      console.log(
        `${seriesId}: ${observations.length} observations ${first}..${last?.date ?? "-"}` +
          (last ? ` (latest ${last.value})` : "")
      );
    } catch (err) {
      console.error(`${seriesId}: ${(err as Error).message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  await pool.end();
}

main();
