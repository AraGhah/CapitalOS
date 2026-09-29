import Link from "next/link";
import { METRICS, METRIC_KEYS, formatMetric, parseScreen, scan, describeRule, type MetricKey } from "@/lib/scanner";
import { ScreenBuilder } from "@/app/components/ScreenBuilder";

export const dynamic = "force-dynamic";

const COLUMNS: MetricKey[] = ["revenue_growth", "operating_margin", "fcf_margin", "roic", "pe", "fcf_yield", "return_3m", "below_high", "score"];

export default async function ScannerPage({ searchParams }: PageProps<"/scanner">) {
  const params = await searchParams;
  const text = typeof params.rules === "string" ? params.rules : "";
  const parsed = text ? parseScreen(text) : { rules: [], errors: [] };
  const result = await scan(parsed.rules);

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Discover · screens over filings and prices</p>
          <h1>Opportunity Scanner</h1>
        </div>
        <span className="subtle">{result.universe} companies with annual filings on the desk</span>
      </div>

      {parsed.errors.map((e, i) => (
        <p key={i} className="alert" style={{ marginBottom: "0.5rem" }}>
          {e}
        </p>
      ))}

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>{result.custom ? "Custom screen results" : "Today's research queue"}</h2>
              <span className="hint">
                {result.custom ? result.custom.description : "every company a screen caught, most screens first"}
              </span>
            </div>
            {result.queue.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                Nothing passes {result.custom ? "this screen" : "any screen"} today.
              </p>
            ) : (
              <div>
                {result.queue.map((row) => (
                  <div key={row.ticker} className="claim-row" style={{ gridTemplateColumns: "4.5rem minmax(0, 1fr) auto" }}>
                    <Link href={`/research/${row.ticker}`} className="num" style={{ fontWeight: 600 }}>
                      {row.ticker}
                    </Link>
                    <div>
                      <p>{row.name}</p>
                      {row.matches.map((m) => (
                        <div key={m.screen} className="meta">
                          <span className={`pill ${m.screen === "custom" ? "info" : "good"}`}>{m.name}</span>
                          <span>{m.reasons.join(" · ")}</span>
                        </div>
                      ))}
                    </div>
                    <Link href={`/committee?ticker=${row.ticker}`} className="chip" style={{ alignSelf: "start" }}>
                      Convene
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Build a screen</h2>
              <span className="hint">every rule must hold; missing data fails the rule</span>
            </div>
            <ScreenBuilder
              metrics={METRIC_KEYS.map((k) => ({ key: k, label: METRICS[k].label, unit: METRICS[k].unit }))}
              initial={parsed.rules}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>The universe</h2>
              <span className="hint">latest annual filing, live price</span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    {COLUMNS.map((c) => (
                      <th key={c}>{METRICS[c].label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...result.rows]
                    .sort((a, b) => (b.metrics.score ?? -1) - (a.metrics.score ?? -1))
                    .map((row) => (
                      <tr key={row.ticker}>
                        <td>
                          <Link href={`/research/${row.ticker}`} className="sym">
                            {row.ticker}
                          </Link>
                        </td>
                        {COLUMNS.map((c) => {
                          const v = row.metrics[c];
                          return (
                            <td key={c} className="num">
                              {v === undefined ? <span className="subtle">—</span> : formatMetric(c, v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Standing screens</h2>
            </div>
            <ul className="rail">
              {result.screens
                .filter((s) => s.id !== "custom")
                .map((s) => {
                  const hits = result.rows.filter((r) => r.matches.some((m) => m.screen === s.id)).length;
                  return (
                    <li key={s.id} title={s.rules.map(describeRule).join("\n")}>
                      <span className="feed-name">
                        <Link href={`/scanner?rules=${encodeURIComponent(s.rules.map((r) => `${r.metric}${r.op}${r.value}`).join(";"))}`}>
                          {s.name}
                        </Link>
                      </span>
                      <span className="count">{hits}</span>
                    </li>
                  );
                })}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Growing the universe</h2>
            </div>
            <div className="panel-body stack-sm subtle">
              <p>
                The scanner covers every company with annual filings on the desk. Add more by researching a ticker and
                running <code>npm run ingest-edgar</code>, then <code>npm run compute-scores</code>.
              </p>
              <p>
                Or describe a strategy to the <Link href="/ask">Capital Copilot</Link> — it can turn “profitable
                companies growing over 20% that have fallen 15% from their highs” into a screen and run it.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
