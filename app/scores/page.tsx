import Link from "next/link";
import { getScores } from "@/lib/scoring";

export const dynamic = "force-dynamic";

const RATE_COMPONENTS = new Set([
  "revenue_growth",
  "gross_margin",
  "gross_margin_trend",
  "operating_margin",
  "operating_margin_trend",
  "fcf_margin",
  "roic",
]);

function label(component: string): string {
  return component.replace(/_/g, " ");
}

function formatRaw(component: string, value: number | null): string {
  if (value === null) return "—";
  if (RATE_COMPONENTS.has(component)) return `${(value * 100).toFixed(1)}%`;
  return `${value.toFixed(1)}x`;
}

export default async function ScoresPage() {
  const scores = await getScores();

  if (scores.length === 0) {
    return (
      <div>
        <h1>Scores</h1>
        <p>
          Nothing scored yet — run <code>npm run ingest-edgar</code>, then{" "}
          <code>npm run compute-scores</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1>Scores</h1>
      <p className="subtle">Percentile ranked within sector, as of {scores[0].asOf}.</p>

      <table style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Sector</th>
            <th>Coverage</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s) => (
            <tr key={s.companyId}>
              <td>
                <Link href={`/research/${s.ticker}`}>{s.ticker}</Link>
              </td>
              <td style={{ textAlign: "right" }}>{s.sector ?? "unclassified"}</td>
              <td>
                {s.coverage.present} of {s.coverage.expected}
              </td>
              <td>{s.total.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Breakdown</h2>
      {scores.map((s) => (
        <details key={s.companyId}>
          <summary>
            {s.ticker} — {s.total.toFixed(1)}
          </summary>
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Value</th>
                <th>Percentile</th>
                <th>Weight</th>
                <th>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {s.components.map((c) => (
                <tr key={c.component}>
                  <td>{label(c.component)}</td>
                  <td>{formatRaw(c.component, c.rawValue)}</td>
                  <td>{(c.percentile * 100).toFixed(0)}</td>
                  <td>{c.weight.toFixed(2)}</td>
                  <td>{c.contribution.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}
