"use client";

import { useState } from "react";
import type { BacktestResult, StrategySpec } from "@/lib/strategy/backtest";
import { EquityChart } from "./EquityChart";

interface MetricOption {
  key: string;
  label: string;
  unit: string;
}

function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined) return "—";
  return `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(digits)}%`;
}

const scaled = (unit: string) => unit === "ratio" || unit === "points";

export function BacktestLab({ presets, metrics }: { presets: StrategySpec[]; metrics: MetricOption[] }) {
  const [spec, setSpec] = useState<StrategySpec>(presets[0]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unitOf = (key: string) => metrics.find((m) => m.key === key)?.unit ?? "";

  const set = (patch: Partial<StrategySpec>) => setSpec((s) => ({ ...s, ...patch }));

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/strategy/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "the backtest failed");
      return;
    }
    setResult(body);
  }

  const s = result?.stats;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Strategy</h2>
          <span className="hint">a screen, a ranking and a calendar</span>
        </div>
        <div className="panel-body stack-sm">
          <div className="filters">
            {presets.map((p) => (
              <button key={p.name} type="button" className="chip" aria-pressed={spec.name === p.name} onClick={() => set(p)}>
                {p.name}
              </button>
            ))}
          </div>

          <div className="field">
            Hold companies where every rule holds
            {spec.rules.map((rule, i) => (
              <div key={i} className="rule-row">
                <select
                  value={rule.metric}
                  onChange={(e) =>
                    set({ name: "Custom strategy", rules: spec.rules.map((r, j) => (j === i ? { ...r, metric: e.target.value as typeof r.metric } : r)) })
                  }
                  aria-label="Metric"
                >
                  {metrics.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  value={rule.op}
                  onChange={(e) => set({ name: "Custom strategy", rules: spec.rules.map((r, j) => (j === i ? { ...r, op: e.target.value as typeof r.op } : r)) })}
                  aria-label="Comparison"
                >
                  {[">=", ">", "<=", "<"].map((op) => (
                    <option key={op}>{op}</option>
                  ))}
                </select>
                <input
                  type="number"
                  step="any"
                  value={scaled(unitOf(rule.metric)) ? Number((rule.value * 100).toFixed(4)) : rule.value}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const value = scaled(unitOf(rule.metric)) ? n / 100 : n;
                    set({ name: "Custom strategy", rules: spec.rules.map((r, j) => (j === i ? { ...r, value } : r)) });
                  }}
                  aria-label="Threshold"
                />
                <span className="subtle">{scaled(unitOf(rule.metric)) ? "%" : unitOf(rule.metric) === "multiple" ? "x" : unitOf(rule.metric) === "flag" ? "1 = yes" : ""}</span>
                <button type="button" className="linklike" onClick={() => set({ name: "Custom strategy", rules: spec.rules.filter((_, j) => j !== i) })}>
                  remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="chip"
                onClick={() => set({ name: "Custom strategy", rules: [...spec.rules, { metric: "revenue_growth", op: ">=", value: 0.1 }] })}
              >
                + rule
              </button>
            </div>
          </div>

          <div className="lab-grid">
            <label className="field">
              Rank by
              <select value={spec.rankBy} onChange={(e) => set({ name: "Custom strategy", rankBy: e.target.value as StrategySpec["rankBy"] })}>
                {metrics.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Order
              <select value={spec.rankDescending ? "desc" : "asc"} onChange={(e) => set({ name: "Custom strategy", rankDescending: e.target.value === "desc" })}>
                <option value="desc">highest first</option>
                <option value="asc">lowest first</option>
              </select>
            </label>
            <label className="field">
              Positions
              <input type="number" min={1} max={10} value={spec.maxPositions} onChange={(e) => set({ name: "Custom strategy", maxPositions: Number(e.target.value) })} />
            </label>
            <label className="field">
              Rebalance
              <select value={spec.rebalance} onChange={(e) => set({ name: "Custom strategy", rebalance: e.target.value as StrategySpec["rebalance"] })}>
                <option value="monthly">monthly</option>
                <option value="quarterly">quarterly</option>
                <option value="annual">yearly</option>
              </select>
            </label>
            <label className="field">
              Commission, bps
              <input type="number" min={0} max={200} value={spec.costBps} onChange={(e) => set({ costBps: Number(e.target.value) })} />
            </label>
            <label className="field">
              Slippage, bps
              <input type="number" min={0} max={200} value={spec.slippageBps} onChange={(e) => set({ slippageBps: Number(e.target.value) })} />
            </label>
            <label className="field">
              Years
              <input type="number" min={1} max={10} value={spec.years} onChange={(e) => set({ years: Number(e.target.value) })} />
            </label>
          </div>

          <div className="inline-actions">
            <button type="button" className="primary" onClick={run} disabled={busy}>
              {busy ? "Replaying…" : "Run backtest"}
            </button>
            <span className="subtle">Loads up to ten years of prices on the first run; later runs reuse them.</span>
          </div>
          {error && <p className="alert">{error}</p>}
        </div>
      </section>

      {result && s && (
        <>
          <div className="tiles four">
            <div className="tile">
              <span className="label">Total return</span>
              <div className={`value ${s.totalReturn >= 0 ? "up" : "down"}`}>{pct(s.totalReturn, 0)}</div>
              <div className="foot">SPY {pct(s.benchmarkReturn, 0)}</div>
            </div>
            <div className="tile">
              <span className="label">Annual return</span>
              <div className="value">{pct(s.cagr)}</div>
              <div className="foot">SPY {pct(s.benchmarkCagr)}</div>
            </div>
            <div className="tile">
              <span className="label">Max drawdown</span>
              <div className="value down">{pct(s.maxDrawdown)}</div>
              <div className="foot">SPY {pct(s.benchmarkDrawdown)}</div>
            </div>
            <div className="tile">
              <span className="label">Sharpe</span>
              <div className="value">{s.sharpe === null ? "—" : s.sharpe.toFixed(2)}</div>
              <div className="foot">vol {pct(s.vol)} vs SPY {pct(s.benchmarkVol)}</div>
            </div>
            <div className="tile">
              <span className="label">Win rate</span>
              <div className="value">{pct(s.winRate, 0)}</div>
              <div className="foot">{s.trades} trades</div>
            </div>
            <div className="tile">
              <span className="label">Invested</span>
              <div className="value">{pct(s.invested, 0)}</div>
              <div className="foot">of days; cash earns nothing</div>
            </div>
            <div className="tile">
              <span className="label">Turnover</span>
              <div className="value">{s.turnover.toFixed(1)}x</div>
              <div className="foot">per year</div>
            </div>
            <div className="tile">
              <span className="label">Cost drag</span>
              <div className="value">{pct(s.costDrag, 2)}</div>
              <div className="foot">per year, commission + slippage</div>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>Growth of $1</h2>
              <span className="hint">
                {result.start} to {result.end} · log scale
              </span>
            </div>
            <div className="panel-body">
              <EquityChart data={result.equity} />
            </div>
          </section>

          <div className="alert" style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.2rem", borderColor: "var(--warn)", color: "var(--warn)", background: "transparent" }}>
            {result.warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>

          <div className="three-up" style={{ gap: "1rem" }}>
            <section className="panel">
              <div className="panel-head">
                <h2>By year</h2>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Strategy</th>
                    <th>SPY</th>
                  </tr>
                </thead>
                <tbody>
                  {result.years.map((y) => (
                    <tr key={y.year}>
                      <td>{y.year}</td>
                      <td className={`num ${y.strategy >= 0 ? "up" : "down"}`}>{pct(y.strategy)}</td>
                      <td className="num">{pct(y.benchmark)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>By market regime</h2>
              </div>
              <div className="panel-body stack-sm">
                {result.regimes.map((g) => (
                  <div key={g.regime}>
                    <p>{g.regime}</p>
                    <p className="subtle">
                      {g.days} days · strategy <span className={g.strategy >= 0 ? "up" : "down"}>{pct(g.strategy)}</span> vs SPY {pct(g.benchmark)}
                    </p>
                  </div>
                ))}
                <p className="subtle">A strategy that only wins in bull markets is a leveraged bet on the market, not an edge.</p>
              </div>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>Rebalances</h2>
              <span className="hint">what the rules picked, and from how many that passed</span>
            </div>
            <div className="panel-scroll" style={{ maxHeight: "18rem", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="wide">Held</th>
                    <th>Passed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.rebalances].reverse().map((r) => (
                    <tr key={r.date}>
                      <td className="num">{r.date}</td>
                      <td className="wide">{r.holdings.length ? r.holdings.join(", ") : <span className="subtle">cash — nothing passed</span>}</td>
                      <td className="num">{r.candidates}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Trades</h2>
              <span className="hint">entry to exit; open positions marked at the last close</span>
            </div>
            <div className="panel-scroll" style={{ maxHeight: "18rem", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Entered</th>
                    <th>Exited</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.trades].reverse().map((t, i) => (
                    <tr key={i}>
                      <td>
                        <span className="sym">{t.ticker}</span>
                      </td>
                      <td className="num">{t.entered}</td>
                      <td className="num">{t.exited ?? "open"}</td>
                      <td className={`num ${t.return >= 0 ? "up" : "down"}`}>{pct(t.return)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
