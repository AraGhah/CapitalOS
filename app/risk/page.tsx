import Link from "next/link";
import { analyzeRisk, basisFrom, type RiskReport } from "@/lib/risk/engine";
import { FACTORS } from "@/lib/risk/scenarios";
import { money } from "@/lib/format";
import { Meter } from "@/app/components/Readouts";
import { BasketPicker } from "@/app/components/BasketPicker";
import { ScenarioSimulator } from "@/app/components/ScenarioSimulator";

export const dynamic = "force-dynamic";

function pct(x: number | null, digits = 1, signed = false): string {
  if (x === null) return "—";
  const sign = signed ? (x >= 0 ? "+" : "−") : x < 0 ? "−" : "";
  return `${sign}${Math.abs(x * 100).toFixed(digits)}%`;
}

const SEVERITY: Record<string, string> = { high: "bad", warn: "warn", info: "info" };

export default async function RiskPage({ searchParams }: PageProps<"/risk">) {
  const params = await searchParams;
  const basket = typeof params.basket === "string" ? params.basket : "";
  const source = typeof params.source === "string" ? params.source : null;
  const report = await analyzeRisk(basisFrom({ basket, source }));

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Portfolio · risk, exposure and scenarios</p>
          <h1>Risk</h1>
        </div>
        {report.window && (
          <span className="subtle">
            {report.label} · {report.window.sessions} sessions to {report.window.end}
          </span>
        )}
      </div>

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <BasketPicker basis={report.basis} basket={basket} />
      </section>

      {report.warnings.map((w, i) => (
        <p key={i} className="alert" style={{ marginBottom: "0.5rem" }}>
          {w}
        </p>
      ))}

      {report.positions.length === 0 ? (
        <section className="panel">
          <div className="panel-body">
            <p className="missing">
              {report.basis === "holdings" ? (
                <>
                  Nothing is held yet. Add a trade on the <Link href="/transactions">Ledger</Link>, measure the
                  watchlist, or type a what-if basket above — for example <code>NVDA:30, AMD:20, MSFT:30, XOM:20</code>.
                </>
              ) : (
                "Nothing to measure."
              )}
            </p>
          </div>
        </section>
      ) : (
        <Report report={report} />
      )}
    </div>
  );
}

function Report({ report }: { report: RiskReport }) {
  const p = report.portfolio;
  return (
    <>
      <div className="tiles four" style={{ marginBottom: "1rem" }}>
        <Tile label="Volatility" value={pct(p.vol)} foot="annualised, daily returns" />
        <Tile label="Beta" value={p.beta === null ? "—" : p.beta.toFixed(2)} foot="to the S&P 500" />
        <Tile label="Max drawdown" value={pct(p.maxDrawdown)} tone="down" foot="worst fall from a peak" />
        <Tile label="1-day VaR 95%" value={pct(p.var95)} foot="loss exceeded 1 day in 20" />
        <Tile
          label="1-year return"
          value={pct(p.return1y, 1, true)}
          tone={p.return1y !== null && p.return1y >= 0 ? "up" : "down"}
          foot={`SPY ${pct(p.benchmarkReturn1y, 1, true)}, at today's weights`}
        />
        <Tile label="Sharpe" value={p.sharpe === null ? "—" : p.sharpe.toFixed(2)} foot="over the 2-year Treasury" />
        <Tile
          label="Effective positions"
          value={p.effectiveN.toFixed(1)}
          foot={`of ${report.positions.length}; top weight ${pct(p.topWeight, 0)}`}
        />
        <Tile
          label="Today"
          value={pct(p.dayChange, 2, true)}
          tone={p.dayChange !== null && p.dayChange >= 0 ? "up" : "down"}
          foot={p.marketValue !== null && p.dayChange !== null ? money(p.marketValue * p.dayChange) : "last close vs the one before"}
        />
      </div>

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <div className="panel-head">
          <h2>What the numbers say</h2>
          <span className="hint">each one a fixed threshold on a computed figure</span>
        </div>
        <ul className="why panel-body">
          {report.findings.map((f, i) => (
            <li key={i}>
              <span className={`pill ${SEVERITY[f.severity]}`}>{f.severity === "info" ? "note" : f.severity}</span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Positions</h2>
              <span className="hint">risk share: each position&apos;s part of the portfolio&apos;s variance</span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Weight</th>
                    <th>Risk share</th>
                    <th></th>
                    <th>Vol</th>
                    <th>Beta</th>
                    <th>Today</th>
                    <th>Effect</th>
                    <th>Days to exit</th>
                  </tr>
                </thead>
                <tbody>
                  {report.positions.map((pos) => (
                    <tr key={pos.ticker}>
                      <td>
                        <Link href={`/research/${pos.ticker}`} className="sym">
                          {pos.ticker}
                        </Link>
                      </td>
                      <td className="num">{pct(pos.weight)}</td>
                      <td className={`num ${pos.riskShare !== null && pos.riskShare > pos.weight * 1.3 ? "down" : ""}`}>
                        {pct(pos.riskShare)}
                      </td>
                      <td>
                        <Meter share={Math.max(0, pos.riskShare ?? 0)} />
                      </td>
                      <td className="num">{pct(pos.vol, 0)}</td>
                      <td className="num">{pos.beta === null ? "—" : pos.beta.toFixed(2)}</td>
                      <td className={`num ${pos.dayChange !== null && pos.dayChange < 0 ? "down" : "up"}`}>{pct(pos.dayChange, 2, true)}</td>
                      <td className={`num ${pos.dayContribution !== null && pos.dayContribution < 0 ? "down" : "up"}`}>
                        {pct(pos.dayContribution, 2, true)}
                      </td>
                      <td className="num">{pos.daysToExit === null ? "—" : pos.daysToExit.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <ScenarioSimulator exposures={report.exposures} />

          <section className="panel">
            <div className="panel-head">
              <h2>Factor exposure</h2>
              <span className="hint">beta to each proxy; faint when the proxy explains under 25% of daily moves</span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    {FACTORS.map((f) => (
                      <th key={f.id} title={`${f.label}: ${f.means}`}>
                        {f.proxy}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.exposures.map((row) => (
                    <tr key={row.ticker}>
                      <td>
                        <span className="sym">{row.ticker}</span>
                      </td>
                      {FACTORS.map((f) => {
                        const b = row.betas[f.id];
                        const r2 = row.r2[f.id] ?? 0;
                        return (
                          <td
                            key={f.id}
                            className="num"
                            style={{ color: r2 < 0.25 ? "var(--faint)" : undefined }}
                            title={`R² ${(r2 * 100).toFixed(0)}%`}
                          >
                            {b === null || b === undefined ? "—" : b.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Portfolio</strong>
                    </td>
                    {report.factors.map((f) => (
                      <td key={f.id} className="num" title={`explains ${(f.explained * 100).toFixed(0)}%, weighted`}>
                        <strong>{f.portfolioBeta === null ? "—" : f.portfolioBeta.toFixed(2)}</strong>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {report.correlation.tickers.length > 1 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Correlation</h2>
                <span className="hint">
                  daily returns · average between positions {p.avgCorrelation === null ? "—" : p.avgCorrelation.toFixed(2)}
                </span>
              </div>
              <div className="panel-scroll">
                <table className="heat">
                  <thead>
                    <tr>
                      <th></th>
                      {report.correlation.tickers.map((t) => (
                        <th key={t}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.correlation.tickers.map((t, i) => (
                      <tr key={t}>
                        <td>
                          <span className="sym">{t}</span>
                        </td>
                        {report.correlation.matrix[i].map((c, j) => (
                          <td key={j} className="num" style={heat(c, i === j)}>
                            {c === null ? "—" : c.toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Sectors</h2>
            </div>
            <ul className="rail">
              {report.sectors.map((s) => (
                <li key={s.sector}>
                  <span className="feed-name">{s.sector}</span>
                  <Meter share={s.weight} />
                  <span className="count">{pct(s.weight, 0)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Moves together</h2>
              <span className="hint">correlation ≥ 0.70</span>
            </div>
            {report.clusters.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No group of positions moves closely enough to act as one.
              </p>
            ) : (
              <ul className="rail">
                {report.clusters.map((c) => (
                  <li key={c.tickers.join()}>
                    <span className="feed-name">{c.tickers.join(" · ")}</span>
                    <span className="count">{pct(c.weight, 0)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>How this is measured</h2>
            </div>
            <div className="panel-body stack-sm subtle">
              <p>
                One year of daily closes ({report.window?.start} to {report.window?.end}), with today&apos;s weights held
                constant. Every figure is computed in <code>lib/risk</code>; no model is involved.
              </p>
              <p>
                Factors are measured through ETFs that track them. Rates use TLT, which rises when long-term rates
                fall. Days to exit assume trading 10% of a stock&apos;s average daily dollar volume.
              </p>
              <p>Sources: {report.sources.join("; ")}.</p>
              <p>
                Ask the <Link href="/ask">Capital Copilot</Link> “which position carries the most risk?” or “what if
                semiconductors fall 30%?” — it reads these same numbers.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, foot, tone }: { label: string; value: string; foot: string; tone?: "up" | "down" }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <div className={`value ${tone ?? ""}`.trim()}>{value}</div>
      <div className="foot">{foot}</div>
    </div>
  );
}

// Positive correlation in the accent colour, negative in red, strength as opacity.
function heat(c: number | null, diagonal: boolean): React.CSSProperties | undefined {
  if (c === null || diagonal) return { color: "var(--faint)" };
  const strength = Math.round(Math.min(1, Math.abs(c)) * 55);
  return { background: `color-mix(in srgb, ${c >= 0 ? "var(--accent)" : "var(--down)"} ${strength}%, transparent)` };
}
