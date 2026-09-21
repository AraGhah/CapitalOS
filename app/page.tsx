import Decimal from "decimal.js";
import { getPortfolio } from "@/lib/holdings";
import { getPortfolioSeries } from "@/lib/timeseries";
import { ACCOUNT_ID } from "@/lib/constants";
import { BenchmarkChart } from "./BenchmarkChart";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [{ holdings, totalReturn }, series] = await Promise.all([
    getPortfolio(ACCOUNT_ID),
    getPortfolioSeries(ACCOUNT_ID),
  ]);

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

      <BenchmarkChart data={series} />

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
