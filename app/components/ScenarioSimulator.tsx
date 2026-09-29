"use client";

import { useMemo, useState } from "react";
import {
  FACTORS,
  SCENARIOS,
  applyScenario,
  factorOf,
  type ExposureRow,
  type FactorId,
} from "@/lib/risk/scenarios";

function pct(x: number | null, digits = 1): string {
  if (x === null) return "—";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
}

// "What happens if semiconductors fall 30%?" — answered with the same linear
// estimate the server would give, recomputed here as the shock is dragged.
export function ScenarioSimulator({ exposures }: { exposures: ExposureRow[] }) {
  const [factor, setFactor] = useState<FactorId>(SCENARIOS[1].factor);
  const [shock, setShock] = useState<number>(SCENARIOS[1].shock);
  const [preset, setPreset] = useState<string | null>(SCENARIOS[1].id);

  const result = useMemo(() => applyScenario(exposures, factor, shock), [exposures, factor, shock]);
  const note = SCENARIOS.find((s) => s.id === preset)?.note;
  const f = factorOf(factor);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Scenario simulator</h2>
        <span className="hint">each position moves by its measured 1-year sensitivity</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="filters">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              aria-pressed={preset === s.id}
              onClick={() => {
                setPreset(s.id);
                setFactor(s.factor);
                setShock(s.shock);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="field-row" style={{ alignItems: "end" }}>
          <label className="field">
            Factor
            <select
              value={factor}
              onChange={(e) => {
                setFactor(e.target.value as FactorId);
                setPreset(null);
              }}
            >
              {FACTORS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label} ({x.proxy})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Move in {f.proxy}: {pct(shock, 0)}
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={Math.round(shock * 100)}
              onChange={(e) => {
                setShock(Number(e.target.value) / 100);
                setPreset(null);
              }}
              style={{ padding: 0 }}
            />
          </label>
        </div>

        <div className="tiles">
          <div className="tile">
            <span className="label">Estimated portfolio move</span>
            <div className={`value ${result.impact >= 0 ? "up" : "down"}`}>{pct(result.impact)}</div>
            <div className="foot">
              {result.dollars === null
                ? "weights only — no position values"
                : `${result.dollars >= 0 ? "+" : "−"}$${Math.abs(result.dollars).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </div>
          </div>
          <div className="tile">
            <span className="label">How much {f.proxy} explains</span>
            <div className="value">{Math.round(result.explained * 100)}%</div>
            <div className="foot">
              {result.explained < 0.25 ? "weak link — treat the estimate loosely" : "of daily variance, weighted"}
            </div>
          </div>
        </div>
        {note && <p className="subtle">Modelled as {note}.</p>}
      </div>

      <div className="panel-scroll">
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Beta to {f.proxy}</th>
              <th>Its move</th>
              <th>Portfolio effect</th>
            </tr>
          </thead>
          <tbody>
            {result.positions.map((p) => (
              <tr key={p.ticker}>
                <td>
                  <span className="sym">{p.ticker}</span>
                </td>
                <td className="num">{p.beta === null ? "—" : p.beta.toFixed(2)}</td>
                <td className={`num ${p.move === null ? "" : p.move >= 0 ? "up" : "down"}`}>{pct(p.move)}</td>
                <td className={`num ${p.contribution === null ? "" : p.contribution >= 0 ? "up" : "down"}`}>
                  {pct(p.contribution, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle" style={{ padding: "0.7rem 0.9rem" }}>
        A linear estimate from one year of daily history, one factor at a time. Real shocks arrive with other things
        moving too, and sensitivities change under stress — this shows the direction and rough size, not a forecast.
        {result.unmeasured.length > 0 && ` Not measured against ${f.proxy}: ${result.unmeasured.join(", ")}.`}
      </p>
    </section>
  );
}
