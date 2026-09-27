import Link from "next/link";
import { getScores } from "@/lib/scoring";
import { Meter, PercentileGauge } from "@/app/components/Readouts";

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
        <div className="page-head">
          <div>
            <p className="eyebrow">Ranking</p>
            <h1>Scores</h1>
          </div>
        </div>
        <section className="panel">
          <div className="panel-body">
            <p className="missing">
              Nothing scored yet — run <code>npm run ingest-edgar</code>, then{" "}
              <code>npm run compute-scores</code>.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Ranking · as of {scores[0].asOf}</p>
          <h1>Scores</h1>
          <p className="subtle">
            Every component is a percentile within its own sector, weighted by{" "}
            <code>weights.json</code>. Change a weight and the total moves on the next run.
          </p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Universe</h2>
              <span className="hint">{scores.length} scored</span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th className="wide">Sector</th>
                    <th>Inputs</th>
                    <th></th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s) => (
                    <tr key={s.companyId}>
                      <td>
                        <Link href={`/research/${s.ticker}`} className="sym">
                          {s.ticker}
                        </Link>
                      </td>
                      <td className="wide">{s.sector ?? "unclassified"}</td>
                      <td className="num">
                        {s.coverage.present}
                        <span style={{ color: "var(--faint)" }}>/{s.coverage.expected}</span>
                      </td>
                      <td>
                        <Meter share={s.total / 100} />
                      </td>
                      <td className="num">{s.total.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Breakdown</h2>
              <span className="hint">every number reconstructable from stored rows</span>
            </div>
            {scores.map((s) => (
              <details key={s.companyId}>
                <summary>
                  <span>
                    <span className="sym">{s.ticker}</span>
                    <span className="subtle" style={{ marginLeft: "0.6rem" }}>
                      {s.coverage.present} of {s.coverage.expected} components
                    </span>
                  </span>
                  <span className="num">{s.total.toFixed(1)}</span>
                </summary>
                <div className="panel-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="wide">Component</th>
                        <th>Value</th>
                        <th></th>
                        <th>Percentile</th>
                        <th>Weight</th>
                        <th>Contribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.components.map((c) => (
                        <tr key={c.component}>
                          <td className="wide">{label(c.component)}</td>
                          <td className="num">{formatRaw(c.component, c.rawValue)}</td>
                          <td>
                            <Meter share={c.percentile} />
                          </td>
                          <td className="num">{(c.percentile * 100).toFixed(0)}</td>
                          <td className="num">{c.weight.toFixed(2)}</td>
                          <td className="num">{c.contribution.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Spread</h2>
              <span className="hint">top to bottom</span>
            </div>
            <div className="panel-body">
              <div className="tile" style={{ border: "none", boxShadow: "none", padding: 0 }}>
                <span className="label">Highest</span>
                <div className="value">{scores[0].total.toFixed(1)}</div>
                <div className="foot">{scores[0].ticker}</div>
              </div>
              <PercentileGauge percentile={scores[0].total} />
              <div
                className="tile"
                style={{ border: "none", boxShadow: "none", padding: 0, marginTop: "1rem" }}
              >
                <span className="label">Lowest</span>
                <div className="value">{scores[scores.length - 1].total.toFixed(1)}</div>
                <div className="foot">{scores[scores.length - 1].ticker}</div>
              </div>
              <PercentileGauge percentile={scores[scores.length - 1].total} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
