import { marketOverview, type AssetRow, type Stance } from "@/lib/market/overview";
import { availableModels } from "@/lib/ai/models";
import { MarketBrief } from "@/app/components/MarketBrief";

export const dynamic = "force-dynamic";

const STANCE_TONE: Record<Stance, string> = { on: "good", off: "bad", neutral: "" };
const STANCE_WORD: Record<Stance, string> = { on: "risk-on", off: "risk-off", neutral: "neutral" };

function pct(x: number | null, digits = 1): string {
  if (x === null) return "—";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
}

function tone(x: number | null): string {
  return x === null ? "" : x >= 0 ? "up" : "down";
}

export default async function MarketsPage() {
  const o = await marketOverview();
  const groups = [...new Set(o.assets.map((a) => a.group))];

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Markets · overview, regime and macro</p>
          <h1>Market Overview</h1>
        </div>
        {o.asOf && <span className="subtle">closes to {o.asOf}</span>}
      </div>

      {o.missing.length > 0 && (
        <p className="alert" style={{ marginBottom: "1rem" }}>
          No prices could be loaded for {o.missing.join(", ")}.
        </p>
      )}

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <div className="panel-head">
          <h2>
            Market regime:{" "}
            <span className={o.regime.label === "Risk-on" ? "up" : o.regime.label === "Risk-off" ? "down" : ""}>
              {o.regime.label}
            </span>
          </h2>
          <span className="hint">
            {o.regime.on} risk-on · {o.regime.off} risk-off · {o.regime.neutral} neutral — fixed rules, no model
          </span>
        </div>
        <div className="signal-grid">
          {o.signals.map((s) => (
            <div key={s.id} className="signal">
              <span className="label">{s.name}</span>
              <div className="reading">{s.reading}</div>
              <span className={`pill ${STANCE_TONE[s.stance]}`.trim()}>{STANCE_WORD[s.stance]}</span>
              <p className="subtle">{s.basis}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="split">
        <div className="stack">
          <MarketBrief hasModel={availableModels().length > 0} />

          {groups.map((group) => (
            <section className="panel" key={group}>
              <div className="panel-head">
                <h2>{group}</h2>
                {group === "Sectors" && <span className="hint">sorted by 3-month return</span>}
              </div>
              <div className="panel-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Last</th>
                      <th>Day</th>
                      <th>1 month</th>
                      <th>3 months</th>
                      <th>YTD</th>
                      <th>1 year</th>
                      <th>From high</th>
                      <th>200-day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(o.assets.filter((a) => a.group === group), group).map((a) => (
                      <tr key={a.symbol}>
                        <td>
                          {a.label} <span className="subtle num">{a.symbol}</span>
                        </td>
                        {a.m ? (
                          <>
                            <td className="num">{a.m.last.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                            <td className={`num ${tone(a.m.day)}`}>{pct(a.m.day, 2)}</td>
                            <td className={`num ${tone(a.m.month)}`}>{pct(a.m.month)}</td>
                            <td className={`num ${tone(a.m.quarter)}`}>{pct(a.m.quarter)}</td>
                            <td className={`num ${tone(a.m.ytd)}`}>{pct(a.m.ytd)}</td>
                            <td className={`num ${tone(a.m.year)}`}>{pct(a.m.year)}</td>
                            {/* A volatility index's distance from its high and trend are not
                                what they mean for a price, so they are left blank. */}
                            <td className="num">{a.symbol === "^VIX" ? "—" : pct(a.m.belowHigh)}</td>
                            <td>
                              {a.m.aboveSma200 === null || a.symbol === "^VIX" ? (
                                <span className="subtle">—</span>
                              ) : (
                                <span className={`pill ${a.m.aboveSma200 ? "good" : "bad"}`}>{a.m.aboveSma200 ? "above" : "below"}</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <td colSpan={8} className="missing">
                            unavailable
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Macro</h2>
              <span className="hint">FRED, stored</span>
            </div>
            {o.macro.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No macro series stored — run <code>npm run ingest-fred</code>.
              </p>
            ) : (
              <ul className="rail">
                {o.macro.map((m) => {
                  const show = (v: number) => (m.unit === "ratio" ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(2)}%`);
                  const delta = m.yearAgo === null ? null : m.latest - m.yearAgo;
                  return (
                    <li key={m.id} title={`as of ${m.asOf}`}>
                      <span className="feed-name">{m.label}</span>
                      <span className="count">{show(m.latest)}</span>
                      {delta !== null && (
                        <span className="subtle num" style={{ fontSize: "0.7rem" }}>
                          {delta >= 0 ? "+" : "−"}
                          {m.unit === "ratio" ? (Math.abs(delta) * 100).toFixed(1) : Math.abs(delta).toFixed(2)} y/y
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>How the regime is read</h2>
            </div>
            <div className="panel-body stack-sm subtle">
              <p>
                Each signal is one rule over computed figures: trend against the 200-day average, relative 3-month
                performance, the VIX level, credit, breadth across the eleven sectors, the Fed funds path and the yield
                curve. The regime is risk-on or risk-off when one side leads by two signals or more.
              </p>
              <p>ETFs stand in for what they track. Prices are Yahoo daily closes; macro is FRED.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function sortRows(rows: AssetRow[], group: string): AssetRow[] {
  if (group !== "Sectors") return rows;
  return [...rows].sort((a, b) => (b.m?.quarter ?? -Infinity) - (a.m?.quarter ?? -Infinity));
}
