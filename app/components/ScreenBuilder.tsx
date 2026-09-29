"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface MetricOption {
  key: string;
  label: string;
  unit: string;
}

interface Rule {
  metric: string;
  op: string;
  value: string;
}

// Ratios are typed as percentages, the way people think of them, and stored as
// decimals, the way the scanner compares them.
function toStored(unit: string, value: string): number {
  const n = Number(value);
  return unit === "ratio" || unit === "points" ? n / 100 : n;
}

function toShown(unit: string, value: number): string {
  return String(unit === "ratio" || unit === "points" ? Number((value * 100).toFixed(4)) : value);
}

export function ScreenBuilder({ metrics, initial }: { metrics: MetricOption[]; initial: Array<{ metric: string; op: string; value: number }> }) {
  const router = useRouter();
  const unitOf = (key: string) => metrics.find((m) => m.key === key)?.unit ?? "";
  const [rules, setRules] = useState<Rule[]>(
    initial.length > 0
      ? initial.map((r) => ({ metric: r.metric, op: r.op, value: toShown(unitOf(r.metric), r.value) }))
      : [{ metric: "revenue_growth", op: ">=", value: "20" }]
  );

  function update(i: number, patch: Partial<Rule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function run() {
    const text = rules
      .filter((r) => r.value.trim() !== "" && Number.isFinite(Number(r.value)))
      .map((r) => `${r.metric}${r.op}${toStored(unitOf(r.metric), r.value)}`)
      .join(";");
    router.push(text ? `/scanner?rules=${encodeURIComponent(text)}` : "/scanner");
  }

  return (
    <div className="panel-body stack-sm">
      {rules.map((rule, i) => {
        const unit = unitOf(rule.metric);
        return (
          <div key={i} className="rule-row">
            <select value={rule.metric} onChange={(e) => update(i, { metric: e.target.value })} aria-label="Metric">
              {metrics.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            <select value={rule.op} onChange={(e) => update(i, { op: e.target.value })} aria-label="Comparison">
              {[">=", ">", "<=", "<"].map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              value={rule.value}
              onChange={(e) => update(i, { value: e.target.value })}
              inputMode="decimal"
              aria-label="Threshold"
            />
            <span className="subtle">{unit === "ratio" ? "%" : unit === "points" ? "pts" : unit === "multiple" ? "x" : unit === "flag" ? "1 = yes" : ""}</span>
            <button type="button" className="linklike" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove rule">
              remove
            </button>
          </div>
        );
      })}
      <div className="inline-actions">
        <button type="button" className="chip" onClick={() => setRules((rs) => [...rs, { metric: "fcf_margin", op: ">=", value: "10" }])}>
          + rule
        </button>
        <button type="button" className="primary" onClick={run}>
          Run screen
        </button>
        {initial.length > 0 && (
          <button type="button" className="linklike" onClick={() => router.push("/scanner")}>
            clear
          </button>
        )}
      </div>
    </div>
  );
}
