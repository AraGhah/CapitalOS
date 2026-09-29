import Link from "next/link";
import { paperPortfolio } from "@/lib/paper";
import { money } from "@/lib/format";
import { PaperOrder } from "@/app/components/PaperOrder";

export const dynamic = "force-dynamic";

function pct(x: number | null, digits = 2): string {
  if (x === null) return "—";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
}

export default async function PaperPage() {
  let portfolio;
  try {
    portfolio = await paperPortfolio();
  } catch {
    return (
      <div>
        <div className="page-head">
          <div>
            <p className="eyebrow">Strategies · simulated money</p>
            <h1>Paper Trading</h1>
          </div>
        </div>
        <p className="alert">
          The paper-trading table is not set up yet — run <code>npm run migrate-lab</code>.
        </p>
      </div>
    );
  }
  const p = portfolio;
  const vs = p.benchmarkReturn === null ? null : p.totalReturn - p.benchmarkReturn;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Strategies · simulated money, live prices</p>
          <h1>Paper Trading</h1>
        </div>
        <span className="subtle">kept apart from the real ledger</span>
      </div>

      <div className="tiles four" style={{ marginBottom: "1rem" }}>
        <div className="tile">
          <span className="label">Paper portfolio</span>
          <div className="value">{money(p.value)}</div>
          <div className="foot">started with {money(p.startingCapital)}</div>
        </div>
        <div className="tile">
          <span className="label">Return</span>
          <div className={`value ${p.totalReturn >= 0 ? "up" : "down"}`}>{pct(p.totalReturn)}</div>
          <div className="foot">marked at live prices</div>
        </div>
        <div className="tile">
          <span className="label">Same dollars in SPY</span>
          <div className="value">{p.benchmarkReturn === null ? "—" : pct(p.benchmarkReturn)}</div>
          <div className="foot">
            {vs === null
              ? "no trades yet"
              : Math.abs(vs) < 0.00005
                ? "level with SPY"
                : `${vs > 0 ? "ahead" : "behind"} by ${pct(Math.abs(vs)).slice(1)}`}
          </div>
        </div>
        <div className="tile">
          <span className="label">Cash</span>
          <div className="value">{money(p.cash)}</div>
          <div className="foot">{p.value > 0 ? `${Math.round((p.cash / p.value) * 100)}% of the portfolio` : ""}</div>
        </div>
      </div>

      {p.priceErrors.length > 0 && (
        <p className="alert" style={{ marginBottom: "1rem" }}>
          No live price for {p.priceErrors.join(", ")} — marked at cost.
        </p>
      )}

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Place an order</h2>
              <span className="hint">filled at the live price, $1 commission</span>
            </div>
            <div className="panel-body">
              <PaperOrder />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Positions</h2>
            </div>
            {p.positions.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No paper positions. Place an order above, or paper-trade a committee&apos;s conclusion from its report.
              </p>
            ) : (
              <div className="panel-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Qty</th>
                      <th>Avg cost</th>
                      <th>Last</th>
                      <th>Value</th>
                      <th>Weight</th>
                      <th>Unrealized</th>
                      <th>Realized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.positions.map((pos) => (
                      <tr key={pos.ticker}>
                        <td>
                          <Link href={`/research/${pos.ticker}`} className="sym">
                            {pos.ticker}
                          </Link>
                        </td>
                        <td className="num">{pos.qty.toFixed(4)}</td>
                        <td className="num">{pos.avgCost.toFixed(2)}</td>
                        <td className="num">{pos.price === null ? "—" : pos.price.toFixed(2)}</td>
                        <td className="num">{money(pos.value)}</td>
                        <td className="num">{(pos.weight * 100).toFixed(1)}%</td>
                        <td className={`num ${pos.unrealized >= 0 ? "up" : "down"}`}>{money(pos.unrealized)}</td>
                        <td className={`num ${pos.realized >= 0 ? "up" : "down"}`}>{money(pos.realized)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>AI hypotheses on paper</h2>
              <span className="hint">each committee conclusion traded, scored against SPY since the same moment</span>
            </div>
            {p.hypotheses.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                None yet. A committee report has a paper-trade button; its result is tracked here.
              </p>
            ) : (
              <div className="panel-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="wide">Conclusion tested</th>
                      <th>Entered</th>
                      <th>Return</th>
                      <th>SPY since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.hypotheses.map((h) => (
                      <tr key={h.tradeId}>
                        <td>
                          <span className="sym">{h.ticker}</span>
                        </td>
                        <td className="wide">
                          <Link href={`/committee/${h.runId}`}>{h.rationale ?? "committee report"}</Link>
                        </td>
                        <td className="num">{h.enteredAt.slice(0, 10)}</td>
                        <td className={`num ${h.return !== null && h.return >= 0 ? "up" : "down"}`}>{pct(h.return)}</td>
                        <td className="num">{pct(h.spyReturn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Trade history</h2>
            </div>
            {p.trades.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No trades.
              </p>
            ) : (
              <ul className="rail">
                {p.trades.map((t) => (
                  <li key={t.id} title={t.rationale ?? undefined}>
                    <span className={`pill ${t.side === "buy" ? "good" : "bad"}`}>{t.side}</span>
                    <span className="feed-name">
                      <span className="num">{t.ticker}</span> {t.qty.toFixed(3)} @ {t.price.toFixed(2)}
                    </span>
                    <span className="count">{t.createdAt.slice(5, 10)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Why paper first</h2>
            </div>
            <div className="panel-body subtle">
              <p>
                A backtest shows how rules would have done; paper shows how the desk&apos;s live conclusions do, on
                prices nobody could have seen in advance. Compare against the same dollars in SPY, not against zero.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
