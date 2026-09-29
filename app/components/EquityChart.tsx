"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Growth of one dollar, strategy against SPY, on a log scale so a 50% fall
// early on looks as large as a 50% fall late — which it was.
export function EquityChart({ data }: { data: Array<{ date: string; strategy: number; benchmark: number }> }) {
  // One point a week is plenty for a multi-year line and keeps the chart quick.
  const thinned = data.filter((_, i) => i % 5 === 0 || i === data.length - 1);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={thinned} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--faint)" }} stroke="var(--border)" minTickGap={60} />
        <YAxis
          scale="log"
          domain={["auto", "auto"]}
          tick={{ fontSize: 11, fill: "var(--faint)" }}
          stroke="var(--border)"
          width={56}
          tickFormatter={(v: number) => `$${v.toFixed(v < 10 ? 2 : 0)}`}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
            boxShadow: "var(--shadow-lift)",
          }}
          labelStyle={{ color: "var(--muted)" }}
          itemStyle={{ color: "var(--text)" }}
          formatter={(value) => (typeof value === "number" ? `$${value.toFixed(2)}` : String(value))}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} iconType="plainline" />
        <Line type="monotone" dataKey="strategy" name="Strategy" stroke="var(--accent)" strokeWidth={2} dot={false} />
        <Line
          type="monotone"
          dataKey="benchmark"
          name="SPY"
          stroke="var(--faint)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
