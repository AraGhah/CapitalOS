import Decimal from "decimal.js";
import { getPortfolio } from "@/lib/holdings";
import { getPortfolioSeries } from "@/lib/timeseries";
import { ACCOUNT_ID } from "@/lib/constants";
import { BenchmarkChart } from "./BenchmarkChart";
import { listTheses } from "@/lib/theses";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [{ holdings, totalReturn }, series, theses] = await Promise.all([
    getPortfolio(ACCOUNT_ID),
    getPortfolioSeries(ACCOUNT_ID),
    listTheses(),
  ]);

  const live = theses.filter((t) => t.thesis.status !== "closed");
  const broken = live.filter((t) => t.thesis.status === "invalidated" || t.breached);

  const totalMarketValue = holdings.reduce((sum, h) => sum.add(h.marketValue), new Decimal(0));

  return (
    <div>
      <h1>Portfolio</h1>

      <div className="stat-row">
        <div className="stat">
          <span className="label">Total value</span>
          <span className="value">${totalMarketValue.toFixed(2)}</span>
        </div>
        <div className="stat">
          <span className="label">Total return</span>
          <span className={`value ${totalReturn.gte(0) ? "up" : "down"}`}>
            {totalReturn.mul(100).toFixed(2)}%
          </span>
        </div>
      </div>

      {broken.length > 0 && (
        <div className="alert">
          {broken.length === 1
            ? "1 thesis no longer holds"
            : `${broken.length} theses no longer hold`}
        </div>
      )}

      <BenchmarkChart data={series} />

      <h2 style={{ marginTop: "2rem" }}>Theses</h2>
      {live.length === 0 ? (
        <p className="missing">No open theses.</p>
      ) : (
        live.map(({ thesis, checks, breached, periodEnd }) => (
          <details key={thesis.id} open={breached}>
            <summary>
              <span className={breached ? "down" : undefined}>
                {thesis.ticker} — {breached ? "invalidated" : "holding"}
              </span>
            </summary>
            {thesis.rationale && <p className="subtle">{thesis.rationale}</p>}
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Latest{periodEnd ? ` (${periodEnd})` : ""}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: "left" }}>
                      {check.rule.metric} {check.rule.operator} {check.rule.value}
                    </td>
                    <td>{check.actual === null ? "—" : check.actual.toPrecision(4)}</td>
                    <td className={check.breached ? "down" : undefined}>
                      {check.actual === null ? "not checked" : check.breached ? "breached" : "holding"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}

      <table style={{ marginTop: "2rem" }}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Qty</th>
            <th>Avg cost</th>
            <th>Price</th>
            <th>Market value</th>
            <th>Weight</th>
            <th>Unrealized P/L</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.companyId}>
              <td style={{ textAlign: "left" }}>{h.ticker}</td>
              <td>{h.qty.toString()}</td>
              <td>${h.avgCost.toFixed(2)}</td>
              <td>${h.price.toFixed(2)}</td>
              <td>${h.marketValue.toFixed(2)}</td>
              <td>{h.weight.mul(100).toFixed(1)}%</td>
              <td className={h.unrealizedPL.gte(0) ? "up" : "down"}>${h.unrealizedPL.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {holdings.length === 0 && <p>No open positions yet — add a transaction to get started.</p>}
    </div>
  );
}
